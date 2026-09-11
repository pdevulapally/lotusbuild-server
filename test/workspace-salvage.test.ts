import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspect } from 'node:util';
import type { Auth } from 'firebase-admin/auth';
import { Timestamp } from 'firebase-admin/firestore';
import type Anthropic from '@anthropic-ai/sdk';
import { parseRegistry, parsePlan } from '../src/entitlements/schema.ts';
import { ResolvedEntitlements, type EntitlementService, type UserEntitlements } from '../src/entitlements/service.ts';
import type { ConfigurationStore } from '../src/entitlements/store.ts';
import { registryDocument, planDocuments } from '../src/seed/config.ts';
import { MeteringService } from '../src/metering/service.ts';
import { ProjectRepository } from '../src/projects/repository.ts';
import { ProjectPersistence } from '../src/projects/persistence.ts';
import { AccountErasure } from '../src/privacy/erasure.ts';
import { SessionRepository } from '../src/sessions/repository.ts';
import type { UserRepository } from '../src/users/repository.ts';
import { SandboxService } from '../src/sandboxes/service.ts';
import type { RunningSandbox, SandboxAdapter } from '../src/sandboxes/provider.ts';
import type { SnapshotStorage } from '../src/storage/snapshots.ts';
import { RunnerWorkError, SessionRunner, runUntilStopped, withDrainDeadline, type RunnerDependencies } from '../src/runner/loop.ts';
import { ledger } from './support/ledger.ts';

const marker = 'synthetic-private-diagnostic';
function fixture(t: TestContext) {
  const { db, data } = ledger();
  const registry = parseRegistry(registryDocument, 'registry');
  const plans = new Map(planDocuments.map((row) => [row.key, parsePlan(row, row.key, registry)]));
  const plan = plans.get('business')!;
  const entitlements = { planKey: plan.key, planName: plan.name, capabilities: new ResolvedEntitlements(plan.entitlements),
    meterLimits: plan.meterLimits, rateLimits: plan.rateLimits } as UserEntitlements;
  const configuration = { get: async () => ({ registry, plans }) } as unknown as ConfigurationStore;
  const entitlementService = { forUser: async () => entitlements } as unknown as EntitlementService;
  const metering = new MeteringService(db, configuration);
  const projects = new ProjectRepository(db, {} as UserRepository, entitlementService);
  const sessions = new SessionRepository(db, projects, entitlementService, configuration, metering, 120);
  const provider = registry.sandboxProviders.get('web')!;
  const root = mkdtempSync(join(tmpdir(), 'lotus-salvage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const objects = new Map<string, Buffer>();
  const events: string[] = [];
  const logs: unknown[] = [];
  const log = { info: (details: object, message: string) => { logs.push([details, message]); },
    warn: (details: object, message: string) => { logs.push([details, message]); },
    error: (details: object, message: string) => { logs.push([details, message]); } };
  let failUpload = true;
  let onUpload = async () => {};
  let alive = true;
  let entered!: () => void;
  const mutated = new Promise<void>((resolve) => { entered = resolve; });
  const record = () => data.get('sessions/s')!;
  const state = () => record()['workspaceRecovery'] as { status: string; reason?: string } | undefined;
  const storage: SnapshotStorage = {
    createUpload: async (projectId, id, bytes, beforeSign) => {
      const objectName = `projects/${projectId}/snapshots/${id}.tar.gz`;
      await beforeSign(objectName, new Date(Date.now() + 60000));
      return { objectName, url: objectName };
    },
    inspectUpload: async (objectName) => ({ objectName, generation: '1', bytes: objects.get(objectName)!.length }),
    readUrl: async (_project, snapshot) => { assert.equal(snapshot.kind, 'immutable'); return snapshot.kind === 'immutable' ? snapshot.objectName : ''; },
    removeStored: async () => {},
  };
  const persistence = new ProjectPersistence(sessions, storage, { name: 'Fixture', email: 'fixture@example.test' }, 10000);
  function sandbox(name: string): RunningSandbox {
    const folder = join(root, name); mkdirSync(folder);
    const work = join(folder, 'workspace'); mkdirSync(work);
    const mapPath = (path: string) => path.startsWith('/tmp/') ? join(folder, path.slice(5)) : join(work, path);
    const quote = (path: string) => "'" + path.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_match, drive: string) => '/' + drive.toLowerCase()).replaceAll("'", "'\\''") + "'";
    return {
      externalId: name,
      lifetime: async () => ({ startedAt: new Date(Date.now() - 1000), endAt: new Date(Date.now() + 59000) }),
      stopCommands: async () => { events.push('quiesce'); },
      stop: async () => {}, previewUrl: () => 'https://fixture.invalid',
      readFile: async (path) => readFileSync(mapPath(path), 'utf8'),
      writeFile: async (path, content) => { writeFileSync(mapPath(path), content); },
      runCommand: async (command, options) => {
        if (command === 'mutate') {
          assert.equal(state()?.status, 'REQUIRED', 'durable marker must precede the first mutation');
          writeFileSync(join(work, 'mutated.txt'), 'These workspace bytes must survive.');
          entered();
          await new Promise<never>((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(new Error(marker)), { once: true }));
        }
        if (command.includes('curl -sf -X PUT')) {
          if (failUpload) throw new Error(marker);
          objects.set(readFileSync(mapPath('/tmp/lotusbuild-url'), 'utf8'), readFileSync(mapPath('/tmp/lotusbuild-repo.tar.gz')));
          events.push('upload'); await onUpload();
        } else if (command.includes('curl -sfL')) {
          writeFileSync(mapPath('/tmp/lotusbuild-repo.tar.gz'), objects.get(readFileSync(mapPath('/tmp/lotusbuild-url'), 'utf8'))!);
        }
        const script = command.replaceAll('/tmp/lotusbuild-repo.tar.gz', quote(mapPath('/tmp/lotusbuild-repo.tar.gz')))
          .replaceAll('/tmp/lotusbuild-url', quote(mapPath('/tmp/lotusbuild-url')))
          .split('\n').filter((line) => !line.startsWith('curl ')).join('\n');
        const stdout = execFileSync('bash', ['-c', script], { cwd: work,
          env: { ...process.env, ...options.envs, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' }, encoding: 'utf8' });
        return { exitCode: 0, stdout, stderr: '' };
      },
    };
  }
  const primary = sandbox('vm');
  const adapter: SandboxAdapter = {
    start: async (_provider, context) => { await context.lifecycle!.beforeCreate(); await context.lifecycle!.created(primary); return primary; },
    connect: async () => { events.push('connect'); return alive ? primary : undefined; },
    terminate: async () => { events.push('terminate'); assert.notEqual(state()?.status, 'REQUIRED'); const wasAlive = alive; alive = false; return wasAlive; },
  };
  const sandboxes = new SandboxService(configuration, metering, new Map([['e2b', adapter]]));
  const anthropic = { messages: { countTokens: async () => ({ input_tokens: 2 }), stream: () => ({ on: () => {}, finalMessage: async () => ({
    content: [{ type: 'tool_use', id: 'mutation', name: 'run_command', input: { command: 'mutate' } }],
    usage: { input_tokens: 2, output_tokens: 1 }, stop_reason: 'tool_use',
  }) }) } } as unknown as Anthropic;
  data.set('projects/p', { ownerUid: 'u', platform: 'web', name: 'Fixture', status: 'draft', activeSessionId: 's', snapshotBytes: 0, createdAt: Timestamp.now() });
  data.set('sessions/s', { ownerUid: 'u', projectId: 'p', status: 'QUEUED', model: entitlements.capabilities.stringList('ai.model.allowlist')[0],
    effort: 'high', claimableAt: Timestamp.now(), messageCount: 1, createdAt: Timestamp.now() });
  data.set('sessions/s/messages/000000', { role: 'user', content: 'Build', createdAt: Timestamp.now() });
  const runner = (runnerId: string) => new SessionRunner({ runnerId, anthropic, sessions, projects, metering, configuration,
    entitlements: entitlementService, sandboxes, persistence, events: { subscribe: async () => () => {}, append: async () => {} },
    limits: { maxSteps: 2, maxOutputTokens: 10, toolOutputMaxChars: 4096, maxSpecialistConsultations: 0,
      specialistMaxSteps: 1, commandTimeoutMs: 10000, previewReadyTimeoutSeconds: 1 }, heartbeatSeconds: 60, messageHistoryLimit: 10, log,
  } as unknown as RunnerDependencies);
  const expire = () => { record()['claimableAt'] = Timestamp.fromMillis(0); };
  async function failedPredecessor() {
    const shutdown = new AbortController();
    const work = runner('A').runOnce(shutdown.signal);
    await Promise.race([mutated, work.then(() => { throw new Error('Runner ended before mutation: ' + inspect(logs)); })]);
    const token = record()['leaseToken'] as string;
    shutdown.abort(new Error('Runner shutdown requested.'));
    await assert.rejects(work, (error) => {
      assert.ok(error instanceof RunnerWorkError);
      assert.equal(error.errors[0].message, 'runner/shutdown');
      assert.equal(error.errors[1].message, 'workspace/save-failed');
      assert.equal(inspect(error).includes(marker), false);
      return true;
    });
    assert.equal(state()?.status, 'REQUIRED');
    assert.equal(events.includes('terminate'), false);
    record()['cancelRequested'] = true; expire(); // Successor salvages and finalizes, never starts another turn.
    return { sessionId: 's', runnerId: 'A', token };
  }
  return { db, data, sessions, projects, metering, persistence, sandboxes, adapter, provider, entitlements, events, logs, objects,
    runner, record, state, sandbox, log, expire, failedPredecessor,
    uploadsSucceed: () => { failUpload = false; }, disappear: () => { alive = false; },
    onUpload: (callback: () => Promise<void>) => { onUpload = callback; } };
}

test('failed-save successor publishes and restores actual mutated workspace bytes before termination', async (t) => {
  const h = fixture(t); const old = await h.failedPredecessor(); h.uploadsSucceed();
  await h.runner('B').runOnce();
  assert.equal(h.state()?.status, 'COMPLETED');
  assert.ok(h.events.indexOf('upload') < h.events.indexOf('terminate'));
  await assert.rejects(h.sessions.assertPersistenceLease(old, true), { code: 'session/lease-lost' });
  const restored = h.sandbox('restored');
  await h.persistence.restore(restored, h.provider, await h.projects.readOwned('u', 'p'));
  assert.equal(await restored.readFile('mutated.txt'), 'These workspace bytes must survive.');
  assert.equal(h.record()['status'], 'FAILED'); // Existing user cancellation semantics.
  assert.equal(h.data.get(`users/u/usage/${h.provider.concurrencyMeterKey}`)?.['reserved'], 0);
});

test('failed successor save retains required state and resources, with safe primary and secondary errors', async (t) => {
  const h = fixture(t); await h.failedPredecessor();
  await assert.rejects(h.runner('B').runOnce(), (error) => {
    assert.ok(error instanceof RunnerWorkError); assert.equal(error.errors.length, 2);
    assert.equal(inspect(error).includes(marker), false); return true;
  });
  assert.equal(h.state()?.status, 'REQUIRED'); assert.equal(h.events.includes('terminate'), false);
  assert.equal(inspect(h.logs).includes(marker), false);
});

test('confirmed absence ends unrecoverable execution without releasing unknown runtime or retaining the project lock', async (t) => {
  const h = fixture(t); await h.failedPredecessor(); h.disappear();
  const registry = parseRegistry(registryDocument, 'registry');
  const [runtimePath, initialRuntime] = [...h.data].find(([path, fields]) => path.includes('/reservations/') && fields['meterKey'] === registry.sandboxTimeMeterKey)!;
  const initialUsage = JSON.stringify(h.data.get(`users/u/usage/${registry.sandboxTimeMeterKey}`));
  const ids = h.record()['reservationIds'];
  await h.runner('B').runOnce();
  assert.equal(h.state()?.status, 'UNRECOVERABLE'); assert.equal(h.state()?.reason, 'sandbox-absent');
  assert.equal(h.objects.size, 0);
  assert.equal(h.record()['status'], 'FAILED'); assert.equal(h.record()['claimableAt'], undefined);
  assert.equal(h.record()['leaseToken'], undefined); assert.equal(h.record()['sandboxId'], undefined);
  assert.equal(h.data.get('projects/p')?.['activeSessionId'], null);
  assert.deepEqual(h.record()['reservationIds'], ids);
  const runtime = h.data.get(runtimePath)!;
  assert.equal(runtime['status'], 'OPEN'); assert.equal(runtime['inFlight'], true);
  assert.equal(runtime['sandboxStopped'], true);
  for (const key of ['sandboxExternalId', 'sandboxPlatform', 'sandboxStartedAt', 'sandboxEndAt', 'estimatedQuantity', 'createdAt']) {
    assert.deepEqual(runtime[key], initialRuntime[key]);
  }
  for (const key of ['observedQuantity', 'settledQuantity', 'sandboxStoppedAt']) assert.equal(runtime[key], undefined);
  assert.equal(JSON.stringify(h.data.get(`users/u/usage/${registry.sandboxTimeMeterKey}`)), initialUsage);
  assert.equal(h.data.get(`users/u/usage/${h.provider.concurrencyMeterKey}`)?.['reserved'], 0);
  const beforeRetry = JSON.stringify([...h.data]); const events = [...h.events];
  assert.equal(await h.runner('C').runOnce(), false); assert.equal(await h.runner('D').runOnce(), false);
  assert.equal(JSON.stringify([...h.data]), beforeRetry); assert.deepEqual(h.events, events);
  for (const admit of [() => h.sessions.appendPrompt('u', 's', 'Continue'),
    () => h.sessions.enqueueMessage('u', 's', 'Continue'), () => h.sessions.queueSteerMessage('u', 's', 'Continue')]) {
    await assert.rejects(admit(), { code: 'session/workspace-unrecoverable' });
  }
  assert.equal(JSON.stringify([...h.data]), beforeRetry);
  const fresh = await h.sessions.create('u', 'p', { prompt: 'Explicit new build', model: h.record()['model'] as string });
  assert.equal(fresh.status, 'QUEUED'); assert.equal(h.data.get('projects/p')?.['activeSessionId'], fresh.id);
  assert.equal((await h.sessions.claim('fresh-runner'))?.id, fresh.id);
});

test('confirmed absence with authoritative runtime retains ordinary settled cleanup', async (t) => {
  const h = fixture(t); await h.failedPredecessor(); h.disappear();
  const registry = parseRegistry(registryDocument, 'registry');
  const [path] = [...h.data].find(([key, fields]) => key.includes('/reservations/') && fields['meterKey'] === registry.sandboxTimeMeterKey)!;
  await h.metering.recordObservedUsage('u', path.split('/').at(-1)!, 12, 'fixture-provider-evidence');
  const terminal = t.mock.method(h.sessions, 'finishUnrecoverable');
  await h.runner('B').runOnce();
  assert.equal(terminal.mock.callCount(), 0);
  assert.equal(h.data.get(path)?.['status'], 'SETTLED'); assert.equal(h.data.get(path)?.['settledQuantity'], 12);
  assert.equal(h.record()['status'], 'FAILED'); assert.equal(h.data.get('projects/p')?.['activeSessionId'], null);
});

test('provider uncertainty cannot unlock salvageable execution', async (t) => {
  const h = fixture(t); await h.failedPredecessor();
  h.adapter.connect = async () => { throw new Error(marker); };
  await assert.rejects(h.runner('B').runOnce(), RunnerWorkError);
  assert.equal(h.state()?.status, 'REQUIRED'); assert.equal(h.record()['status'], 'RUNNING');
  assert.equal(h.data.get('projects/p')?.['activeSessionId'], 's');
  assert.equal(h.data.get(`users/u/usage/${h.provider.concurrencyMeterKey}`)?.['reserved'], 1);
});

test('unrecoverable terminalization refuses missing stop evidence for any sandbox', async (t) => {
  const h = fixture(t); await h.failedPredecessor(); h.disappear();
  const confirm = h.metering.confirmSandboxStopped.bind(h.metering);
  t.mock.method(h.metering, 'confirmSandboxStopped', async () => { throw new Error(marker); });
  await assert.rejects(h.runner('B').runOnce(), RunnerWorkError);
  assert.equal(h.state()?.status, 'UNRECOVERABLE'); assert.equal(h.data.get('projects/p')?.['activeSessionId'], 's');
  t.mock.restoreAll(); h.expire();
  const c = await h.sessions.claim('C'); assert.ok(c);
  const auth = { sessionId: 's', runnerId: 'C', token: c.leaseToken };
  const ids = [...new Set([...c.reservationIds, ...c.specialistReservationIds])];
  await confirm('u', ids.filter((id) => h.data.get(`users/u/reservations/${id}`)?.['sandboxExternalId'] === 'vm'), 'vm');
  const extra = await h.metering.reserve({ uid: 'u', entitlements: h.entitlements,
    meterKey: h.provider.concurrencyMeterKey, quantity: 1, operationId: 's', now: new Date() });
  await h.metering.markInFlight('u', [extra.id]);
  h.record()['specialistReservationIds'] = [...c.specialistReservationIds, extra.id];
  await assert.rejects(h.sessions.finishUnrecoverable(auth), /not confirmed stopped/);
  assert.equal(h.data.get('projects/p')?.['activeSessionId'], 's');
});

test('settlement failure after durable stop evidence does not prevent unrecoverable terminalization', async (t) => {
  const h = fixture(t); await h.failedPredecessor(); h.disappear();
  const reconcile = h.metering.reconcile.bind(h.metering);
  t.mock.method(h.metering, 'reconcile', async (uid: string, id: string, now?: Date) => {
    if (h.data.get(`users/${uid}/reservations/${id}`)?.['sandboxExternalId'] === 'vm') throw new Error(marker);
    return reconcile(uid, id, now);
  });
  await h.runner('B').runOnce();
  assert.equal(h.record()['status'], 'FAILED'); assert.equal(h.data.get('projects/p')?.['activeSessionId'], null);
  assert.equal(h.data.get(`users/u/usage/${h.provider.concurrencyMeterKey}`)?.['reserved'], 1);
  // Known-free concurrency remains retryable, not fabricated as already released.
  t.mock.restoreAll();
  const gauge = [...h.data].find(([path, fields]) => path.includes('/reservations/') && fields['meterKey'] === h.provider.concurrencyMeterKey)!;
  await h.metering.reconcile('u', gauge[0].split('/').at(-1)!);
  assert.equal(h.data.get(`users/u/usage/${h.provider.concurrencyMeterKey}`)?.['reserved'], 0);
});

test('lost terminal commit acknowledgement leaves the project unlocked and accounting discoverable', async (t) => {
  const h = fixture(t); await h.failedPredecessor(); h.disappear();
  const finish = h.sessions.finishUnrecoverable.bind(h.sessions);
  t.mock.method(h.sessions, 'finishUnrecoverable', async (...args: Parameters<typeof finish>) => { await finish(...args); throw new Error(marker); });
  await assert.rejects(h.runner('B').runOnce(), RunnerWorkError);
  assert.equal(h.record()['status'], 'FAILED'); assert.equal(h.data.get('projects/p')?.['activeSessionId'], null);
  const before = JSON.stringify([...h.data]);
  assert.equal(await h.runner('C').runOnce(), false); assert.equal(JSON.stringify([...h.data]), before);
});

test('crash after stop evidence and lease takeover permits only the successor to finalize', async (t) => {
  const h = fixture(t); await h.failedPredecessor(); h.disappear();
  const finish = h.sessions.finishUnrecoverable.bind(h.sessions);
  let stale!: Parameters<typeof finish>[0];
  t.mock.method(h.sessions, 'finishUnrecoverable', async (auth: Parameters<typeof finish>[0]) => { stale = auth; throw new Error(marker); });
  await assert.rejects(h.runner('B').runOnce(), RunnerWorkError);
  assert.equal(h.record()['status'], 'RUNNING'); assert.equal(h.data.get('projects/p')?.['activeSessionId'], 's');
  t.mock.restoreAll(); h.expire();
  const successor = await h.sessions.claim('C'); assert.ok(successor);
  await assert.rejects(finish(stale), { code: 'session/lease-lost' });
  await finish({ sessionId: 's', runnerId: 'C', token: successor.leaseToken });
  await assert.rejects(h.sessions.requireWorkspaceSalvage(stale, 'vm'), { code: 'session/cancelled' });
  await assert.rejects(h.sessions.detachSandbox('s', stale), { code: 'session/lease-lost' });
  await assert.rejects(h.sessions.assertPersistenceLease(stale, true), { code: 'session/lease-lost' });
  assert.equal(h.record()['status'], 'FAILED'); assert.equal(h.data.get('projects/p')?.['activeSessionId'], null);
});

test('erasure distinguishes terminal lost workspace from unresolved accounting', async (t) => {
  const h = fixture(t); await h.failedPredecessor(); h.disappear(); await h.runner('B').runOnce();
  const erasure = new AccountErasure(h.db, { updateUser: async () => {}, revokeRefreshTokens: async () => {} } as unknown as Auth,
    h.projects, h.sessions, async () => {});
  await assert.rejects(erasure.apply('u', { requestReference: 'fixture-request', billingReviewReference: 'fixture-billing', retentionDecisionReference: 'fixture-retention' }),
    { code: 'account/reconciliation-required' });
  assert.equal(h.record()['status'], 'FAILED'); assert.equal(h.data.get('projects/p')?.['activeSessionId'], null);
  assert.ok([...h.data].some(([path, fields]) => path.includes('/reservations/') && fields['status'] === 'OPEN'));
});

test('failure between terminal session and project writes commits neither and successor completes atomically', async (t) => {
  const h = fixture(t); await h.failedPredecessor(); h.disappear();
  const runTransaction = h.db.runTransaction.bind(h.db);
  t.mock.method(h.db, 'runTransaction', (work: (tx: import('firebase-admin/firestore').Transaction) => Promise<unknown>) =>
    runTransaction(async (tx) => work(new Proxy(tx, { get(target, key) {
      if (key === 'update') return (ref: { path: string }, changes: Record<string, unknown>) => {
        if (ref.path === 'projects/p' && changes['activeSessionId'] === null) throw new Error(marker);
        return target.update(ref as import('firebase-admin/firestore').DocumentReference, changes);
      };
      return Reflect.get(target, key);
    } }))));
  await assert.rejects(h.runner('B').runOnce(), RunnerWorkError);
  assert.equal(h.record()['status'], 'RUNNING'); assert.equal(h.record()['sandboxId'], 'vm');
  assert.ok(h.record()['leaseToken']); assert.equal(h.data.get('projects/p')?.['activeSessionId'], 's');
  t.mock.restoreAll(); h.expire(); await h.runner('C').runOnce();
  assert.equal(h.record()['status'], 'FAILED'); assert.equal(h.record()['leaseToken'], undefined);
  assert.equal(h.data.get('projects/p')?.['activeSessionId'], null);
});

test('publication and salvage completion commit together despite lost acknowledgement; successor only cleans up', async (t) => {
  const h = fixture(t); await h.failedPredecessor(); h.uploadsSucceed();
  const publish = h.sessions.publishSnapshot.bind(h.sessions);
  t.mock.method(h.sessions, 'publishSnapshot', async (...args: Parameters<typeof publish>) => {
    await publish(...args); throw new Error(marker);
  });
  await assert.rejects(h.runner('B').runOnce(), RunnerWorkError);
  assert.equal(h.state()?.status, 'COMPLETED'); assert.equal(h.events.includes('terminate'), false);
  const objects = h.objects.size; const storage = h.data.get('users/u/usage/storage.bytes');
  h.expire(); t.mock.restoreAll(); await h.runner('C').runOnce();
  assert.equal(h.objects.size, objects); assert.deepEqual(h.data.get('users/u/usage/storage.bytes'), storage);
  assert.equal(h.events.filter((event) => event === 'connect').length, 1);
});

test('lease loss after upload prevents stale successor publication and leaves salvage required', async (t) => {
  const h = fixture(t); await h.failedPredecessor(); h.uploadsSucceed();
  h.onUpload(async () => { h.expire(); await h.sessions.claim('C'); });
  await assert.rejects(h.runner('B').runOnce(), RunnerWorkError);
  assert.equal(h.state()?.status, 'REQUIRED'); assert.equal(h.events.includes('terminate'), false);
  assert.equal(h.data.get('projects/p')?.['snapshotUploadId'], undefined);
});

for (const deletion of ['account', 'project', 'missing-project']) {
  test(`${deletion} deletion prevents salvage publication and records revoked persistence`, async (t) => {
    const h = fixture(t); await h.failedPredecessor(); h.uploadsSucceed();
    if (deletion === 'account') h.data.set('accountErasures/u', { status: 'PENDING' });
    else if (deletion === 'project') h.data.get('projects/p')!['status'] = 'deleting';
    else h.data.delete('projects/p');
    await h.runner('B').runOnce();
    assert.equal(h.state()?.status, 'UNRECOVERABLE'); assert.equal(h.state()?.reason, 'persistence-revoked');
    assert.equal(h.objects.size, 0);
  });
}

test('failed salvage reaches the outer drain boundary as failure instead of clean completion', async (t) => {
  const h = fixture(t); await h.failedPredecessor();
  const shutdown = new AbortController();
  h.adapter.connect = async () => { shutdown.abort(); throw new Error(marker); };
  await assert.rejects(withDrainDeadline(shutdown.signal, 90000, () => runUntilStopped(h.runner('B'), {
    signal: shutdown.signal, shouldContinue: () => !shutdown.signal.aborted, idlePollSeconds: 1, log: h.log,
  }), h.log), RunnerWorkError);
  assert.equal(h.state()?.status, 'REQUIRED'); assert.equal(inspect(h.logs).includes(marker), false);
});

test('ordinary destructive recovery explicitly rejects a salvage-required attachment', async (t) => {
  const h = fixture(t);
  await assert.rejects(h.sandboxes.recover({ uid: 'u', platform: 'web', externalSandboxId: 'vm', reservationIds: [],
    salvageRequired: true, now: new Date(), onProblem: () => {} }), /salvage must precede/);
  assert.equal(h.events.includes('terminate'), false);
});

test('a successor crashing before reconnection leaves the next owner able to salvage', async (t) => {
  const h = fixture(t); await h.failedPredecessor(); h.uploadsSucceed();
  const abandoned = await h.sessions.claim('B'); assert.ok(abandoned);
  assert.equal(h.state()?.status, 'REQUIRED'); h.expire();
  await h.runner('C').runOnce();
  const restored = h.sandbox('restored');
  await h.persistence.restore(restored, h.provider, await h.projects.readOwned('u', 'p'));
  assert.equal(await restored.readFile('mutated.txt'), 'These workspace bytes must survive.');
});

test('upload without publication remains salvageable on the next lease', async (t) => {
  const h = fixture(t); await h.failedPredecessor(); h.uploadsSucceed();
  h.onUpload(async () => { throw new Error(marker); });
  await assert.rejects(h.runner('B').runOnce(), RunnerWorkError);
  assert.equal(h.state()?.status, 'REQUIRED'); assert.equal(h.events.includes('terminate'), false);
  h.onUpload(async () => {}); h.expire(); await h.runner('C').runOnce();
  const restored = h.sandbox('restored');
  await h.persistence.restore(restored, h.provider, await h.projects.readOwned('u', 'p'));
  assert.equal(await restored.readFile('mutated.txt'), 'These workspace bytes must survive.');
});

for (const invalid of ['missing', 'malformed']) {
  test(`${invalid} attached sandbox ID produces an explicit unrecoverable outcome`, async (t) => {
    const h = fixture(t); await h.failedPredecessor();
    if (invalid === 'missing') delete h.record()['sandboxId'];
    else (h.record()['workspaceRecovery'] as Record<string, unknown>)['sandboxId'] = 'invalid/id';
    await h.runner('B').runOnce();
    assert.equal(h.state()?.status, 'UNRECOVERABLE'); assert.equal(h.state()?.reason, 'invalid-attachment');
    assert.equal(h.events.includes('connect'), false); assert.equal(h.objects.size, 0);
  });
}

test('account erasure beginning during upload still prevents pointer publication', async (t) => {
  const h = fixture(t); await h.failedPredecessor(); h.uploadsSucceed();
  h.onUpload(async () => { h.data.set('accountErasures/u', { status: 'PENDING' }); });
  await assert.rejects(h.runner('B').runOnce(), RunnerWorkError);
  assert.equal(h.state()?.status, 'REQUIRED'); assert.equal(h.events.includes('terminate'), false);
  assert.equal(h.data.get('projects/p')?.['snapshotUploadId'], undefined);
  h.expire(); await h.runner('C').runOnce();
  assert.equal(h.state()?.reason, 'persistence-revoked');
});

test('unrecoverable prompt admission rejects before any metering, scheduling or message mutation', async (t) => {
  const h = fixture(t);
  h.record()['status'] = 'FAILED'; delete h.record()['claimableAt'];
  h.record()['workspaceRecovery'] = { status: 'UNRECOVERABLE', sandboxId: 'vm', reason: 'sandbox-absent' };
  h.data.get('projects/p')!['activeSessionId'] = null;
  const registry = parseRegistry(registryDocument, 'registry');
  await h.metering.consume({ uid: 'u', entitlements: h.entitlements, meterKey: registry.buildMeterKey, quantity: 1, now: new Date() });
  await h.metering.reserve({ uid: 'u', entitlements: h.entitlements, meterKey: registry.inputTokenMeterKey,
    quantity: 1, operationId: 'existing-hold', now: new Date() });
  const before = JSON.stringify([...h.data]);
  const consume = t.mock.method(h.metering, 'consumeIn');
  const reserve = t.mock.method(h.metering, 'reserveIn');
  await assert.rejects(h.sessions.appendPrompt('u', 's', 'Continue'), {
    code: 'session/workspace-unrecoverable', statusCode: 409,
    message: 'The latest unsaved workspace state could not be recovered. This session cannot accept new work.',
  });
  assert.equal(consume.mock.callCount(), 0); assert.equal(reserve.mock.callCount(), 0);
  assert.equal(JSON.stringify([...h.data]), before); // Includes all counters, holds, messages and timestamps.
  assert.equal(await h.sessions.claim('next-runner'), undefined);
});

for (const recovery of [undefined, 'COMPLETED'] as const) {
  test(`runnable FAILED prompt admission accepts ${recovery ?? 'absent'} recovery state and enforces quota`, async (t) => {
    const h = fixture(t); h.record()['status'] = 'FAILED'; delete h.record()['claimableAt'];
    h.data.get('projects/p')!['activeSessionId'] = null;
    if (recovery !== undefined) h.record()['workspaceRecovery'] = { status: recovery, sandboxId: 'vm' };
    const registry = parseRegistry(registryDocument, 'registry');
    await h.sessions.appendPrompt('u', 's', 'Continue');
    assert.equal(h.record()['status'], 'QUEUED');
    assert.equal(h.data.get(`users/u/usage/${registry.buildMeterKey}`)?.['consumed'], 1);
    assert.equal(h.data.get('sessions/s/messages/000001')?.['content'], 'Continue');
    h.record()['status'] = 'FAILED'; delete h.record()['claimableAt']; h.data.get('projects/p')!['activeSessionId'] = null;
    await h.metering.consume({ uid: 'u', entitlements: h.entitlements, meterKey: registry.buildMeterKey,
      quantity: h.entitlements.meterLimits.get(registry.buildMeterKey)!.hardLimit - 1, now: new Date() });
    const before = JSON.stringify([...h.data]);
    await assert.rejects(h.sessions.appendPrompt('u', 's', 'Over quota'), { code: 'usage/limit-reached' });
    assert.equal(JSON.stringify([...h.data]), before);
  });
}

test('unknown recovery protocol or shape blocks claims and leaves sandbox and accounting untouched', async (t) => {
  const h = fixture(t); await h.failedPredecessor();
  const recovery = h.record()['workspaceRecovery'] as Record<string, unknown>;
  assert.equal(typeof recovery['protocol'], 'number');
  const cases = [null, {}, { ...recovery, protocol: Number(recovery['protocol']) + 1 },
    { ...recovery, protocol: '1' }, { ...recovery, protocol: null },
    { ...recovery, protocol: true }, { ...recovery, protocol: 0 },
    { ...recovery, status: 'FUTURE' }, { ...recovery, futureField: marker }];
  for (const value of cases) {
    h.record()['workspaceRecovery'] = value;
    const before = JSON.stringify([...h.data]); const events = [...h.events];
    await assert.rejects(h.runner('B').runOnce(), { code: 'session/recovery-protocol-incompatible' });
    assert.equal(JSON.stringify([...h.data]), before);
    assert.deepEqual(h.events, events);
  }
  let attempts = 0;
  const runner = h.runner('B'); const original = runner.runOnce.bind(runner);
  t.mock.method(runner, 'runOnce', async () => { attempts++; return original(); });
  await assert.rejects(runUntilStopped(runner, { idlePollSeconds: 1, shouldContinue: () => true, log: h.log }),
    { code: 'session/recovery-protocol-incompatible' });
  assert.equal(attempts, 1);
  assert.equal(inspect(h.logs).includes(marker), false);
  assert.ok(JSON.stringify(h.logs).includes('session/recovery-protocol-incompatible'));
});
