import assert from 'node:assert/strict';
import test from 'node:test';
import { Sandbox } from 'e2b';
import { parsePlan, parseRegistry } from '../src/entitlements/schema.ts';
import type { ConfigurationStore } from '../src/entitlements/store.ts';
import type { UserEntitlements } from '../src/entitlements/service.ts';
import { MeteringService, type Reservation } from '../src/metering/service.ts';
import { E2BAdapter } from '../src/sandboxes/e2b.ts';
import type { RunningSandbox, SandboxAdapter } from '../src/sandboxes/provider.ts';
import { SandboxService } from '../src/sandboxes/service.ts';
import { planDocuments, registryDocument } from '../src/seed/config.ts';
import { ledger } from './support/ledger.ts';

function fixture() {
  const { db, data } = ledger();
  const registry = parseRegistry(registryDocument, 'registry');
  const plans = new Map(planDocuments.map((doc) => [doc.key, parsePlan(doc, doc.key, registry)]));
  const plan = plans.get('business')!;
  const provider = registry.sandboxProviders.get('web')!;
  const configuration = { get: async () => ({ registry, plans }) } as unknown as ConfigurationStore;
  const entitlements = { planKey: plan.key, planName: plan.name, meterLimits: plan.meterLimits } as UserEntitlements;
  const metering = new MeteringService(db, configuration);
  const holds: Reservation[] = [];
  const stopped: string[] = [];
  let alive = false;
  const running = {
    externalId: 'vm-1',
    lifetime: async () => ({ startedAt: new Date(Date.now() - 1000), endAt: new Date(Date.now() + 59000) }),
    stop: async () => { alive = false; stopped.push('vm-1'); },
  } as RunningSandbox;
  const adapter: SandboxAdapter = {
    start: async (_provider, context) => {
      await context.lifecycle?.beforeCreate();
      alive = true;
      await context.lifecycle?.created(running);
      return running;
    },
    terminate: async (id) => { stopped.push(id); const existed = alive; alive = false; return existed; },
    connect: async () => { throw new Error('Recovery must not resume a VM'); },
  };
  const service = (meter = metering, selected = adapter) => new SandboxService(configuration, meter, new Map([['e2b', selected]]));
  const input = { uid: 'u', entitlements, platform: 'web' as const, sessionId: 's', now: new Date(),
    reservations: { take: async (hold: { meterKey: string; quantity: number; operationId: string }) => {
      const reservation = await metering.reserve({ ...hold, uid: 'u', entitlements, now: new Date() });
      holds.push(reservation); return reservation;
    } } };
  const record = (hold: Reservation) => data.get(`users/u/reservations/${hold.id}`)!;
  const reserved = (meter: string) => data.get(`users/u/usage/${meter}`)?.['reserved'];
  const recovery = () => ({ uid: 'u', platform: 'web' as const, externalSandboxId: undefined,
    reservationIds: holds.map((hold) => hold.id), now: new Date(), onProblem: () => {} });
  return { db, data, configuration, metering, provider, registry, holds, stopped, running, adapter, service,
    input, record, reserved, recovery, restarted: () => service(new MeteringService(db, configuration)) };
}

test('failure before provider dispatch releases all holds, including a partially acquired pair', async () => {
  const h = fixture();
  h.adapter.start = async () => { throw new Error('Local pre-create validation failed'); };
  await assert.rejects(h.service().acquire(h.input), /Local pre-create/);
  assert.ok(h.holds.every((hold) => h.record(hold)['status'] === 'RELEASED' && h.record(hold)['inFlight'] === false));
  assert.equal(h.stopped.length, 0);
  const partial = fixture();
  await assert.rejects(partial.service().acquire({ ...partial.input, reservations: { take: async (input) => {
    if (partial.holds.length) throw new Error('Runtime quota denied');
    return partial.input.reservations.take(input);
  } } }), /Runtime quota denied/);
  assert.equal(partial.record(partial.holds[0]!)['status'], 'RELEASED');
  assert.equal(partial.reserved(partial.provider.concurrencyMeterKey), 0);
});

test('lost mark-in-flight acknowledgement before dispatch does not strand capacity', async (t) => {
  const h = fixture();
  const mark = h.metering.markInFlight.bind(h.metering);
  t.mock.method(h.metering, 'markInFlight', async (...args: Parameters<typeof mark>) => {
    await mark(...args); throw new Error('Commit acknowledgement lost');
  });
  await assert.rejects(h.service().acquire(h.input), /acknowledgement lost/);
  assert.equal(h.stopped.length, 0);
  assert.ok(h.holds.every((hold) => h.record(hold)['status'] === 'RELEASED'));
});

test('unknown provider create outcome retains in-flight reservations without inventing an ID', async () => {
  const h = fixture();
  h.adapter.start = async (_provider, context) => {
    await context.lifecycle?.beforeCreate(); throw new Error('Create response lost');
  };
  await assert.rejects(h.service().acquire(h.input), /creation outcome unknown/);
  await assert.rejects(h.restarted().recover(h.recovery()), /Recovery remains incomplete/);
  assert.ok(h.holds.every((hold) => h.record(hold)['status'] === 'OPEN' && h.record(hold)['inFlight'] === true));
  assert.ok(h.holds.every((hold) => h.record(hold)['sandboxExternalId'] === undefined));
});

test('real E2B preparation failure records identity before mkdir and frees confirmed-stopped concurrency', async (t) => {
  const h = fixture();
  t.mock.method(Sandbox, 'create', async () => ({ sandboxId: 'vm-1', commands: { run: async () => {
    assert.ok(h.holds.every((hold) => h.record(hold)['sandboxExternalId'] === 'vm-1'));
    throw new Error('mkdir failed');
  } } }));
  const kill = t.mock.method(Sandbox, 'kill', async (id: string, options: { debug: boolean }) => {
    assert.equal(id, 'vm-1'); assert.equal(options.debug, false); return true;
  });
  await assert.rejects(h.service(h.metering, new E2BAdapter('fixture', 'example.test', false, 4096)).acquire(h.input), /Termination confirmed; reconciliation deferred/);
  assert.equal(kill.mock.callCount(), 1);
  const [gauge, runtime] = h.holds;
  assert.equal(h.record(gauge!)['status'], 'RELEASED');
  assert.equal(h.record(gauge!)['inFlight'], false);
  assert.equal(h.reserved(h.provider.concurrencyMeterKey), 0);
  assert.equal(h.record(runtime!)['status'], 'OPEN');
  assert.equal(h.record(runtime!)['inFlight'], true);
  assert.equal(h.record(runtime!)['observedQuantity'], undefined);
  assert.ok(h.holds.every((hold) => h.record(hold)['sandboxStopped'] === true));
});

for (const failure of ['lifetime', 'registration', 'early-identity']) {
  test(`post-create ${failure} failure retains identity and reconciles concurrency`, async (t) => {
    const h = fixture();
    if (failure === 'lifetime') h.running.lifetime = async () => { throw new Error('Lifetime unavailable'); };
    else {
      const record = h.metering.recordSandbox.bind(h.metering);
      let failed = false;
      t.mock.method(h.metering, 'recordSandbox', async (...args: Parameters<typeof record>) => {
        if (!failed && (failure === 'early-identity' || args[2].startedAt !== undefined)) {
          failed = true; throw new Error('Registration unavailable');
        }
        return record(...args);
      });
    }
    await assert.rejects(h.service().acquire(h.input));
    assert.deepEqual(h.stopped, ['vm-1']);
    assert.equal(h.reserved(h.provider.concurrencyMeterKey), 0);
    assert.ok(h.holds.every((hold) => h.record(hold)['sandboxExternalId'] === 'vm-1' && h.record(hold)['sandboxStopped'] === true));
    h.adapter.terminate = async () => { throw new Error('Already confirmed: provider must not be called again'); };
    await assert.rejects(h.restarted().recover(h.recovery())); // Unknown runtime still requires evidence.
    await h.metering.recordObservedUsage('u', h.holds[1]!.id, 4, 'provider-usage-fixture');
    await h.restarted().recover(h.recovery());
    await h.restarted().recover(h.recovery());
    assert.equal(h.record(h.holds[1]!)['settledQuantity'], 4);
    assert.equal(h.reserved(h.registry.sandboxTimeMeterKey), 0);
  });
}

for (const outcome of ['failure', 'network-unknown', 'invalid-result']) {
  test(`${outcome} termination retains capacity until a successor confirms absence`, async () => {
    const h = fixture();
    h.running.lifetime = async () => { throw new Error('Preparation failed'); };
    h.adapter.terminate = async () => {
      if (outcome === 'invalid-result') return undefined as never;
      throw new Error(outcome);
    };
    await assert.rejects(h.service().acquire(h.input), /Termination uncertain/);
    assert.ok(h.holds.every((hold) => h.record(hold)['sandboxExternalId'] === 'vm-1'
      && h.record(hold)['status'] === 'OPEN' && h.record(hold)['inFlight'] === true && h.record(hold)['sandboxStopped'] === undefined));
    assert.equal(h.reserved(h.provider.concurrencyMeterKey), 1);
    h.adapter.terminate = async () => false;
    await assert.rejects(h.restarted().recover(h.recovery()), /Recovery remains incomplete/);
    assert.equal(h.reserved(h.provider.concurrencyMeterKey), 0);
    assert.equal(h.record(h.holds[1]!)['observedQuantity'], undefined);
  });
}

test('process loss after stop but before evidence commit recovers by durable ID without resuming', async (t) => {
  const h = fixture();
  const acquired = await h.service().acquire(h.input);
  t.mock.method(h.metering, 'confirmSandboxStopped', async () => { throw new Error('Process lost before evidence commit'); });
  await assert.rejects(h.service().release({ uid: 'u', acquired, now: new Date(), onStopFailure: () => {} }), /Termination confirmed; reconciliation deferred/);
  assert.equal(h.reserved(h.provider.concurrencyMeterKey), 1);
  await assert.rejects(h.restarted().recover(h.recovery()), /Recovery remains incomplete/);
  assert.equal(h.reserved(h.provider.concurrencyMeterKey), 0);
  assert.equal(h.record(h.holds[1]!)['sandboxStopped'], true);
  assert.equal(h.record(h.holds[1]!)['observedQuantity'], undefined); // Absence does not supply historical billing time.
  assert.deepEqual(h.stopped, ['vm-1', 'vm-1']);
});

test('failed early identity write is retried even when termination is uncertain', async (t) => {
  const h = fixture();
  const record = h.metering.recordSandbox.bind(h.metering);
  let attempts = 0;
  t.mock.method(h.metering, 'recordSandbox', async (...args: Parameters<typeof record>) => {
    if (++attempts === 1) throw new Error('Transient identity write failure');
    return record(...args);
  });
  h.adapter.terminate = async () => { throw new Error('Provider offline'); };
  await assert.rejects(h.service().acquire(h.input), /Termination uncertain/);
  assert.ok(h.holds.every((hold) => h.record(hold)['sandboxExternalId'] === 'vm-1' && h.record(hold)['inFlight'] === true));
  h.adapter.terminate = async () => false;
  await assert.rejects(h.restarted().recover(h.recovery()));
  assert.equal(h.reserved(h.provider.concurrencyMeterKey), 0);
  await assert.rejects(h.metering.markInFlight('u', [h.holds[1]!.id]));
});

test('lost lifetime-registration acknowledgement preserves committed usage and confirms complete cleanup', async (t) => {
  const h = fixture();
  const record = h.metering.recordSandbox.bind(h.metering);
  t.mock.method(h.metering, 'recordSandbox', async (...args: Parameters<typeof record>) => {
    await record(...args);
    if (args[2].startedAt !== undefined) throw new Error('Registration acknowledgement lost');
  });
  await assert.rejects(h.service().acquire(h.input), /termination confirmed; reservations reconciled/);
  assert.equal(h.reserved(h.provider.concurrencyMeterKey), 0);
  assert.equal(h.reserved(h.registry.sandboxTimeMeterKey), 0);
  const charged = h.record(h.holds[1]!)['settledQuantity'];
  await h.restarted().recover(h.recovery());
  assert.equal(h.record(h.holds[1]!)['settledQuantity'], charged);
});

test('durable stop evidence survives process loss before settlement and duplicate recovery releases once', async (t) => {
  const h = fixture();
  const acquired = await h.service().acquire(h.input);
  t.mock.method(h.metering, 'reconcile', async () => { throw new Error('Process lost before settlement'); });
  await assert.rejects(h.service().release({ uid: 'u', acquired, now: new Date(), onStopFailure: () => {} }), /Termination confirmed; reconciliation deferred/);
  const observed = h.record(h.holds[1]!)['observedQuantity'];
  assert.equal(typeof observed, 'number');
  h.adapter.terminate = async () => { throw new Error('Durable stop must suffice without provider access'); };
  await Promise.all([h.restarted().recover(h.recovery()), h.restarted().recover(h.recovery())]);
  await h.restarted().recover(h.recovery());
  assert.equal(h.reserved(h.provider.concurrencyMeterKey), 0);
  assert.equal(h.reserved(h.registry.sandboxTimeMeterKey), 0);
  assert.equal(h.data.get(`users/u/usage/${h.registry.sandboxTimeMeterKey}`)?.['consumed'], observed);
});

test('successful acquisition and ordinary recovery settle the existing lifetime accounting', async () => {
  const h = fixture();
  const acquired = await h.service().acquire(h.input);
  assert.equal(acquired.running, h.running);
  assert.equal(acquired.provider, h.provider);
  assert.ok(h.holds.every((hold) => h.record(hold)['sandboxStartedAt'] !== undefined && h.record(hold)['inFlight'] === true));
  await h.restarted().recover(h.recovery());
  const consumed = h.data.get(`users/u/usage/${h.registry.sandboxTimeMeterKey}`)?.['consumed'];
  assert.ok(typeof consumed === 'number' && consumed >= 1);
  await h.restarted().recover(h.recovery());
  assert.equal(h.data.get(`users/u/usage/${h.registry.sandboxTimeMeterKey}`)?.['consumed'], consumed);
  assert.equal(h.reserved(h.provider.concurrencyMeterKey), 0);
});

test('stale cleanup cannot rebind or release newer sandbox reservations', async () => {
  const h = fixture();
  const old = await h.service().acquire(h.input);
  const newer = await h.input.reservations.take({ meterKey: h.provider.concurrencyMeterKey, quantity: 1, operationId: 'new-session' });
  await h.metering.markInFlight('u', [newer.id]);
  await h.metering.recordSandbox('u', [newer.id], { externalId: 'vm-new', platform: 'web' });
  await assert.rejects(h.metering.recordSandbox('u', [newer.id], { externalId: 'vm-1', platform: 'web' }), /identity cannot change/);
  await assert.rejects(h.metering.confirmSandboxStopped('u', [newer.id], 'vm-1', new Date()), /another sandbox/);
  await assert.rejects(h.metering.confirmSandboxNotCreated('u', [newer.id]), /resource evidence/);
  await h.service().release({ uid: 'u', acquired: old, now: new Date(), onStopFailure: () => {} });
  await h.service().release({ uid: 'u', acquired: old, now: new Date(), onStopFailure: () => {} });
  assert.equal(h.reserved(h.provider.concurrencyMeterKey), 1);
  assert.equal(h.record(newer)['status'], 'OPEN');
  assert.equal(h.record(newer)['inFlight'], true);
  await assert.rejects(h.metering.recordSandbox('u', [old.reservations[0]!.id], { externalId: 'vm-new', platform: 'web' }), /not open/);
});

test('validation child identity is durable before its network preparation fails', async (t) => {
  const h = fixture();
  t.mock.method(Sandbox, 'create', async () => ({ sandboxId: 'parent', commands: { run: async () => ({}) },
    updateNetwork: async () => {}, fork: async () => [{ sandboxId: 'child', updateNetwork: async () => {
      assert.ok(h.holds.every((hold) => h.record(hold)['sandboxExternalId'] === 'child'));
      throw new Error('Child network preparation failed');
    } }] }));
  const killed: string[] = [];
  t.mock.method(Sandbox, 'kill', async (id: string) => { killed.push(id); return true; });
  const adapter = new E2BAdapter('fixture', 'example.test', false, 4096);
  const source = await adapter.start(h.provider, { metadata: {}, networkPolicy: { mode: 'unrestricted' } });
  await assert.rejects(h.service(h.metering, adapter).acquire({ ...h.input, source }), /Termination confirmed; reconciliation deferred/);
  assert.deepEqual(killed, ['child']);
  assert.equal(h.reserved(h.provider.concurrencyMeterKey), 0);
});
