import assert from 'node:assert/strict';
import { fixtureModels } from './support/models.ts';
import { inspect } from 'node:util';
import test from 'node:test';
import { Sandbox, SandboxNotFoundError } from 'e2b';
import type Anthropic from '@anthropic-ai/sdk';
import { E2BAdapter } from '../src/sandboxes/e2b.ts';
import { SandboxService } from '../src/sandboxes/service.ts';
import type { RunningSandbox, SandboxAdapter } from '../src/sandboxes/provider.ts';
import { parseRegistry, parsePlan } from '../src/entitlements/schema.ts';
import { ResolvedEntitlements, type UserEntitlements } from '../src/entitlements/service.ts';
import { registryDocument, planDocuments } from '../src/seed/config.ts';
import { MeteringService } from '../src/metering/service.ts';
import type { ConfigurationStore } from '../src/entitlements/store.ts';
import { SessionRunner, RunnerWorkError, runUntilStopped, withDrainDeadline, type RunnerDependencies } from '../src/runner/loop.ts';
import { ledger } from './support/ledger.ts';
import { runTool, workspaceTools, type ToolContext } from '../src/runner/tools.ts';

const registry = parseRegistry(registryDocument, 'registry');
const provider = registry.sandboxProviders.get('web')!;
const log = { info: () => {}, warn: () => {}, error: () => {} };

test('E2B salvage reconnect preserves lifetime and quiesces provider-enumerated commands', async (t) => {
  const info = { state: 'running', startedAt: new Date(), endAt: new Date(Date.now() + 60000) };
  let pids = [12, 13]; const stopped: number[] = [];
  t.mock.method(Sandbox, 'getInfo', async () => info);
  t.mock.method(Sandbox, 'connect', async (_id: string, options: { timeoutMs: number; debug: boolean }) => {
    assert.equal(options.timeoutMs, 1000); assert.equal(options.debug, false);
    return { sandboxId: 'preserved', getInfo: async () => info, commands: {
      list: async () => pids.map((pid) => ({ pid })),
      kill: async (pid: number) => { stopped.push(pid); pids = pids.filter((value) => value !== pid); return true; },
    } };
  });
  const running = await new E2BAdapter('fixture', 'example.test', false, 4096).connect('preserved');
  await running!.stopCommands!(); assert.deepEqual(stopped, [12, 13]);
});

test('E2B absence is distinct from refused or uncertain reconnection', async (t) => {
  const adapter = new E2BAdapter('fixture', 'example.test', false, 4096);
  const getter = t.mock.method(Sandbox, 'getInfo', async () => { throw new SandboxNotFoundError('absent'); });
  assert.equal(await adapter.connect('preserved'), undefined);
  getter.mock.mockImplementation(async () => { throw new Error('private provider detail'); });
  await assert.rejects(adapter.connect('preserved'), /reconnection is unconfirmed/);
});

for (const failure of ['paused', 'lifetime-changed', 'quiescence-unknown']) {
  test(`E2B ${failure} cannot silently proceed with salvage`, async (t) => {
    const info = { state: failure === 'paused' ? 'paused' : 'running', startedAt: new Date(), endAt: new Date(Date.now() + 60000) };
    let connections = 0;
    t.mock.method(Sandbox, 'getInfo', async () => info);
    t.mock.method(Sandbox, 'connect', async () => {
      connections++;
      return { sandboxId: 'preserved', getInfo: async () => ({ ...info, endAt: failure === 'lifetime-changed' ? new Date(info.endAt.getTime() + 1000) : info.endAt }),
        commands: { list: async () => [{ pid: 12 }], kill: async () => { throw new Error('private provider detail'); } } };
    });
    const connection = new E2BAdapter('fixture', 'example.test', false, 4096).connect('preserved');
    if (failure === 'quiescence-unknown') await assert.rejects((await connection)!.stopCommands!(), /could not be quiesced/);
    else await assert.rejects(connection, /reconnection is unconfirmed/);
    if (failure === 'paused') assert.equal(connections, 0);
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

for (const background of [false, true]) {
  test(`E2B ${background ? 'preview' : 'foreground command'} cancellation explicitly kills the handle`, async (t) => {
    const controller = new AbortController();
    const waiting = deferred<never>();
    const started = deferred<void>();
    let kills = 0;
    t.mock.method(Sandbox, 'create', async () => ({ sandboxId: 'fixture', commands: { run: async (command: string, options: { signal?: AbortSignal }) => {
      if (command.startsWith('mkdir')) return {};
      assert.equal(options.signal, controller.signal);
      started.resolve();
      return { pid: 12, wait: () => waiting.promise, disconnect: async () => {}, kill: async () => {
        kills++; if (!background) waiting.reject(new Error('Command stopped')); return true;
      } };
    } } }));
    const sandbox = await new E2BAdapter('fixture', 'example.test', false, 4096).start(provider, { metadata: {}, networkPolicy: { mode: 'unrestricted' } });
    const command = sandbox.runCommand('mutate-workspace', { cwd: '/workspace', timeoutMs: 1000, signal: controller.signal, background });
    await started.promise;
    if (background) await command;
    controller.abort(); controller.abort();
    if (!background) await assert.rejects(command, /aborted/);
    await Promise.resolve(); await Promise.resolve();
    await sandbox.stopCommands!();
    assert.equal(kills, 1);
  });
}

test('E2B rejects cancellation before dispatch and retains uncertain command termination', async (t) => {
  let runs = 0;
  const waiting = deferred<never>();
  t.mock.method(Sandbox, 'create', async () => ({ sandboxId: 'fixture', commands: { run: async (command: string, options: { signal?: AbortSignal }) => {
    if (command.startsWith('mkdir')) return {};
    runs++;
    options.signal!.addEventListener('abort', () => waiting.reject(new Error('Transport aborted')), { once: true });
    return { pid: 12, wait: () => waiting.promise, disconnect: async () => {}, kill: async () => { throw new Error('Provider unavailable'); } };
  } } }));
  const sandbox = await new E2BAdapter('fixture', 'example.test', false, 4096).start(provider, { metadata: {}, networkPolicy: { mode: 'unrestricted' } });
  await assert.rejects(sandbox.runCommand('never', { cwd: '/', timeoutMs: 1000, signal: AbortSignal.abort() }));
  assert.equal(runs, 0);
  const controller = new AbortController();
  const command = sandbox.runCommand('running', { cwd: '/', timeoutMs: 1000, signal: controller.signal });
  await Promise.resolve(); await Promise.resolve(); controller.abort();
  await assert.rejects(command, /termination is unconfirmed/);
  await assert.rejects(sandbox.stopCommands!(), /recovery is required/);
});

test('quiescing a preview removes its abort listener before sandbox disposal', async (t) => {
  let kills = 0;
  t.mock.method(Sandbox, 'create', async () => ({ sandboxId: 'fixture', commands: { run: async (command: string) => {
    if (command.startsWith('mkdir')) return {};
    return { pid: 12, disconnect: async () => {}, kill: async () => { kills++; return true; } };
  } } }));
  const sandbox = await new E2BAdapter('fixture', 'example.test', false, 4096).start(provider, { metadata: {}, networkPolicy: { mode: 'unrestricted' } });
  const controller = new AbortController();
  await sandbox.runCommand('preview', { cwd: '/', timeoutMs: 1000, background: true, signal: controller.signal });
  await sandbox.stopCommands!(); controller.abort(); await Promise.resolve();
  assert.equal(kills, 1);
});

test('shutdown before polling or during maintenance prevents a new claim', async () => {
  const controller = new AbortController();
  let claims = 0;
  const runner = { runOnce: async () => { claims++; return false; } } as SessionRunner;
  await runUntilStopped(runner, { signal: controller.signal, shouldContinue: () => true, idlePollSeconds: 60, log,
    maintenance: async () => { controller.abort(); } });
  await runUntilStopped(runner, { signal: controller.signal, shouldContinue: () => true, idlePollSeconds: 60, log });
  assert.equal(claims, 0);
});

test('idle shutdown interrupts the polling wait without another claim', async () => {
  const controller = new AbortController();
  const claimed = deferred<void>();
  let claims = 0;
  const runner = { runOnce: async () => { claims++; claimed.resolve(); return false; } } as SessionRunner;
  const work = runUntilStopped(runner, { signal: controller.signal, shouldContinue: () => true, idlePollSeconds: 300, log });
  await claimed.promise; controller.abort(); await work;
  assert.equal(claims, 1);
});

test('total drain deadline is bounded and does not reset on repeated shutdown', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  const work = deferred<void>();
  const draining = withDrainDeadline(controller.signal, 90000, () => work.promise, log);
  const rejected = assert.rejects(draining, /drain deadline exceeded/);
  controller.abort(); t.mock.timers.tick(89999); controller.abort(); t.mock.timers.tick(1);
  await rejected;
  work.resolve(); // The test settles outstanding work; production exits on this rejection.
});

test('completed drain returns immediately without waiting for its deadline', async () => {
  await withDrainDeadline(AbortSignal.abort(), 90000, async () => {}, log);
});

function runnerFixture(mode: 'model' | 'command' | 'queue' | 'save-failure' | 'validation') {
  const { db, data } = ledger();
  const plans = new Map(planDocuments.map((doc) => [doc.key, parsePlan(doc, doc.key, registry)]));
  const plan = plans.get('business')!;
  const entitlements = { planKey: plan.key, planName: plan.name, capabilities: new ResolvedEntitlements(plan.entitlements),
    meterLimits: plan.meterLimits, rateLimits: plan.rateLimits } as UserEntitlements;
  const configuration = { get: async () => ({ registry, plans }) } as unknown as ConfigurationStore;
  const metering = new MeteringService(db, configuration);
  const shutdown = new AbortController();
  const entered = deferred<void>();
  const events: string[] = [];
  let activeSignal: AbortSignal | undefined;
  let cancelListener: ((event: { type: string }) => void) | undefined;
  let leaseValid = true;
  const running = { externalId: 'vm-fixture', lifetime: async () => ({ startedAt: new Date(Date.now() - 1000), endAt: new Date(Date.now() + 59000) }),
    stopCommands: async () => { events.push('stop-commands'); },
    runCommand: async (_command: string, options: { signal?: AbortSignal }) => {
      activeSignal = options.signal; events.push('mutation'); entered.resolve();
      await new Promise((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(new Error('Command stopped')), { once: true }));
    },
  } as unknown as RunningSandbox;
  const adapter: SandboxAdapter = { connect: async () => running, start: async (_provider, context) => {
    await context.lifecycle!.beforeCreate(); await context.lifecycle!.created(running); return running;
  }, terminate: async () => { events.push('terminate'); return true; } };
  let calls = 0;
  const anthropic = { messages: {
    countTokens: async () => ({ input_tokens: 2 }),
    stream: (_params: unknown, options: { signal: AbortSignal }) => {
      activeSignal = options.signal; calls++;
      return { on: () => {}, finalMessage: async () => {
        if (mode === 'model' || mode === 'save-failure') {
          entered.resolve();
          await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('Model stopped')), { once: true }));
        }
        const validator = [...registry.specialists.values()].find((item) => item.validation)!;
        return { content: mode === 'validation' && calls === 1
          ? [{ type: 'tool_use', id: 'consult', name: 'consult_specialist', input: { role: validator.key, question: 'Validate' } }]
          : mode === 'validation' && calls === 2
            ? [{ type: 'tool_use', id: 'validate', name: 'run_validation', input: { operation: [...provider.validationProfiles.keys()][0] } }]
          : mode === 'command' ? [{ type: 'tool_use', id: 'tool-1', name: 'run_command', input: { command: 'mutate' } }]
          : [{ type: 'text', text: 'Complete' }], usage: { input_tokens: 2, output_tokens: 1 }, stop_reason: 'end_turn' };
      } };
    },
  } } as unknown as Anthropic;
  const session = { id: 's', projectId: 'p', ownerUid: 'u', model: entitlements.capabilities.stringList('ai.model.allowlist')[0],
    effort: 'low', mode: 'build', leaseToken: 'lease', reservationIds: [], specialistReservationIds: [] };
  const sessions = {
    requireWorkspaceSalvage: async () => { events.push('salvage-required'); },
    claim: async () => session, heartbeat: async () => { if (!leaseValid) throw new Error('Lease authority lost'); }, assertPersistenceLease: async () => {}, attachSandbox: async () => {},
    detachSandbox: async () => { events.push('detach'); }, drainSteerMessage: async () => undefined,
    listMessages: async () => [{ role: 'user', content: 'Build', seq: 0 }],
    reserveSpecialistTokens: async (_id: string, _runner: string, input: { meterKey: string; quantity: number; operationId: string }) =>
      metering.reserve({ ...input, uid: 'u', entitlements, now: new Date() }),
    forgetSpecialistReservation: async () => {},
    appendAssistantMessage: async () => { if (mode === 'queue') shutdown.abort(); },
    dequeueNextMessage: async () => { events.push('dequeue'); },
    yieldForRecovery: async () => { events.push('yield'); }, finish: async () => { events.push('finish'); return 'QUEUED'; },
  };
  const logs: { details: object; message: string }[] = [];
  const capture = (details: object, message: string) => { logs.push({ details, message }); };
  const deps = { models: fixtureModels, runnerId: 'runner', anthropic, sessions, metering, configuration,
    entitlements: { forUser: async () => entitlements },
    projects: { readOwned: async () => ({ id: 'p', platform: 'web', ownerUid: 'u', name: 'Fixture', snapshot: { kind: 'none' } }) },
    sandboxes: new SandboxService(configuration, metering, new Map([['e2b', adapter]])),
    persistence: { restore: async () => 'fresh', save: async (input: { cleanup?: boolean }) => {
      if (mode !== 'validation') assert.equal(input.cleanup, true); events.push('save');
      if (!leaseValid) throw new Error('Lease authority lost');
      if (mode === 'save-failure') throw new Error('Storage unavailable');
      return { bytes: 1, committed: true };
    } }, events: { subscribe: async (_id: string, listener: typeof cancelListener) => { cancelListener = listener; return () => {}; }, append: async () => {} },
    limits: { maxSteps: 3, maxOutputTokens: 10, toolOutputMaxChars: 4096, maxSpecialistConsultations: mode === 'validation' ? 1 : 0,
      specialistMaxSteps: mode === 'validation' ? 2 : 1, commandTimeoutMs: 1000, previewReadyTimeoutSeconds: 1 }, heartbeatSeconds: 60, messageHistoryLimit: 10,
    log: { info: capture, warn: capture, error: capture },
  } as unknown as RunnerDependencies;
  return { runner: new SessionRunner(deps), shutdown, entered, events, data, logs, sessions, running, adapter, signal: () => activeSignal, calls: () => calls,
    cancel: () => cancelListener?.({ type: 'session.cancel_requested' }), loseLease: () => { leaseValid = false; } };
}

test('detachment failure logs safe diagnostics while retaining existing cleanup behavior', async () => {
  const h = runnerFixture('command');
  const secret = 'Bearer SUPER_SECRET_RUNTIME_TOKEN';
  h.sessions.detachSandbox = async () => { throw Object.assign(new Error(secret), { stderr: secret, status: 503 }); };
  const work = h.runner.runOnce();
  await h.entered.promise; h.cancel(); await work;
  const row = h.logs.find((item) => item.message === 'could not clear the sandbox record')!;
  assert.ok(row);
  assert.deepEqual(row.details, { sessionId: 's', diagnostic: { category: 'error/runtime', statusCode: 503 } });
  assert.equal(inspect(h.logs, { depth: 10 }).includes(secret), false);
  assert.ok(h.events.includes('finish'), 'I02 lifecycle propagation is deliberately unchanged');
});

test('validation disposal callback excludes nested provider errors and command stderr', async () => {
  const h = runnerFixture('validation');
  const secret = 'DATABASE_URL=postgres://user:password@example';
  const copy = { ...h.running, externalId: 'validation-vm', runCommand: async () => ({ exitCode: 0, stdout: 'authorized output', stderr: '' }) };
  h.running.forkForValidation = async (_timeout, _network, lifecycle) => {
    await lifecycle!.beforeCreate(); await lifecycle!.created(copy); return copy;
  };
  const terminate = h.adapter.terminate!;
  h.adapter.terminate = async (id) => {
    if (id === 'validation-vm') throw Object.assign(new Error(secret), { stderr: secret, exitCode: 7 });
    return terminate(id);
  };
  await h.runner.runOnce();
  const row = h.logs.find((item) => item.message === 'validation disposal failed');
  assert.ok(row, 'must exercise the actual validation cleanup callback');
  assert.ok(JSON.stringify(row).includes('error/aggregate'));
  assert.equal(inspect(h.logs, { depth: 10 }).includes(secret), false);
});

test('authorized command output is unchanged by operational diagnostic sanitization', async () => {
  const stdout = 'Authorized workspace output';
  const stderr = 'DATABASE_URL=postgres://user:password@example';
  const result = await runTool('run_command', { command: 'fixture-command' }, {
    provider, sandbox: { runCommand: async () => ({ exitCode: 7, stdout, stderr }) } as unknown as RunningSandbox,
    signal: new AbortController().signal, commandTimeoutMs: 1000, toolOutputMaxChars: 4096,
  } as ToolContext, workspaceTools);
  assert.ok(result.text.includes(stdout));
  assert.ok(result.text.includes(stderr));
});

test('heartbeat lease loss aborts active work and cannot finalize or publish a cleanup snapshot', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const h = runnerFixture('model');
  const work = h.runner.runOnce();
  await h.entered.promise; h.loseLease(); t.mock.timers.tick(60000);
  await assert.rejects(work, RunnerWorkError);
  assert.equal(h.signal()?.aborted, true);
  assert.equal(h.events.includes('finish'), false);
  assert.equal(h.events.includes('yield'), false);
});

test('user cancellation reaches the active command, saves partial work and follows existing failure finalization', async () => {
  const h = runnerFixture('command');
  const work = h.runner.runOnce();
  await h.entered.promise; h.cancel(); h.cancel(); await work;
  assert.equal(h.signal()?.aborted, true);
  assert.equal(h.calls(), 1);
  assert.ok(h.events.indexOf('save') < h.events.indexOf('terminate'));
  assert.ok(h.events.includes('finish'));
  assert.equal(h.events.includes('yield'), false);
  assert.equal(h.events.includes('dequeue'), false);
  assert.equal(h.data.get(`users/u/usage/${provider.concurrencyMeterKey}`)?.['reserved'], 0);
});

for (const mode of ['model', 'command', 'queue', 'save-failure'] as const) {
  test(`real runner, agent and sandbox metering preserve shutdown state during ${mode}`, async () => {
    const h = runnerFixture(mode);
    const work = h.runner.runOnce(h.shutdown.signal);
    if (mode !== 'queue') { await h.entered.promise; h.shutdown.abort(); }
    if (mode === 'save-failure') await assert.rejects(work, RunnerWorkError);
    else await work;
    assert.equal(h.signal()?.aborted, true);
    assert.equal(h.calls(), 1);
    assert.equal(h.events.includes('dequeue'), false);
    assert.ok(h.events.includes('stop-commands') && h.events.includes('save'));
    if (mode === 'save-failure') {
      // No mutating tool was admitted in this mode; there are no newer user files to salvage.
      assert.equal(h.events.includes('terminate'), true);
      assert.equal(h.events.includes('yield'), false);
    } else {
      assert.ok(h.events.indexOf('save') < h.events.indexOf('terminate'));
      assert.ok(h.events.includes(mode === 'queue' ? 'finish' : 'yield'));
      assert.equal(h.data.get(`users/u/usage/${provider.concurrencyMeterKey}`)?.['reserved'], 0);
    }
    if (mode === 'model') {
      const unknown = [...h.data.values()].filter((fields) => fields['inFlight'] === true && fields['status'] === 'OPEN');
      assert.equal(unknown.length, 2); // No provider usage was received; neither token hold is zeroed.
    }
  });
}
