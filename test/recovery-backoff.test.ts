import assert from 'node:assert/strict';
import test from 'node:test';
import { Timestamp } from 'firebase-admin/firestore';
import type { Redis } from 'ioredis';
import type Anthropic from '@anthropic-ai/sdk';
import { registryDocument, planDocuments } from '../src/seed/config.ts';
import { ConfigurationStore } from '../src/entitlements/store.ts';
import { EntitlementService } from '../src/entitlements/service.ts';
import { SubscriptionCache } from '../src/entitlements/subscription-cache.ts';
import { MeteringService } from '../src/metering/service.ts';
import { ProjectRepository } from '../src/projects/repository.ts';
import type { UserRepository } from '../src/users/repository.ts';
import { SessionRepository } from '../src/sessions/repository.ts';
import { SandboxService } from '../src/sandboxes/service.ts';
import type { SandboxAdapter } from '../src/sandboxes/provider.ts';
import { RunnerWorkError, SessionRunner, type RunnerDependencies } from '../src/runner/loop.ts';
import { fixtureModels } from './support/models.ts';
import { ledger } from './support/ledger.ts';

const LEASE_SECONDS = 60;

function fixture(options: { readonly terminateFails?: boolean; readonly reservationIds?: readonly string[] } = {}) {
  const { db, data } = ledger();
  data.set('config/registry', registryDocument);
  for (const plan of planDocuments) data.set(`plans/${plan.key}`, plan);
  data.set('subscriptions/u', { planKey: 'business', status: 'ACTIVE',
    currentPeriodStart: Timestamp.fromMillis(Date.now() - 100000), currentPeriodEnd: Timestamp.fromMillis(Date.now() + 86400000) });
  const cacheData = new Map<string, string>();
  const redis = { get: async (key: string) => cacheData.get(key) ?? null,
    set: async (key: string, value: string) => { if (cacheData.has(key)) return null; cacheData.set(key, value); return 'OK'; },
    del: async (key: string) => Number(cacheData.delete(key)),
    eval: async (_s: string, _n: number, key: string, token: string, value: string) => { if (cacheData.get(key) !== token) return 0; cacheData.set(key, value); return 1; },
  } as unknown as Redis;
  const configuration = new ConfigurationStore(db, 60000);
  const entitlements = new EntitlementService(db, configuration, new SubscriptionCache(redis, 60));
  const metering = new MeteringService(db, configuration);
  const projects = new ProjectRepository(db, {} as UserRepository, entitlements);
  const sessions = new SessionRepository(db, projects, entitlements, configuration, metering, LEASE_SECONDS);
  const terminated: string[] = [];
  const adapter: SandboxAdapter = {
    start: async () => { throw new Error('No new sandbox is expected during recovery.'); },
    connect: async () => undefined,
    terminate: async (id) => { terminated.push(id); if (options.terminateFails === true) throw new Error('provider unreachable: secret-provider-detail'); return true; },
  };
  const logs: { details: Record<string, unknown>; message: string }[] = [];
  const capture = (details: Record<string, unknown>, message: string) => { logs.push({ details, message }); };
  const anthropic = { messages: { countTokens: async () => { throw new Error('No model call is expected during recovery.'); } } } as unknown as Anthropic;
  const model = 'claude-sonnet-4-5';
  data.set('projects/p', { ownerUid: 'u', platform: 'web', name: 'Fixture', status: 'draft', activeSessionId: 's', snapshotBytes: 0, createdAt: Timestamp.now() });
  // A predecessor died holding a sandbox and a reservation whose record no longer exists.
  data.set('sessions/s', { ownerUid: 'u', projectId: 'p', status: 'RUNNING', model, effort: 'high', claimedBy: 'dead-runner', leaseToken: 'stale',
    heartbeatAt: Timestamp.fromMillis(0), claimableAt: Timestamp.fromMillis(0), sandboxId: 'vm-lost', reservationIds: [...(options.reservationIds ?? ['missing-hold'])],
    messageCount: 1, createdAt: Timestamp.now() });
  data.set('sessions/s/messages/000000', { role: 'user', content: 'Build', createdAt: Timestamp.now() });
  const runner = new SessionRunner({ models: fixtureModels, runnerId: 'successor', anthropic, sessions, projects, metering, configuration, entitlements,
    sandboxes: new SandboxService(configuration, metering, new Map([['e2b', adapter]])),
    persistence: { restore: async () => 'fresh', save: async () => ({ bytes: 0, committed: false }) },
    events: { subscribe: async () => () => {}, append: async () => {} },
    skills: { enabledFor: async () => [] }, attachments: { read: async () => { throw new Error('unused'); } },
    limits: { maxSteps: 2, maxOutputTokens: 10, toolOutputMaxChars: 4096, maxSpecialistConsultations: 0, specialistMaxSteps: 1, commandTimeoutMs: 1000, previewReadyTimeoutSeconds: 1 },
    heartbeatSeconds: 60, messageHistoryLimit: 10, log: { info: capture, warn: capture, error: capture },
  } as unknown as RunnerDependencies);
  const record = () => data.get('sessions/s')!;
  const expire = () => { record()['claimableAt'] = Timestamp.fromMillis(0); };
  return { data, record, expire, runner, sessions, logs, terminated };
}

async function failedRecovery(h: ReturnType<typeof fixture>): Promise<void> {
  await assert.rejects(h.runner.runOnce(), (error: unknown) => {
    assert.ok(error instanceof RunnerWorkError);
    assert.equal(error.secondaryStage, 'sandbox/recovery-failed');
    return true;
  });
}

test('a failed resource recovery backs off exponentially instead of retrying every lease', async () => {
  const h = fixture();
  const before = Date.now();
  await failedRecovery(h);
  let claimableAt = (h.record()['claimableAt'] as Timestamp).toMillis();
  assert.equal(h.record()['status'], 'RUNNING');
  assert.equal(h.record()['recoveryAttempts'], 1);
  assert.deepEqual(h.record()['reservationIds'], ['missing-hold']);
  assert.equal(h.record()['sandboxId'], 'vm-lost');
  assert.ok(claimableAt >= before + 2 * LEASE_SECONDS * 1000 && claimableAt <= Date.now() + 2 * LEASE_SECONDS * 1000, 'first retry waits two leases');
  // Not claimable again until the backoff elapses.
  assert.equal(await h.sessions.claim('another-runner'), undefined);

  h.expire();
  await failedRecovery(h);
  claimableAt = (h.record()['claimableAt'] as Timestamp).toMillis();
  assert.equal(h.record()['recoveryAttempts'], 2);
  assert.ok(claimableAt >= before + 4 * LEASE_SECONDS * 1000, 'second retry waits four leases');

  h.record()['recoveryAttempts'] = 20; h.expire();
  await failedRecovery(h);
  claimableAt = (h.record()['claimableAt'] as Timestamp).toMillis();
  assert.equal(h.record()['recoveryAttempts'], 21);
  assert.ok(claimableAt <= Date.now() + 3600 * 1000 && claimableAt >= before + 3600 * 1000 - 1, 'backoff is capped at an hour');
  assert.equal(h.terminated.length, 0, 'a sandbox with no open hold is not terminated blindly');
});

test('recovery failures are logged with the session and a safe diagnostic', async () => {
  const h = fixture({ terminateFails: true, reservationIds: [] });
  await failedRecovery(h);
  const failure = h.logs.find((entry) => entry.message === 'sandbox recovery failed');
  assert.ok(failure);
  assert.equal(failure.details['sessionId'], 's');
  assert.ok(typeof failure.details['retryAt'] === 'string');
  assert.ok(failure.details['diagnostic'] !== undefined);
  const pending = h.logs.find((entry) => entry.message === 'resource or usage recovery remains pending');
  assert.ok(pending);
  assert.ok(pending.details['diagnostic'] !== undefined, 'the underlying problem is no longer dropped');
  assert.deepEqual(h.terminated, ['vm-lost']);
  assert.ok(!JSON.stringify(h.logs).includes('secret-provider-detail'), 'raw provider messages stay out of the log');
});

test('a completed recovery clears the attempt counter', async () => {
  const h = fixture();
  h.record()['recoveryAttempts'] = 3;
  const claimed = await h.sessions.claim('successor');
  assert.ok(claimed);
  await h.sessions.detachSandbox('s', { sessionId: 's', runnerId: 'successor', token: claimed.leaseToken });
  assert.equal(h.record()['recoveryAttempts'], undefined);
  assert.equal(h.record()['sandboxId'], undefined);
});
