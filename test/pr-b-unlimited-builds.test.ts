import assert from 'node:assert/strict';
import test from 'node:test';
import { Timestamp } from 'firebase-admin/firestore';
import { parseRegistry, parsePlan, unlimitedPresentation } from '../src/entitlements/schema.ts';
import { ResolvedEntitlements, type EntitlementService, type UserEntitlements } from '../src/entitlements/service.ts';
import type { ConfigurationStore } from '../src/entitlements/store.ts';
import { registryDocument, planDocuments } from '../src/seed/config.ts';
import { MeteringService } from '../src/metering/service.ts';
import { ProjectRepository } from '../src/projects/repository.ts';
import { SessionRepository } from '../src/sessions/repository.ts';
import type { UserRepository } from '../src/users/repository.ts';
import { presentedLimits } from '../src/server.ts';
import { ledger } from './support/ledger.ts';

/** Real repositories and metering on the ledger fake; only the plan document varies. */
function fixture(planKey = 'free', withoutBuildRow = false) {
  const { db, data } = ledger();
  const registry = parseRegistry(registryDocument, 'registry');
  const rows = (planDocuments as readonly unknown[] as readonly { key: string; meterLimits: readonly { meterKey: string }[] }[]).map((row) => row.key !== planKey || !withoutBuildRow ? row
    : { ...row, meterLimits: row.meterLimits.filter((limit) => limit.meterKey !== registry.buildMeterKey) });
  const plans = new Map(rows.map((row) => [row.key, parsePlan(row, row.key, registry)]));
  const plan = plans.get(planKey)!;
  const entitlements = { planKey: plan.key, planName: plan.name, capabilities: new ResolvedEntitlements(plan.entitlements),
    meterLimits: plan.meterLimits, rateLimits: plan.rateLimits } as UserEntitlements;
  const configuration = { get: async () => ({ registry, plans }) } as unknown as ConfigurationStore;
  const entitlementService = { forUser: async () => entitlements } as unknown as EntitlementService;
  const metering = new MeteringService(db, configuration);
  const projects = new ProjectRepository(db, {} as UserRepository, entitlementService);
  const sessions = new SessionRepository(db, projects, entitlementService, configuration, metering, 120);
  const model = entitlements.capabilities.stringList('ai.model.allowlist')[0]!;
  let n = 0;
  const newProject = () => { n++; data.set(`projects/p${n}`, { ownerUid: 'u', platform: 'web', name: `P${n}`, status: 'draft', activeSessionId: null, snapshotBytes: 0, createdAt: Timestamp.now(), visibility: 'private' }); return `p${n}`; };
  const builds = () => data.get(`users/u/usage/${registry.buildMeterKey}`)?.['consumed'] as number | undefined;
  return { data, registry, plan, entitlements, metering, sessions, model, newProject, builds };
}

test('a Free user starts more builds than the old hard limit; every build is still counted', async () => {
  const f = fixture('free');
  const oldLimit = f.plan.meterLimits.get(f.registry.buildMeterKey)!.hardLimit;
  assert.equal(oldLimit, 10, 'the seed still carries the historical row the config edit will retire');
  for (let i = 0; i < oldLimit + 2; i++) {
    await f.sessions.create('u', f.newProject(), { model: f.model, effort: 'low', prompt: `build ${i}`, attachments: [] });
  }
  assert.equal(f.builds(), oldLimit + 2);
});

test('a plan document without any build limit row still counts builds and never fails admission', async () => {
  const f = fixture('pro', true);
  assert.equal(f.plan.meterLimits.get(f.registry.buildMeterKey), undefined);
  await f.sessions.create('u', f.newProject(), { model: f.model, effort: 'low', prompt: 'build', attachments: [] });
  await f.sessions.create('u', f.newProject(), { model: f.model, effort: 'low', prompt: 'build', attachments: [] });
  assert.equal(f.builds(), 2);
  // Cancelling a queued build refunds its count without needing a limit row either.
  const sessionId = [...f.data.keys()].find((path) => /^sessions\/[^/]+$/.test(path))!.split('/')[1]!;
  await f.sessions.cancel('u', sessionId);
  assert.equal(f.builds(), 1);
});

test('exhausted paid resources still refuse: AI tokens, sandbox time and concurrency are admitted as before', async () => {
  const f = fixture('free');
  const now = new Date();
  const input = f.registry.inputTokenMeterKey;
  const limit = f.entitlements.meterLimits.get(input)!.hardLimit;
  await assert.rejects(f.metering.assertAvailable({ uid: 'u', entitlements: f.entitlements, meterKey: input, quantity: limit + 1, now }), { code: 'usage/limit-reached' });
  const sandbox = f.registry.sandboxTimeMeterKey;
  const sandboxLimit = f.entitlements.meterLimits.get(sandbox)!.hardLimit;
  await assert.rejects(f.metering.assertAvailable({ uid: 'u', entitlements: f.entitlements, meterKey: sandbox, quantity: sandboxLimit + 1, now }), { code: 'usage/limit-reached' });
  const concurrency = f.registry.sandboxProviders.get('web')!.concurrencyMeterKey;
  const concurrencyLimit = f.entitlements.meterLimits.get(concurrency)!.hardLimit;
  await assert.rejects(f.metering.assertAvailable({ uid: 'u', entitlements: f.entitlements, meterKey: concurrency, quantity: concurrencyLimit + 1, now }), { code: 'usage/limit-reached' });
});

test('the build rate limit class and queue depth remain in force as abuse protection', async () => {
  const f = fixture('free');
  assert.deepEqual(f.plan.rateLimits.get('build'), { routeClass: 'build', maxRequests: 3, windowSeconds: 60 });
  const g = fixture('pro', true);
  // Without a build row the queue falls back to the default depth rather than becoming unbounded.
  const projectId = g.newProject();
  const session = await g.sessions.create('u', projectId, { model: g.model, effort: 'low', prompt: 'first', attachments: [] });
  // Make the session active so further prompts queue instead of starting a turn.
  g.data.get(`sessions/${session.id}`)!['status'] = 'RUNNING';
  g.data.get(`sessions/${session.id}`)!['claimedBy'] = 'runner';
  g.data.get(`sessions/${session.id}`)!['heartbeatAt'] = Timestamp.now();
  let queued = 0;
  for (let i = 0; i < 40; i++) {
    try { await g.sessions.submitMessage('u', session.id, `queued ${i}`, false, undefined, 'enqueue'); queued++; }
    catch (error) { assert.equal((error as { code?: string }).code, 'session/queue-full'); break; }
  }
  assert.equal(queued, 25);
});

test('customers see builds as counted with no limit, whatever row the plan document carries', async () => {
  const f = fixture('free');
  await f.sessions.create('u', f.newProject(), { model: f.model, effort: 'low', prompt: 'build', attachments: [] });
  const usage = await f.metering.readUsageBreakdown('u', f.entitlements);
  const builds = usage.find((entry) => entry.meterKey === f.registry.buildMeterKey)!;
  assert.deepEqual([builds.consumed, builds.includedAllowance, builds.hardLimit, builds.overageEnabled], [1, 0, 0, false]);
  const ai = usage.find((entry) => entry.meterKey === f.registry.inputTokenMeterKey)!;
  assert.equal(ai.hardLimit, f.entitlements.meterLimits.get(f.registry.inputTokenMeterKey)!.hardLimit, 'other meters are presented exactly as before');
  const limits = presentedLimits(f.entitlements, f.registry.buildMeterKey);
  assert.deepEqual(limits.find((limit) => limit.meterKey === f.registry.buildMeterKey), unlimitedPresentation(f.registry.buildMeterKey));
  assert.equal(limits.length, f.entitlements.meterLimits.size);
  // A plan without the row still lists builds in usage, as used-so-far.
  const g = fixture('pro', true);
  const listed = (await g.metering.readUsageBreakdown('u', g.entitlements)).find((entry) => entry.meterKey === g.registry.buildMeterKey);
  assert.deepEqual([listed?.consumed, listed?.hardLimit], [0, 0]);
});
