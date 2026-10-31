import { fixtureModels } from './support/models.ts';
import { TaskTracker } from '../src/runner/task-context.ts';
import { verifyFallbackModel } from '../src/sessions/fallback.ts';
import { AnthropicProvider } from '../src/models/provider.ts';
import { computerToolset } from '../src/runner/computer.ts';
import { SessionRunner, type RunnerDependencies } from '../src/runner/loop.ts';
import { SandboxService } from '../src/sandboxes/service.ts';
import type { RunningSandbox, SandboxAdapter } from '../src/sandboxes/provider.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Timestamp } from 'firebase-admin/firestore';
import type Anthropic from '@anthropic-ai/sdk';
import { ResolvedEntitlements, type EntitlementService, type UserEntitlements } from '../src/entitlements/service.ts';
import { parsePlan, parseRegistry } from '../src/entitlements/schema.ts';
import { parseFallbackPolicy, policyFingerprint } from '../src/entitlements/fallback.ts';
import type { ConfigurationStore } from '../src/entitlements/store.ts';
import { registryDocument, planDocuments } from '../src/seed/config.ts';
import { MeteringService } from '../src/metering/service.ts';
import { periodStartFor, periodEndFor } from '../src/metering/periods.ts';
import { ProjectRepository } from '../src/projects/repository.ts';
import type { UserRepository } from '../src/users/repository.ts';
import { SessionRepository, type BuildSession, type SessionLease } from '../src/sessions/repository.ts';
import { contextFingerprint, parseCheckpoint, serializeCheckpoint, retainCheckpointImages, screenshotCheckpointRetentionMs, type ContinuationCheckpoint } from '../src/runner/continuation.ts';
import { createCallAdmission } from '../src/runner/call-admission.ts';
import { ledger } from './support/ledger.ts';

// Deliberately synthetic test policy. Nothing here seeds or activates a live model or allowance.
const policy = { provider: 'anthropic' as const, model: 'synthetic-fallback', effort: 'low' as const, eligiblePlanKeys: ['business'],
  inputTokenMeterKey: 'test.fallback.input', outputTokenMeterKey: 'test.fallback.output', maxPremiumDispatches: 2,
  capacityRetrySeconds: 5, maxCheckpointBytes: 100000, maxOutputTokens: 10 };
const checkpoint = (): ContinuationCheckpoint => ({ protocol: 1, conversation: [{ role: 'user', content: 'Build' }], spoken: [],
  completedSteps: 1, consultations: 1, maxOutputTokens: 20, maxSteps: 4, maxConsultations: 3,
  request: { model: 'synthetic-premium', system: 'policy', tools: [] }, contextFingerprint: contextFingerprint('policy', []) });

function fixture(premiumInputLimit?: number) {
  const { db, data } = ledger();
  const registry = parseRegistry({ ...registryDocument, fallback: policy, meters: [...registryDocument.meters,
    ...[policy.inputTokenMeterKey, policy.outputTokenMeterKey].map((key) => ({ key, unit: 'tokens', kind: 'COUNTER', resetPeriod: 'MONTHLY', label: key })),
  ] }, 'test.registry');
  const source = planDocuments.find((plan) => plan.key === 'business')!;
  const plan = parsePlan({ ...source, meterLimits: [...source.meterLimits.map((limit) => premiumInputLimit !== undefined && limit.meterKey === registry.inputTokenMeterKey ? { ...limit, hardLimit: premiumInputLimit, includedAllowance: premiumInputLimit } : limit),
    ...[policy.inputTokenMeterKey, policy.outputTokenMeterKey].map((meterKey) => ({ meterKey, includedAllowance: 1000, hardLimit: 1000, overageEnabled: false })),
  ] }, 'test.plan', registry);
  const entitlements: UserEntitlements = { planKey: plan.key, planName: plan.name, capabilities: new ResolvedEntitlements(plan.entitlements),
    meterLimits: plan.meterLimits, rateLimits: plan.rateLimits, subscriptionStatus: undefined };
  const configuration = { get: async () => ({ registry, plans: new Map([[plan.key, plan]]) }) } as unknown as ConfigurationStore;
  const service = { forUser: async () => entitlements } as unknown as EntitlementService;
  const metering = new MeteringService(db, configuration);
  const projects = new ProjectRepository(db, {} as UserRepository, service);
  const sessions = new SessionRepository(db, projects, service, configuration, metering, 60);
  const create = async (projectId: string) => {
    data.set(`projects/${projectId}`, { ownerUid: 'u', name: projectId, platform: 'web', status: 'draft', activeSessionId: null, snapshotBytes: 0, createdAt: Timestamp.now() });
    const model = entitlements.capabilities.stringList('ai.model.allowlist')[0]; assert.ok(model);
    return sessions.create('u', projectId, { prompt: 'Build', model });
  };
  const pause = async (session: BuildSession, status: 'AWAITING_CONSENT' | 'EXHAUSTED' = 'AWAITING_CONSENT') => {
    const claimed = await sessions.claim('initial'); assert.equal(claimed?.id, session.id); assert.ok(claimed);
    const authority = { sessionId: session.id, runnerId: 'initial', token: claimed.leaseToken };
    await sessions.pauseContinuation(authority, checkpoint(), { status, reason: 'Synthetic quota boundary', offer: {
      model: policy.model, effort: policy.effort, inputTokens: 5, maxOutputTokens: policy.maxOutputTokens, maxInputTokens: 10000, policyFingerprint: policyFingerprint(policy),
    } });
    const waiting = await sessions.readOwned('u', session.id); assert.ok(waiting.fallback?.checkpointId);
    return { authority, waiting, input: { checkpointId: waiting.fallback.checkpointId, model: policy.model, effort: policy.effort } };
  };
  const usage = (key: string, consumed: number, reserved = 0, at = new Date()) => {
    const meter = registry.meters.get(key)!;
    data.set(`users/u/usage/${key}`, { meterKey: key, consumed, reserved, periodStart: Timestamp.fromDate(periodStartFor(meter, at)) });
  };
  return { db, data, registry, entitlements, metering, sessions, projects, configuration, service, create, pause, usage };
}

test('fallback has no default policy or invented model and rejects premium meter reuse', () => {
  const h = fixture();
  assert.equal(parseRegistry(registryDocument, 'registry').fallback, undefined);
  assert.throws(() => parseFallbackPolicy({ ...policy, inputTokenMeterKey: h.registry.inputTokenMeterKey }, 'fallback', h.registry.meters, [h.registry.inputTokenMeterKey]));
  assert.throws(() => parseFallbackPolicy({ provider: 'anthropic' }, 'fallback', h.registry.meters, []));
});

test('separate fallback consent is atomic and idempotent even when premium token allowance is exhausted', async () => {
  const h = fixture(); const session = await h.create('p'); const paused = await h.pause(session);
  for (const key of [h.registry.inputTokenMeterKey, h.registry.outputTokenMeterKey]) h.usage(key, h.entitlements.meterLimits.get(key)!.hardLimit);
  const before = h.data.get(`users/u/usage/${h.registry.buildMeterKey}`)?.['consumed'];
  const accepted = await Promise.all(Array.from({ length: 5 }, () => h.sessions.acceptFallback('u', session.id, 'stable-fallback-consent', paused.input)));
  assert.ok(accepted.every((result) => result.id === session.id && result.status === 'QUEUED'));
  assert.equal(h.data.get(`users/u/usage/${h.registry.buildMeterKey}`)?.['consumed'], before);
  await assert.rejects(h.sessions.acceptFallback('u', session.id, 'stable-fallback-consent', { ...paused.input, model: 'substitution' }), { code: 'request/idempotency-conflict' });
  await assert.rejects(h.sessions.acceptFallback('other', session.id, 'stable-fallback-consent', paused.input), { code: 'session/not-found' });
  const claimed = await h.sessions.claim('fallback-worker'); assert.ok(claimed); assert.equal(claimed.id, session.id);
  const restored = await h.sessions.readContinuation({ sessionId: session.id, runnerId: 'fallback-worker', token: claimed.leaseToken });
  assert.equal(restored.completedSteps, 1); assert.equal(restored.consultations, 1);
});

test('waiting fallback work is admitted after the configured number of premium claims', async () => {
  const h = fixture(); const target = await h.create('fallback-project'); const paused = await h.pause(target);
  await h.sessions.acceptFallback('u', target.id, 'stable-fairness-consent', paused.input);
  const premiums = await Promise.all(['p1', 'p2', 'p3'].map(h.create));
  const claimed: Awaited<ReturnType<SessionRepository['claim']>>[] = [];
  for (let index = 0; index < 3; index++) claimed.push(await h.sessions.claim(`worker-${index}`));
  assert.ok(premiums.some((session) => session.id === claimed[0]?.id));
  assert.ok(premiums.some((session) => session.id === claimed[1]?.id));
  assert.equal(claimed[2]?.id, target.id);
});

test('temporary shared concurrency keeps accepted continuation queued and cancellation never refunds its original build', async () => {
  const h = fixture(); const session = await h.create('p'); const paused = await h.pause(session);
  const key = h.registry.sandboxProviders.get('web')!.concurrencyMeterKey;
  h.usage(key, 0, h.entitlements.meterLimits.get(key)!.hardLimit);
  const before = h.data.get(`users/u/usage/${h.registry.buildMeterKey}`)?.['consumed'];
  const accepted = await h.sessions.acceptFallback('u', session.id, 'stable-capacity-consent', paused.input);
  assert.equal(accepted.status, 'QUEUED'); assert.equal(accepted.fallback?.status, 'CAPACITY_WAIT');
  assert.equal(await h.sessions.claim('early'), undefined);
  await h.sessions.cancel('u', session.id, 'stable-cancel-fallback');
  assert.equal(h.data.get(`users/u/usage/${h.registry.buildMeterKey}`)?.['consumed'], before);
  assert.equal(await h.sessions.claim('after-cancel', new Date(Date.now() + 10000)), undefined);
});

test('fallback and shared counter exhaustion remain paused rather than spending the wrong allowance', async () => {
  for (const shared of [false, true]) {
    const h = fixture(); const session = await h.create('p'); const paused = await h.pause(session);
    const key = shared ? h.registry.sandboxTimeMeterKey : policy.inputTokenMeterKey;
    h.usage(key, h.entitlements.meterLimits.get(key)!.hardLimit);
    const accepted = await h.sessions.acceptFallback('u', session.id, 'stable-exhausted-consent', paused.input);
    assert.equal(accepted.status, 'IDLE'); assert.equal(accepted.fallback?.status, shared ? 'SHARED_LIMIT' : 'EXHAUSTED');
    assert.equal(await h.sessions.claim('no-spend'), undefined);
  }
});

test('calendar rollover releases spent fallback quota but does not reset outstanding reservations', async () => {
  const h = fixture(); const session = await h.create('p'); const paused = await h.pause(session);
  h.usage(policy.inputTokenMeterKey, 1000, 1000, new Date('2020-01-01T00:00:00Z'));
  const held = await h.sessions.acceptFallback('u', session.id, 'rollover-held-command', paused.input);
  assert.equal(held.fallback?.status, 'EXHAUSTED');
  h.usage(policy.inputTokenMeterKey, 1000, 0, new Date('2020-01-01T00:00:00Z'));
  const renewed = await h.sessions.acceptFallback('u', session.id, 'rollover-ready-command', paused.input);
  assert.equal(renewed.status, 'QUEUED');
});

test('dispatch and specialist output holds debit fallback meters without resetting premium usage', async () => {
  const h = fixture(); const session = await h.create('p'); const paused = await h.pause(session);
  await h.sessions.acceptFallback('u', session.id, 'stable-metering-consent', paused.input);
  const claimed = await h.sessions.claim('worker'); assert.ok(claimed);
  const authority: SessionLease = { sessionId: session.id, runnerId: 'worker', token: claimed.leaseToken };
  const reservations = {
    take: (input: { meterKey: string; quantity: number; operationId: string }) => h.sessions.reserveSpecialistTokens(session.id, 'worker', { ...input, entitlements: h.entitlements, leaseToken: authority.token, now: new Date() }),
    forget: (id: string) => h.sessions.forgetSpecialistReservation(session.id, authority, id),
  };
  const admission = createCallAdmission({ models: fixtureModels, anthropic: { messages: { countTokens: async () => ({ input_tokens: 5 }) } } as unknown as Anthropic,
    uid: 'u', sessionId: session.id, inputMeterKey: policy.inputTokenMeterKey, outputMeterKey: policy.outputTokenMeterKey,
    metering: h.metering, reservations, authorize: () => h.sessions.assertPersistenceLease(authority), onProblem: () => {} });
  const call = await admission.begin({ effort: 'standard', params: { model: policy.model, messages: checkpoint().conversation }, maxOutputTokens: 10, signal: new AbortController().signal });
  await call.settle({ input: 5, output: 3 });
  assert.equal(h.data.get(`users/u/usage/${policy.inputTokenMeterKey}`)?.['consumed'], 5);
  assert.equal(h.data.get(`users/u/usage/${policy.outputTokenMeterKey}`)?.['consumed'], 3);
  assert.equal(h.data.has(`users/u/usage/${h.registry.inputTokenMeterKey}`), false);
  const specialist = await reservations.take({ meterKey: policy.outputTokenMeterKey, quantity: 20, operationId: 'specialist' });
  assert.equal(specialist.meterKey, policy.outputTokenMeterKey);
});

test('an uncertain in-flight reservation prevents committing a resumable checkpoint', async () => {
  const h = fixture(); const session = await h.create('p'); const claim = await h.sessions.claim('worker'); assert.ok(claim);
  const authority = { sessionId: session.id, runnerId: 'worker', token: claim.leaseToken };
  const hold = await h.sessions.reserveSpecialistTokens(session.id, 'worker', { meterKey: h.registry.outputTokenMeterKey, quantity: 10, operationId: 'uncertain', leaseToken: authority.token, entitlements: h.entitlements, now: new Date() });
  await h.metering.markInFlight('u', [hold.id]);
  await assert.rejects(h.sessions.pauseContinuation(authority, checkpoint(), { status: 'AWAITING_CONSENT', reason: 'Quota' }));
  assert.equal((await h.sessions.readOwned('u', session.id)).status, 'RUNNING');
  assert.equal([...h.data.keys()].some((key) => key.includes('/continuations/')), false);
  assert.equal((await h.metering.reservationRecord('u', hold.id))['status'], 'OPEN');
});

test('workspace changes invalidate consent and a stale worker cannot write a checkpoint', async () => {
  const h = fixture(); const session = await h.create('p'); const paused = await h.pause(session);
  h.data.set('projects/p', { ...h.data.get('projects/p'), snapshotBytes: 10, snapshotObjectName: 'changed', snapshotObjectGeneration: '1' });
  assert.equal((await h.sessions.readOwned('u', session.id)).fallback?.resumable, false);
  await assert.rejects(h.sessions.acceptFallback('u', session.id, 'stable-stale-consent', paused.input), { code: 'fallback/checkpoint-stale' });
  await assert.rejects(h.sessions.pauseContinuation(paused.authority, checkpoint(), { status: 'AWAITING_CONSENT', reason: 'Stale worker' }), { code: 'session/lease-lost' });
});

test('opaque provider state and unresolved actions cannot become portable checkpoints', () => {
  const value = checkpoint(); assert.equal(parseCheckpoint(serializeCheckpoint(value, 100000), 100000).completedSteps, 1);
  assert.throws(() => serializeCheckpoint({ ...value, conversation: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'pending', name: 'run_command', input: {}, caller: { type: 'direct' } }] }] }, 100000), /unresolved/);
  assert.throws(() => serializeCheckpoint({ ...value, conversation: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'opaque', signature: 'provider-signature' }] }] }, 100000), /cannot safely switch/);
  assert.throws(() => serializeCheckpoint(value, 10), /storage budget/);
});

test('reset timestamps use the metering system’s UTC calendar boundaries', () => {
  const h = fixture(); const meter = h.registry.meters.get(policy.inputTokenMeterKey)!;
  assert.equal(periodEndFor(meter, new Date('2026-12-31T23:59:59Z'))?.toISOString(), '2027-01-01T00:00:00.000Z');
  assert.equal(periodEndFor({ ...meter, resetPeriod: 'DAILY' }, new Date('2026-10-31T23:59:59Z'))?.toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal(periodEndFor({ ...meter, resetPeriod: 'NEVER' }, new Date()), undefined);
});


test('the real worker pauses at quota, releases resources, and a replacement worker continues without repeating completed tools', async () => {
  const h = fixture(5); const session = await h.create('p');
  let reads = 0; let starts = 0; const generations: string[] = [];
  const adapter: SandboxAdapter = {
    start: async (_provider, context) => {
      const running: RunningSandbox = { externalId: `vm-${++starts}`,
        lifetime: async () => ({ startedAt: new Date(Date.now() - 1000), endAt: new Date(Date.now() + 59000) }),
        readFile: async () => { reads++; return 'Verified tool result'; }, writeFile: async () => {},
        runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }), stopCommands: async () => {}, stop: async () => {}, previewUrl: () => 'https://preview.invalid' };
      await context.lifecycle!.beforeCreate(); await context.lifecycle!.created(running); return running;
    }, connect: async () => undefined, terminate: async () => true,
  };
  const anthropic = { models: { retrieve: async () => ({ id: policy.model, capabilities: { effort: { low: { supported: true } }, image_input: { supported: false } }, max_input_tokens: 100000, max_tokens: 1000 }) },
    messages: { countTokens: async () => ({ input_tokens: 5 }), stream: (params: { model: string; messages: unknown[] }) => {
      generations.push(params.model);
      if (params.model === policy.model) assert.ok(JSON.stringify(params.messages).includes('Verified tool result'));
      return { on: () => {}, finalMessage: async () => ({ content: params.model === policy.model ? [{ type: 'text', text: 'Completed from the saved tool result.' }, { type: 'tool_use', id: 'finish-continuation', name: 'finish_task', input: { outcome: 'completed', summary: 'Completed from the saved tool result.', evidence: ['read-once'] }, caller: { type: 'direct' } }]
        : [{ type: 'tool_use', id: 'read-once', name: 'read_file', input: { path: 'README.md' }, caller: { type: 'direct' } }], usage: { input_tokens: 5, output_tokens: 1 }, stop_reason: 'end_turn' }) };
    } },
  } as unknown as Anthropic;
  const dependencies = { anthropic, models: fixtureModels, sessions: h.sessions, projects: h.projects, configuration: h.configuration,
    entitlements: h.service, metering: h.metering, sandboxes: new SandboxService(h.configuration, h.metering, new Map([['e2b', adapter]])),
    // This scenario only reads files. Snapshot save/restore correctness is covered by workspace-salvage tests.
    persistence: { restore: async () => 'fresh', save: async () => ({ bytes: 0, committed: false }) },
    events: { subscribe: async () => () => {}, append: async () => {} },
    limits: { maxSteps: 4, maxOutputTokens: 20, toolOutputMaxChars: 5000, maxSpecialistConsultations: 0, specialistMaxSteps: 1, commandTimeoutMs: 1000, previewReadyTimeoutSeconds: 1 },
    heartbeatSeconds: 60, messageHistoryLimit: 100, log: { info: () => {}, warn: () => {}, error: () => {} },
  };
  await new SessionRunner({ ...dependencies, runnerId: 'premium-worker' } as unknown as RunnerDependencies).runOnce();
  const paused = await h.sessions.readOwned('u', session.id);
  assert.equal(paused.status, 'IDLE'); assert.equal(paused.fallback?.status, 'AWAITING_CONSENT');
  assert.equal(paused.sandboxId, undefined); assert.equal(reads, 1); assert.equal(generations.length, 1);
  const checkpointId = paused.fallback?.checkpointId; assert.ok(checkpointId);
  await h.sessions.acceptFallback('u', session.id, 'worker-fallback-consent', { checkpointId, model: policy.model, effort: policy.effort });
  await new SessionRunner({ ...dependencies, runnerId: 'replacement-worker' } as unknown as RunnerDependencies).runOnce();
  const finished = await h.sessions.readOwned('u', session.id);
  assert.equal(finished.status, 'IDLE'); assert.equal(finished.fallback?.status, 'COMPLETED');
  assert.equal(reads, 1); assert.equal(starts, 2); assert.equal(generations.length, 2); assert.equal(generations[1], policy.model);
  assert.equal(h.data.get(`users/u/usage/${h.registry.buildMeterKey}`)?.['consumed'], 1);
  assert.equal(h.data.get(`users/u/usage/${h.registry.inputTokenMeterKey}`)?.['consumed'], 5);
  assert.equal(h.data.get(`users/u/usage/${policy.inputTokenMeterKey}`)?.['consumed'], 5);
  assert.equal(h.data.has(`sessions/${session.id}/continuations/active`), false);
});


test('fallback capability checks reject missing metadata, aliases, incompatible tools and oversized context before offering a model', async () => {
  const h = fixture(); const provider = h.registry.sandboxProviders.get('web')!;
  const metadata = { id: policy.model, capabilities: { effort: { low: { supported: true } }, image_input: { supported: true } }, max_input_tokens: 1000, max_tokens: 100 };
  const verify = (model: unknown, count = 5, value = checkpoint(), executionProvider = provider) => verifyFallbackModel(new AnthropicProvider({ models: { retrieve: async () => model }, messages: { countTokens: async () => ({ input_tokens: count }) } } as unknown as Anthropic, fixtureModels),
    policy, value, executionProvider, 'standard', 20, new AbortController().signal);
  assert.equal((await verify(metadata)).model, policy.model);
  await assert.rejects(verify({ ...metadata, capabilities: null }));
  await assert.rejects(verify({ ...metadata, id: 'different-model' }));
  await assert.rejects(verify({ ...metadata, max_tokens: 1 }));
  await assert.rejects(verify(metadata, 1001));
  await assert.rejects(verify(metadata, 5, { ...checkpoint(), request: { ...checkpoint().request, tools: [computerToolset] } },
    { ...provider, desktop: { width: 1280, height: 720, computerModels: [] } }));
  const images: ContinuationCheckpoint = { ...checkpoint(), conversation: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] }] };
  await assert.rejects(verify({ ...metadata, capabilities: { ...metadata.capabilities, image_input: { supported: false } } }, 5, images));
  const retained = retainCheckpointImages(images);
  assert.equal(parseCheckpoint(serializeCheckpoint(retained, 100000), 100000).imageExpiresAt, retained.imageExpiresAt);
  assert.doesNotThrow(() => serializeCheckpoint({ ...checkpoint(), contextFingerprint: contextFingerprint(checkpoint().request.system, [computerToolset]), request: { ...checkpoint().request, tools: [computerToolset] } }, 100000));
});

test('a task can explicitly retry its original model after reset without inheriting fallback spending', async () => {
  const h = fixture(); const session = await h.create('p'); const paused = await h.pause(session);
  h.usage(h.registry.inputTokenMeterKey, h.entitlements.meterLimits.get(h.registry.inputTokenMeterKey)!.hardLimit, 0, new Date('2020-01-01T00:00:00Z'));
  const resumed = await h.sessions.acceptFallback('u', session.id, 'stable-original-model-retry', { ...paused.input, model: session.model, effort: session.effort, lane: 'premium' });
  assert.equal(resumed.status, 'QUEUED'); assert.equal(resumed.fallback?.lane, 'premium'); assert.equal(resumed.fallback?.consent, undefined);
  const claimed = await h.sessions.claim('premium-resume-worker'); assert.equal(claimed?.id, session.id);
  assert.equal(h.data.has(`users/u/usage/${policy.inputTokenMeterKey}`), false);
  assert.equal(h.data.get(`users/u/usage/${h.registry.buildMeterKey}`)?.['consumed'], 1);
});

test('fallback consent racing explicit cancellation cannot resurrect a cancelled task or refund a completed build', async () => {
  for (let attempt = 0; attempt < 4; attempt++) {
    const h = fixture(); const session = await h.create('p'); const paused = await h.pause(session);
    await Promise.allSettled([h.sessions.acceptFallback('u', session.id, 'race-consent-command', paused.input), h.sessions.cancel('u', session.id, 'race-cancel-command')]);
    assert.equal((await h.sessions.readOwned('u', session.id)).status, 'FAILED');
    assert.equal(await h.sessions.claim('late-worker'), undefined);
    assert.equal(h.data.get(`users/u/usage/${h.registry.buildMeterKey}`)?.['consumed'], 1);
  }
});


test('screenshot deadlines are bounded, never renewed, and expired context cannot be reused', () => {
  const images: ContinuationCheckpoint = { ...checkpoint(), conversation: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] }] };
  const first = retainCheckpointImages(images);
  assert.equal(Date.parse(first.imageExpiresAt!) - Date.parse(first.imageRetainedAt!), screenshotCheckpointRetentionMs);
  assert.equal(retainCheckpointImages(first, new Date(Date.now() + 3600000)).imageExpiresAt, first.imageExpiresAt);
  const expired = retainCheckpointImages(images, new Date(Date.now() - screenshotCheckpointRetentionMs - 1000));
  assert.throws(() => serializeCheckpoint(expired, 100000), { code: 'fallback/image-context-expired' });
  assert.throws(() => serializeCheckpoint({ ...first, imageExpiresAt: new Date(Date.parse(first.imageRetainedAt!) + screenshotCheckpointRetentionMs + 1).toISOString() }, 100000));
});

test('retention sweep deletes screenshot payload and unschedules the affected task without client input', async () => {
  const h = fixture(); const session = await h.create('image-retention'); const paused = await h.pause(session);
  const deadline = new Date(Date.now() - 1000);
  const saved = h.data.get(`sessions/${session.id}/continuations/active`)!;
  h.data.set(`sessions/${session.id}/continuations/active`, { ...saved, imageExpiresAt: Timestamp.fromDate(deadline) });
  const state = h.data.get(`sessions/${session.id}`)!;
  h.data.set(`sessions/${session.id}`, { ...state, fallback: { ...paused.waiting.fallback, imageExpiresAt: deadline.toISOString() } });
  assert.equal((await h.sessions.readOwned('u', session.id)).fallback?.resumable, false);
  await h.sessions.assertContinuationRetentionReady(); await h.sessions.collectExpiredContinuations();
  assert.equal(h.data.has(`sessions/${session.id}/continuations/active`), false);
  const current = await h.sessions.readOwned('u', session.id);
  assert.equal(current.status, 'IDLE'); assert.equal(current.fallback?.status, 'UNAVAILABLE');
  assert.equal(await h.sessions.claim('after-expiry'), undefined);
});

test('explicit cancellation removes the saved continuation payload immediately', async () => {
  const h = fixture(); const session = await h.create('image-cancel'); await h.pause(session);
  await h.sessions.cancel('u', session.id, 'cancel-saved-context');
  assert.equal(h.data.has(`sessions/${session.id}/continuations/active`), false);
});


test('private working context is durably owned and fenced by the existing session lease', async () => {
  const h=fixture(); const session=await h.create('task-context');
  const claimed=await h.sessions.claim('context-worker'); assert.ok(claimed);
  const authority={sessionId:session.id,runnerId:'context-worker',token:claimed.leaseToken};
  const tracker=new TaskTracker('Keep the authorized goal'); tracker.record('inspect','read_file',{}, {text:'Observed project file',isError:false});
  await h.sessions.saveTaskContext(authority,tracker.state);
  assert.deepEqual((await h.sessions.readOwned('u',session.id)).taskContext,tracker.state);
  await assert.rejects(h.sessions.readOwned('another-user',session.id),{code:'session/not-found'});
  await assert.rejects(h.sessions.saveTaskContext({...authority,token:'stale'},tracker.state));
  assert.deepEqual((await h.sessions.readOwned('u',session.id)).taskContext,tracker.state);
});
