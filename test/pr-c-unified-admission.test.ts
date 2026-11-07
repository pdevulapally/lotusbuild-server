import assert from 'node:assert/strict';
import test from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import type { ContentBlock, MessageStreamEvent } from '@anthropic-ai/sdk/resources/messages';
import { Timestamp, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { aiRatesV1Document, parseAiRateTable, unifiedFor, type AiRateTable } from '../src/entitlements/rates.ts';
import { parseRegistry, parsePlan, parseAiUnifiedPolicy, type Registry } from '../src/entitlements/schema.ts';
import type { FallbackPolicy } from '../src/entitlements/fallback.ts';
import { ConfigurationStore } from '../src/entitlements/store.ts';
import { ResolvedEntitlements, type EntitlementService, type UserEntitlements } from '../src/entitlements/service.ts';
import { registryDocument, planDocuments } from '../src/seed/config.ts';
import { MeteringService } from '../src/metering/service.ts';
import { ProjectRepository } from '../src/projects/repository.ts';
import { SessionRepository } from '../src/sessions/repository.ts';
import type { UserRepository } from '../src/users/repository.ts';
import { createCallAdmission, unifiedEstimate } from '../src/runner/call-admission.ts';
import { promptWeightCeiling, tierFor } from '../src/entitlements/rates.ts';
import { unifiedHoldKind } from '../src/metering/service.ts';
import { promptCacheTtl } from '../src/runner/agent.ts';
import { runAgentTurn } from '../src/runner/agent.ts';
import { fallbackLaneRegistry, unifiedAdmissionFor } from '../src/runner/loop.ts';
import { AppError } from '../src/http/errors.ts';
import { EntitlementConfigError } from '../src/entitlements/values.ts';
import type { RunningSandbox } from '../src/sandboxes/provider.ts';
import { ledger } from './support/ledger.ts';

const v1 = parseAiRateTable(aiRatesV1Document, 'test');
const unifiedMeterKey = 'ai.unified';
const unifiedRegistryDocument = { ...registryDocument, aiUnified: { meterKey: unifiedMeterKey } };
const models = { get: async (id: string) => ({ id, name: id, efforts: [], maxOutputTokens: 4096 }) };
const march = new Date('2026-03-31T23:50:00Z');
const april = new Date('2026-04-01T00:10:00Z');

function entitlementsOf(plans: ReadonlyMap<string, ReturnType<typeof parsePlan>>, planKey: string): UserEntitlements {
  const plan = plans.get(planKey)!;
  return { planKey: plan.key, planName: plan.name, capabilities: new ResolvedEntitlements(plan.entitlements),
    meterLimits: plan.meterLimits, rateLimits: plan.rateLimits } as UserEntitlements;
}

function plansFor(registry: Registry) {
  return new Map(planDocuments.map((row) => [row.key, parsePlan(row, row.key, registry)]));
}

/** What the fake provider streams, finally reports, or throws. */
interface ProviderScript {
  readonly events?: readonly MessageStreamEvent[];
  readonly finalUsage?: Record<string, unknown>;
  readonly abortAfterEvents?: boolean;
  readonly throwBeforeStream?: unknown;
  readonly stopDuringCall?: boolean;
  readonly rates?: AiRateTable;
  readonly legacy?: boolean;
  readonly planKey?: string;
  readonly countedInput?: number;
  /** Archived rate tables by version; defaults to the current table alone. */
  readonly archive?: ReadonlyMap<string, AiRateTable>;
  /** Scripted provider replies, one per call in order; a call past the end gets the default reply. */
  readonly responses?: readonly { readonly content: ContentBlock[]; readonly usage: Record<string, unknown>; readonly stop_reason: string }[];
}

/** Real admission, agent, fenced session reservations, metering and session repository; fake only the ledger and SDK. */
async function unifiedFixture(provider: ProviderScript = {}) {
  const { db, data } = ledger();
  const registry = parseRegistry(provider.legacy ? registryDocument : unifiedRegistryDocument, 'registry');
  const plans = plansFor(registry);
  const entitlements = entitlementsOf(plans, provider.planKey ?? 'business');
  const rates = provider.rates ?? v1;
  const configuration = {
    get: async () => ({ registry, plans, rates }),
    // With an explicit archive, it alone says which versions are available (the real store also answers from the
    // current table when its version matches; a "v1 unavailable" scenario therefore means the current table moved on too).
    ratesByVersion: async (version: string) => { const table = provider.archive !== undefined ? provider.archive.get(version) : (version === rates.version ? rates : undefined); if (table === undefined) throw new Error(`no archived table ${version}`); return table; },
  } as unknown as ConfigurationStore;
  const entitlementService = { forUser: async () => entitlements } as unknown as EntitlementService;
  const metering = new MeteringService(db, configuration);
  const projects = new ProjectRepository(db, {} as UserRepository, entitlementService);
  const sessions = new SessionRepository(db, projects, entitlementService, configuration, metering, 120);
  data.set('projects/p', { ownerUid: 'u', platform: 'web', name: 'Fixture', status: 'draft', activeSessionId: 's', snapshotBytes: 0, createdAt: Timestamp.now() });
  data.set('sessions/s', { ownerUid: 'u', projectId: 'p', status: 'QUEUED', model: entitlements.capabilities.stringList('ai.model.allowlist')[0],
    effort: 'high', claimableAt: Timestamp.now(), messageCount: 1, createdAt: Timestamp.now() });
  const session = (await sessions.claim('runner'))!;
  const authority = { sessionId: 's', runnerId: 'runner', token: session.leaseToken! };
  const controller = new AbortController();
  const problems: { error: Error; what: string }[] = [];
  const onProblem = (error: Error, what: string) => { problems.push({ error, what }); };
  const order: string[] = [];
  let calls = 0;
  const streamed: { tools: readonly string[] }[] = [];
  const sdk = {
    countTokens: async () => ({ input_tokens: provider.countedInput ?? 10 }),
    stream: (params?: { tools?: readonly { name?: string }[] }) => {
      order.push('stream');
      const scripted = provider.responses?.[calls];
      calls++;
      streamed.push({ tools: (params?.tools ?? []).map((tool) => tool.name ?? '') });
      if (provider.throwBeforeStream !== undefined) throw provider.throwBeforeStream;
      const listeners: ((event: MessageStreamEvent) => void)[] = [];
      return {
        on: (event: string, listener: (event: MessageStreamEvent) => void) => { if (event === 'streamEvent') listeners.push(listener); },
        finalMessage: async (): Promise<{ content: ContentBlock[]; usage: Record<string, unknown>; stop_reason: string }> => {
          for (const event of provider.events ?? []) for (const listener of listeners) listener(event);
          if (provider.stopDuringCall === true) controller.abort(new AppError({ code: 'session/cancelled', statusCode: 409, message: 'Stopped.' }));
          if (provider.abortAfterEvents === true || provider.stopDuringCall === true) throw new Error('Request was aborted.');
          if (scripted !== undefined) return scripted;
          const finish = params?.tools?.some((tool) => tool.name === 'finish_task');
          return {
            content: [{ type: 'text', text: 'Done', citations: null }, ...(finish ? [{ type: 'tool_use' as const, id: 'finish', name: 'finish_task', input: { outcome: 'answered', summary: 'Done', evidence: [] }, caller: { type: 'direct' as const } }] : [])],
            usage: provider.finalUsage ?? { input_tokens: 7, output_tokens: 3 }, stop_reason: finish ? 'tool_use' : 'end_turn',
          };
        },
      };
    },
  };
  const mark = metering.markInFlight.bind(metering);
  metering.markInFlight = async (uid, ids) => { order.push('inflight'); await mark(uid, ids); };
  const anthropic = { messages: sdk } as unknown as Anthropic;
  const reservations = {
    take: (input: { meterKey: string; quantity: number; operationId: string; attributes?: Readonly<Record<string, string>> }) =>
      sessions.reserveSpecialistTokens('s', 'runner', { ...input, leaseToken: authority.token, entitlements, now: new Date() }),
    forget: (id: string) => sessions.forgetSpecialistReservation('s', authority, id),
  };
  let authorizations = 0;
  let rejectAuthorization: number | undefined;
  const admission = createCallAdmission({ models, anthropic, uid: 'u', sessionId: 's',
    inputMeterKey: registry.inputTokenMeterKey, outputMeterKey: registry.outputTokenMeterKey, metering, reservations, rates,
    ...(provider.legacy ? {} : { unified: unifiedAdmissionFor(registry, rates, configuration.ratesByVersion.bind(configuration))! }),
    authorize: async () => { authorizations++; if (authorizations === rejectAuthorization) throw new Error('lease lost'); await sessions.assertPersistenceLease(authority); }, onProblem });
  const begin = (outputReservationId?: string) => admission.begin({ effort: 'low', params: { model: session.model, messages: [] }, maxOutputTokens: 20, signal: controller.signal,
    ...(outputReservationId === undefined ? {} : { outputReservationId }) });
  const run = async () => runAgentTurn({ admission, anthropic, session, project: await projects.readOwned('u', 'p'),
    provider: registry.sandboxProviders.get('web')!, sandbox: { readFile: async () => 'Fixture file' } as unknown as RunningSandbox, withValidationSandbox: undefined,
    messages: [{ seq: 0, role: 'user', content: 'Build', attachments: [], createdAt: new Date() }], entitlements, registry, metering,
    limits: { maxSteps: 2, maxOutputTokens: 20, toolOutputMaxChars: 4096, maxSpecialistConsultations: 1,
      specialistMaxSteps: 2, commandTimeoutMs: 1000, previewReadyTimeoutSeconds: 1 },
    events: { text: () => {}, step: async () => {}, toolCall: async () => {}, toolResult: async () => {},
      preview: async () => {}, specialistStarted: async () => {}, specialistCompleted: async () => {}, skillUsed: async () => {} },
    signal: controller.signal, assertStillOurs: () => {}, drainSteer: () => undefined, desktopReady: false, reservations, onProblem });
  const records = () => [...data].filter(([path]) => path.startsWith('users/u/reservations/')).map(([path, fields]) => ({ id: path.split('/').at(-1)!, fields }));
  const usage = (key: string) => data.get(`users/u/usage/${key}`) as Record<string, unknown> | undefined;
  const period = (key: string, id: string) => data.get(`users/u/usage/${key}/periods/${id}`) as Record<string, unknown> | undefined;
  const limit = entitlements.meterLimits.get(unifiedMeterKey)!.hardLimit;
  const preConsume = (consumed: number, now = new Date()) => data.set(`users/u/usage/${unifiedMeterKey}`, { meterKey: unifiedMeterKey, consumed, reserved: 0,
    periodStart: Timestamp.fromDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))), updatedAt: Timestamp.now() });
  return { db, data, metering, registry, plans, entitlements, sessions, authority, session, controller, problems, order, admission, begin, run,
    records, usage, period, limit, preConsume, streamed, calls: () => calls, setRejectAuthorization: (n: number) => { rejectAuthorization = n; } };
}

/** The fixture with an explicit archive of rate tables by version; `current` is what admission prices with. */
async function unifiedFixtureWithRatesByVersion(archive: ReadonlyMap<string, AiRateTable>, current: AiRateTable) {
  return unifiedFixture({ rates: current, archive });
}

const haiku = 'claude-haiku-4-5';
// Business's first allowed model is Haiku: 10 counted prompt tokens at the 5m-write weight (5/8) plus 20 output at 5/2 = 56.25 → 57.
const expectedEstimate = 57;

// 1. Allowance boundaries per plan.
test('C1: Free, Pro and Business unified allowances are the configured monthly limits and refuse one token over', async () => {
  const registry = parseRegistry(unifiedRegistryDocument, 'registry');
  const plans = plansFor(registry);
  const expected = { free: 225_000, pro: 2_200_000, business: 5_500_000 };
  for (const [planKey, allowance] of Object.entries(expected)) {
    const { db } = ledger();
    const metering = new MeteringService(db, { get: async () => ({ registry, plans, rates: v1 }) } as unknown as ConfigurationStore);
    const entitlements = entitlementsOf(plans, planKey);
    assert.equal(entitlements.meterLimits.get(unifiedMeterKey)!.hardLimit, allowance);
    await metering.assertAvailable({ uid: 'u', entitlements, meterKey: unifiedMeterKey, quantity: allowance, now: march });
    await assert.rejects(metering.assertAvailable({ uid: 'u', entitlements, meterKey: unifiedMeterKey, quantity: allowance + 1, now: march }),
      (error: unknown) => error instanceof AppError && error.code === 'usage/limit-reached' && error.statusCode === 402);
  }
});

// 2 + 7. Reservation precedes dispatch; a complete response settles once at the converted figure.
test('C2/C7: one unified hold is taken and marked in flight before the provider is called, then settled once from authoritative raw usage', async () => {
  const h = await unifiedFixture({ finalUsage: { input_tokens: 7, cache_read_input_tokens: 40, cache_creation: { ephemeral_5m_input_tokens: 16, ephemeral_1h_input_tokens: 0 }, output_tokens: 3 } });
  await h.run();
  assert.deepEqual(h.order, ['inflight', 'stream']);
  const holds = h.records();
  assert.equal(holds.length, 1, 'exactly one hold for one logical call');
  const hold = holds[0]!.fields;
  assert.equal(hold['meterKey'], unifiedMeterKey);
  assert.equal(hold['estimatedQuantity'], expectedEstimate);
  assert.equal(hold['operationId'], 'model-unified:s');
  assert.deepEqual(hold['attributes'], { model: haiku, rateVersion: 'v1' });
  assert.equal(hold['kind'], unifiedHoldKind, 'durable identity, independent of the registry switch');
  // Haiku: 7×1/2 + 40×1/20 + 16×5/8 + 0×1 + 3×5/2 = 3.5 + 2 + 10 + 0 + 7.5 = 23.
  assert.equal(hold['status'], 'SETTLED');
  assert.equal(hold['settledQuantity'], 23);
  assert.equal(hold['observedQuantity'], 23);
  assert.deepEqual(hold['evidence'], { model: haiku, raw: { input: 7, cacheRead: 40, cacheCreation5m: 16, cacheCreation1h: 0, output: 3 }, complete: true, unified: 23, tier: 0, rateVersion: 'v1' });
  assert.equal(h.usage(unifiedMeterKey)?.['consumed'], 23);
  assert.equal(h.usage(unifiedMeterKey)?.['reserved'], 0);
  const period = h.period(unifiedMeterKey, new Date().toISOString().slice(0, 7) + '-01');
  assert.equal(period?.['settled'], 23);
  assert.equal(period?.['unified'], 23);
  assert.equal(h.usage(h.registry.inputTokenMeterKey), undefined, 'legacy meters are not touched in unified mode');
  assert.equal(h.usage(h.registry.outputTokenMeterKey), undefined);
  assert.deepEqual(h.problems, []);
});

// 3. Insufficient capacity blocks dispatch.
test('C3: insufficient unified capacity refuses before the provider is called and leaves no open hold', async () => {
  const h = await unifiedFixture();
  h.preConsume(h.limit - expectedEstimate + 1);
  await assert.rejects(h.run(), (error: unknown) => error instanceof AppError && error.code === 'usage/limit-reached');
  assert.deepEqual(h.order, []);
  assert.equal(h.records().length, 0);
  assert.equal(h.usage(unifiedMeterKey)?.['reserved'], 0);
  // Exactly the estimate still fits.
  const g = await unifiedFixture();
  g.preConsume(g.limit - expectedEstimate);
  await g.run();
  assert.equal(g.records()[0]!.fields['status'], 'SETTLED');
});

// 4 + 5. Conversion per model, output-heavy and cache-heavy.
test('C4/C5: Haiku, Sonnet and Opus convert at their own weights; cache and output categories are priced separately with one ceiling', () => {
  const bare = { input: 1000, output: 100 };
  assert.equal(unifiedFor(v1, 'claude-haiku-4-5', bare)!.unified, 750);
  assert.equal(unifiedFor(v1, 'claude-sonnet-5', bare)!.unified, 1500);
  assert.equal(unifiedFor(v1, 'claude-opus-5', bare)!.unified, 3750);
  // Output-heavy: 100 in, 4000 out on Haiku = 50 + 10000.
  assert.equal(unifiedFor(v1, 'claude-haiku-4-5', { input: 100, output: 4000 })!.unified, 10_050);
  // Cache-heavy: reads at 1/20, 5m writes at 5/8, 1h writes at 1.
  assert.equal(unifiedFor(v1, 'claude-haiku-4-5', { input: 100, cacheRead: 10_000, cacheCreation5m: 1000, cacheCreation1h: 200, output: 10 })!.unified, 50 + 500 + 625 + 200 + 25);
  // One ceiling over the whole call, not per category: 15 reads at 1/10 and 1 output at 5 on Sonnet = 6.5 → 7, never 2 + 5 = 7 by accident of category rounding; 3 reads alone = 0.3 → 1.
  assert.equal(unifiedFor(v1, 'claude-sonnet-5', { cacheRead: 15, output: 1 })!.unified, 7);
  assert.equal(unifiedFor(v1, 'claude-sonnet-5', { cacheRead: 3 })!.unified, 1);
  // An undivided cache-creation figure is read at the TTL the request asked for; the agent asks for 5m, so shadow and active agree.
  assert.equal(promptCacheTtl, '5m');
  assert.equal(unifiedFor(v1, 'claude-haiku-4-5', { cacheCreation: 800 })!.unified, 500);
  assert.equal(unifiedFor(v1, 'claude-haiku-4-5', { cacheCreation: 800 }, { undividedCacheWrite: promptCacheTtl })!.unified, 500);
  assert.equal(unifiedFor(v1, 'claude-haiku-4-5', { cacheCreation: 800 }, { undividedCacheWrite: '1h' })!.unified, 800, 'a 1h request would read it at 1h');
  // An unpriced model is undefined, never a default weight.
  assert.equal(unifiedFor(v1, 'claude-unknown', bare), undefined);
});

// 6. Context tiers price the whole request.
test('C6: a prompt over a tier boundary prices the whole request at the higher tier; the estimate uses the same tier rule', () => {
  const tiered = parseAiRateTable({ version: 't', referenceUnit: 'ref', models: { tiered: { tiers: [
    { maxInputTokens: 200_000, input: { num: 1, den: 1 }, output: { num: 5, den: 1 }, cacheWrite5m: { num: 5, den: 4 }, cacheWrite1h: { num: 2, den: 1 }, cacheRead: { num: 1, den: 10 } },
    { maxInputTokens: null, input: { num: 2, den: 1 }, output: { num: 10, den: 1 }, cacheWrite5m: { num: 5, den: 2 }, cacheWrite1h: { num: 4, den: 1 }, cacheRead: { num: 1, den: 5 } },
  ] } } }, 'test');
  const atBoundary = unifiedFor(tiered, 'tiered', { input: 100_000, cacheRead: 100_000, output: 10 })!;
  assert.deepEqual([atBoundary.tier, atBoundary.unified], [0, 100_000 + 10_000 + 50]);
  const over = unifiedFor(tiered, 'tiered', { input: 100_000, cacheRead: 100_001, output: 10 })!;
  assert.deepEqual([over.tier, over.unified], [1, 200_000 + 20_001 + 100], 'every category of the request moves to the higher tier');
  assert.equal(unifiedEstimate(tiered, 'tiered', 200_000, 100), 250_000 + 500);
  assert.equal(unifiedEstimate(tiered, 'tiered', 200_001, 100), Math.ceil(200_001 * 2.5) + 1000);
  assert.throws(() => unifiedEstimate(tiered, 'absent', 10, 10), EntitlementConfigError);
});

// 8. Interrupted stream with partial evidence.
test('C8: a stream interrupted after message_start keeps the hold open with partial evidence only for reconciliation', async () => {
  const start = { type: 'message_start', message: { usage: { input_tokens: 7, cache_read_input_tokens: 40, cache_creation_input_tokens: 16, cache_creation: { ephemeral_5m_input_tokens: 16, ephemeral_1h_input_tokens: 0 }, output_tokens: 1 } } } as unknown as MessageStreamEvent;
  const h = await unifiedFixture({ events: [start], abortAfterEvents: true });
  await assert.rejects(h.run(), /aborted/);
  const hold = h.records()[0]!.fields;
  assert.equal(hold['status'], 'OPEN');
  assert.equal(hold['inFlight'], true);
  assert.equal(hold['observedQuantity'], undefined, 'a partial figure is never journalled as the call\'s usage');
  assert.deepEqual(hold['partialEvidence'], { model: haiku, raw: { input: 7, cacheRead: 40, cacheCreation5m: 16, cacheCreation1h: 0 }, complete: false, unified: 16, tier: 0, rateVersion: 'v1' },
    'what the provider did report is kept on the open hold');
  assert.equal(h.usage(unifiedMeterKey)?.['reserved'], expectedEstimate);
  assert.equal(h.usage(unifiedMeterKey)?.['consumed'], 0);
  assert.ok(h.problems.some((problem) => problem.what === 'model usage reconciliation required'));
  // Recovery, once the worker is proven gone, settles at the estimate and carries the partial evidence into the settled record.
  assert.equal(await h.metering.reconcile('u', h.records()[0]!.id, new Date(), { unreportable: true }), true);
  const settled = h.records()[0]!.fields;
  assert.equal(settled['settledQuantity'], expectedEstimate);
  assert.deepEqual((settled['evidence'] as { raw: unknown; complete: boolean }).raw, { input: 7, cacheRead: 40, cacheCreation5m: 16, cacheCreation1h: 0 });
  assert.equal((settled['evidence'] as { complete: boolean }).complete, false);
  assert.equal(h.period(unifiedMeterKey, new Date().toISOString().slice(0, 7) + '-01')?.['unifiedPartial'], 16);
  assert.equal(h.period(unifiedMeterKey, new Date().toISOString().slice(0, 7) + '-01')?.['unified'], undefined);
});

test('C8b: partial evidence is refused on a closed hold and can never be marked complete', async () => {
  const h = await unifiedFixture();
  const admitted = await h.begin();
  const id = h.records()[0]!.id;
  await assert.rejects(h.metering.recordPartialUsage('u', id, { model: haiku, raw: { input: 1 }, complete: true }), /cannot be marked complete/);
  await admitted.settle({ input: 7, output: 3, raw: { input: 7, output: 3 } });
  await h.metering.recordPartialUsage('u', id, { model: haiku, raw: { input: 1 }, complete: false });
  assert.equal(h.records()[0]!.fields['partialEvidence'], undefined, 'a settled hold is not rewritten');
});

// 9. Cancellation before dispatch and after dispatch.
test('C9: a Stop before dispatch closes the hold at zero; a Stop mid-call settles at the estimate with the partial figure kept apart', async () => {
  const before = await unifiedFixture();
  before.setRejectAuthorization(2);
  await assert.rejects(before.begin(), /lease lost/);
  const undispatched = before.records()[0]!.fields;
  assert.deepEqual([undispatched['status'], undispatched['settledQuantity'], undispatched['inFlight']], ['SETTLED', 0, undefined]);
  assert.equal(before.usage(unifiedMeterKey)?.['reserved'], 0);
  assert.deepEqual(before.order, []);

  const start = { type: 'message_start', message: { usage: { input_tokens: 7, cache_read_input_tokens: 40, cache_creation_input_tokens: 16, cache_creation: { ephemeral_5m_input_tokens: 16, ephemeral_1h_input_tokens: 0 }, output_tokens: 1 } } } as unknown as MessageStreamEvent;
  const during = await unifiedFixture({ events: [start], stopDuringCall: true });
  await assert.rejects(during.run());
  const stopped = during.records()[0]!.fields;
  assert.equal(stopped['status'], 'SETTLED');
  assert.equal(stopped['settledQuantity'], expectedEstimate, 'bounded by what admission approved, never guessed higher');
  assert.equal(stopped['usageEvidence'], 'provider-usage-unavailable');
  const evidence = stopped['evidence'] as Record<string, unknown>;
  assert.equal(evidence['complete'], false);
  assert.equal(evidence['unified'], 16, 'known prompt usage only: 3.5 + 2 + 10 = 15.5 → 16');
  assert.equal(during.usage(unifiedMeterKey)?.['consumed'], expectedEstimate);
  assert.equal(during.usage(unifiedMeterKey)?.['reserved'], 0);
  const period = during.period(unifiedMeterKey, new Date().toISOString().slice(0, 7) + '-01');
  assert.equal(period?.['unified'], undefined, 'a partial figure never enters the definitive total');
  assert.equal(period?.['unifiedPartial'], 16);
  assert.equal(period?.['settled'], expectedEstimate);
});

// 10. Provider refusal, timeout and unknown usage.
test('C10: a 4xx refusal before any event settles at zero; a 5xx or timeout that may have done work keeps the hold open', async () => {
  const refused = await unifiedFixture({ throwBeforeStream: Object.assign(new Error('404 no such model'), { status: 404 }) });
  await assert.rejects(refused.run(), /404/);
  assert.deepEqual([refused.records()[0]!.fields['status'], refused.records()[0]!.fields['settledQuantity']], ['SETTLED', 0]);
  assert.equal(refused.usage(unifiedMeterKey)?.['reserved'], 0);
  assert.deepEqual(refused.problems, []);
  for (const status of [500, 408, 429]) {
    const failed = await unifiedFixture({ throwBeforeStream: Object.assign(new Error(`${status} upstream`), { status }) });
    await assert.rejects(failed.run());
    assert.equal(failed.records()[0]!.fields['status'], 'OPEN', `status ${status} may have consumed tokens`);
    assert.equal(failed.usage(unifiedMeterKey)?.['reserved'], expectedEstimate);
    assert.ok(failed.problems.some((problem) => problem.what === 'model usage reconciliation required'));
  }
});

// 11. Actual usage above the estimate.
test('C11: usage above the estimate settles at the actual figure, records the overrun, and never drives reserved negative', async () => {
  const h = await unifiedFixture({ finalUsage: { input_tokens: 7, output_tokens: 1000 } });
  await h.run();
  const hold = h.records()[0]!.fields;
  // 7×1/2 + 1000×5/2 = 3.5 + 2500 = 2503.5 → 2504.
  assert.equal(hold['settledQuantity'], 2504);
  assert.equal(hold['overrunQuantity'], 2504 - expectedEstimate);
  assert.equal(h.usage(unifiedMeterKey)?.['consumed'], 2504);
  assert.equal(h.usage(unifiedMeterKey)?.['reserved'], 0);
  assert.equal(h.period(unifiedMeterKey, new Date().toISOString().slice(0, 7) + '-01')?.['overrunInfo'], 2504 - expectedEstimate);
  // The next call is admitted against what was really spent.
  await assert.rejects(h.metering.assertAvailable({ uid: 'u', entitlements: h.entitlements, meterKey: unifiedMeterKey, quantity: h.limit - 2503, now: new Date() }), { code: 'usage/limit-reached' });
});

// 12. Specialist calls and shared reservation behaviour.
test('C12: under unified admission a shared output reservation is ignored — each call takes exactly one unified hold', async () => {
  const h = await unifiedFixture();
  const admitted = await h.begin('shared-output-hold-from-legacy-caller');
  const open = h.records();
  assert.equal(open.length, 1);
  assert.equal(open[0]!.fields['meterKey'], unifiedMeterKey);
  await admitted.settle({ input: 7, output: 3, raw: { input: 7, output: 3 } });
  assert.equal(h.records().length, 1);
  assert.equal(h.records()[0]!.fields['settledQuantity'], 11); // 3.5 + 7.5
});

test('C12b: a specialist consultation under unified admission is three logical calls, three unified holds, no shared output hold, each settled once', async () => {
  const toolUse = (id: string, name: string, input: Record<string, unknown>): ContentBlock => ({ type: 'tool_use', id, name, input, caller: { type: 'direct' } } as unknown as ContentBlock);
  const usageOf = (input: number, output: number) => ({ input_tokens: input, output_tokens: output });
  const h = await unifiedFixture({ responses: [
    // Primary asks the security specialist.
    { content: [toolUse('c1', 'consult_specialist', { role: 'security', question: 'Inspect the project for ownership checks.' })], usage: usageOf(100, 10), stop_reason: 'tool_use' },
    // The specialist answers with its review.
    { content: [toolUse('r1', 'submit_review', { verdict: 'ok', summary: 'No concerns.', findings: [] })], usage: usageOf(200, 20), stop_reason: 'tool_use' },
    // Primary finishes.
    { content: [{ type: 'text', text: 'Done', citations: null } as ContentBlock, toolUse('f1', 'finish_task', { outcome: 'answered', summary: 'Done', evidence: ['c1'] })], usage: usageOf(300, 30), stop_reason: 'tool_use' },
  ] });
  await h.run();
  assert.equal(h.calls(), 3);
  assert.ok(h.streamed[1]!.tools.includes('submit_review'), 'the second call was the specialist');
  const holds = h.records();
  assert.equal(holds.length, 3, 'one unified hold per logical call, none shared');
  for (const hold of holds) {
    assert.equal(hold.fields['meterKey'], unifiedMeterKey);
    assert.equal(hold.fields['status'], 'SETTLED');
    assert.equal(hold.fields['operationId'], 'model-unified:s');
    assert.equal((hold.fields['evidence'] as { complete: boolean }).complete, true);
  }
  assert.ok(!holds.some((hold) => String(hold.fields['operationId']).startsWith('specialist:')), 'no shared specialist output hold exists in unified mode');
  // Haiku: (100/2 + 10×5/2) + (200/2 + 20×5/2) + (300/2 + 30×5/2) = 75 + 150 + 225.
  assert.deepEqual(holds.map((hold) => hold.fields['settledQuantity']).sort((a, b) => Number(a) - Number(b)), [75, 150, 225]);
  assert.equal(h.usage(unifiedMeterKey)?.['consumed'], 450);
  assert.equal(h.usage(unifiedMeterKey)?.['reserved'], 0);
  assert.equal(h.usage(h.registry.outputTokenMeterKey), undefined);
  assert.deepEqual(h.problems, []);
  assert.deepEqual(h.data.get('sessions/s')?.['specialistReservationIds'] ?? [], [], 'every hold was forgotten from the session after settling');
});

test('C12c: in legacy mode the same consultation still takes the shared specialist output hold and settles it once', async () => {
  const toolUse = (id: string, name: string, input: Record<string, unknown>): ContentBlock => ({ type: 'tool_use', id, name, input, caller: { type: 'direct' } } as unknown as ContentBlock);
  const usageOf = (input: number, output: number) => ({ input_tokens: input, output_tokens: output });
  // Legacy output holds are bounded by maxOutputTokens (20): a legacy call cannot overrun its output hold.
  const h = await unifiedFixture({ legacy: true, responses: [
    { content: [toolUse('c1', 'consult_specialist', { role: 'security', question: 'Inspect the project.' })], usage: usageOf(100, 10), stop_reason: 'tool_use' },
    { content: [toolUse('r1', 'submit_review', { verdict: 'ok', summary: 'No concerns.', findings: [] })], usage: usageOf(200, 20), stop_reason: 'tool_use' },
    { content: [{ type: 'text', text: 'Done', citations: null } as ContentBlock, toolUse('f1', 'finish_task', { outcome: 'answered', summary: 'Done', evidence: ['c1'] })], usage: usageOf(300, 15), stop_reason: 'tool_use' },
  ] });
  await h.run();
  const shared = h.records().filter((hold) => String(hold.fields['operationId']).startsWith('specialist:'));
  assert.equal(shared.length, 1);
  assert.deepEqual([shared[0]!.fields['status'], shared[0]!.fields['settledQuantity']], ['SETTLED', 20]);
  assert.equal(h.usage(h.registry.outputTokenMeterKey)?.['consumed'], 45);
  assert.equal(h.usage(h.registry.inputTokenMeterKey)?.['consumed'], 600);
  assert.equal(h.usage(unifiedMeterKey), undefined);
});

// 13. Fallback lane.
test('C13: the fallback lane runs under its own policy meters and never under unified admission', () => {
  const registry = parseRegistry(unifiedRegistryDocument, 'registry');
  const policy = { inputTokenMeterKey: 'ai.fallback.input', outputTokenMeterKey: 'ai.fallback.output' } as FallbackPolicy;
  const lane = fallbackLaneRegistry(registry, policy);
  assert.equal(lane.aiUnified, undefined);
  assert.equal(lane.inputTokenMeterKey, 'ai.fallback.input');
  assert.equal(lane.outputTokenMeterKey, 'ai.fallback.output');
  assert.equal(unifiedAdmissionFor(lane, v1, async () => v1), undefined);
  assert.equal(unifiedAdmissionFor(registry, v1, async () => v1)?.meterKey, unifiedMeterKey);
  // The premium lane's registry is untouched by deriving the fallback lane's.
  assert.equal(registry.aiUnified?.meterKey, unifiedMeterKey);
});

// 14. Duplicate settlement and transaction retries.
test('C14: settling the same call twice, or retrying after a failed commit, charges exactly once', async () => {
  const h = await unifiedFixture();
  const admitted = await h.begin();
  const spend = { input: 7, output: 3, raw: { input: 7, output: 3 } };
  await admitted.settle(spend);
  await admitted.settle(spend);
  assert.equal(h.usage(unifiedMeterKey)?.['consumed'], 11);
  assert.equal(h.usage(unifiedMeterKey)?.['reserved'], 0);
  assert.equal(h.records()[0]!.fields['settledQuantity'], 11);

  // A commit that fails after the writes are prepared leaves nothing applied; the retry settles once.
  const g = await unifiedFixture();
  const admittedG = await g.begin();
  const realTransaction = g.db.runTransaction.bind(g.db);
  let failures = 0;
  (g.db as unknown as { runTransaction: Firestore['runTransaction'] }).runTransaction = async (work, options) => {
    const result = await realTransaction(async (tx) => { const value = await work(tx); if (failures === 0) { failures++; throw new Error('commit lost'); } return value; }, options);
    return result;
  };
  await assert.rejects(admittedG.settle(spend), /commit lost/);
  const afterFailure = g.records()[0]!.fields;
  assert.equal(afterFailure['status'], 'OPEN');
  assert.equal(g.usage(unifiedMeterKey)?.['reserved'], expectedEstimate);
  await admittedG.settle(spend);
  assert.equal(g.records()[0]!.fields['settledQuantity'], 11);
  assert.equal(g.usage(unifiedMeterKey)?.['consumed'], 11);
  assert.equal(g.usage(unifiedMeterKey)?.['reserved'], 0);
});

// 15. Concurrent reservations competing for the last available allowance.
test('C15: two concurrent reservations for the last available capacity admit exactly one', async () => {
  const h = await unifiedFixture();
  h.preConsume(h.limit - 100);
  const reserve = () => h.db.runTransaction((tx: Transaction) => h.metering.reserveIn(tx, { uid: 'u', entitlements: h.entitlements, meterKey: unifiedMeterKey, quantity: 100, operationId: 'race', now: new Date() }));
  const outcomes = await Promise.allSettled([reserve(), reserve(), reserve()]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected' && (outcome.reason as AppError).code === 'usage/limit-reached').length, 2);
  const usage = h.usage(unifiedMeterKey)!;
  assert.equal((usage['consumed'] as number) + (usage['reserved'] as number), h.limit);
});

// 16. Month-boundary reservations and late settlements.
test('C16: a unified hold opened in March and settled in April returns its capacity without consuming April, and is attributed to March', async () => {
  const h = await unifiedFixture();
  const hold = await h.db.runTransaction((tx: Transaction) => h.metering.reserveIn(tx, { uid: 'u', entitlements: h.entitlements, meterKey: unifiedMeterKey, quantity: 100, operationId: 'op', now: march,
    kind: unifiedHoldKind, attributes: { model: haiku, rateVersion: 'v1' } }));
  assert.deepEqual(h.usage(unifiedMeterKey)?.['periodStart'], Timestamp.fromDate(new Date('2026-03-01T00:00:00Z')));
  // Across the boundary the hold still counts against capacity: April cannot hand out the same 100 twice.
  await assert.rejects(h.metering.assertAvailable({ uid: 'u', entitlements: h.entitlements, meterKey: unifiedMeterKey, quantity: h.limit - 99, now: april }), { code: 'usage/limit-reached' });
  await h.metering.assertAvailable({ uid: 'u', entitlements: h.entitlements, meterKey: unifiedMeterKey, quantity: h.limit - 100, now: april });
  assert.equal(await h.metering.settle({ uid: 'u', reservationId: hold.id, actualQuantity: 60, recordOverrun: true, now: april,
    evidence: { model: haiku, raw: { input: 120 }, complete: true, unified: 60, tier: 0, rateVersion: 'v1' } }), true);
  const live = h.usage(unifiedMeterKey)!;
  assert.equal(live['consumed'], 0, 'April\'s allowance is untouched by March\'s call');
  assert.equal(live['reserved'], 0);
  assert.deepEqual(live['periodStart'], Timestamp.fromDate(new Date('2026-04-01T00:00:00Z')));
  const opening = h.period(unifiedMeterKey, '2026-03-01')!;
  assert.equal(opening['settledLate'], 60);
  assert.equal(opening['unified'], 60);
  assert.equal(h.period(unifiedMeterKey, '2026-04-01'), undefined);
  // Idempotent: a repeated late settlement changes nothing.
  assert.equal(await h.metering.settle({ uid: 'u', reservationId: hold.id, actualQuantity: 60, recordOverrun: true, now: april }), false);
  assert.equal(h.period(unifiedMeterKey, '2026-03-01')!['settledLate'], 60);
  // Identity is the persisted kind, not the meter: a hold on this meter lacking it follows legacy attribution.
  const unkinded = await h.db.runTransaction((tx: Transaction) => h.metering.reserveIn(tx, { uid: 'u', entitlements: h.entitlements, meterKey: unifiedMeterKey, quantity: 10, operationId: 'op', now: march }));
  await h.metering.settle({ uid: 'u', reservationId: unkinded.id, actualQuantity: 10, now: april });
  assert.equal(h.usage(unifiedMeterKey)?.['consumed'], 10);
  h.data.get(`users/u/usage/${unifiedMeterKey}`)!['consumed'] = 0;
  // A hold settled within its own month still counts in the live window as before.
  const same = await h.db.runTransaction((tx: Transaction) => h.metering.reserveIn(tx, { uid: 'u', entitlements: h.entitlements, meterKey: unifiedMeterKey, quantity: 50, operationId: 'op', now: april, kind: unifiedHoldKind }));
  await h.metering.settle({ uid: 'u', reservationId: same.id, actualQuantity: 50, now: april });
  assert.equal(h.usage(unifiedMeterKey)?.['consumed'], 50);
  assert.equal(h.period(unifiedMeterKey, '2026-04-01')?.['settled'], 50);
});

test('C16b: concurrent March holds settling on both sides of the boundary keep reserved and consumed exact', async () => {
  const h = await unifiedFixture();
  const reserve = (now: Date) => h.db.runTransaction((tx: Transaction) => h.metering.reserveIn(tx, { uid: 'u', entitlements: h.entitlements, meterKey: unifiedMeterKey, quantity: 100, operationId: 'op', now, kind: unifiedHoldKind }));
  const [a, b, c] = await Promise.all([reserve(march), reserve(march), reserve(march)]);
  assert.equal(h.usage(unifiedMeterKey)?.['reserved'], 300);
  await h.metering.settle({ uid: 'u', reservationId: a!.id, actualQuantity: 70, now: march });
  await Promise.all([
    h.metering.settle({ uid: 'u', reservationId: b!.id, actualQuantity: 80, now: april }),
    h.metering.release('u', c!.id, april),
  ]);
  const live = h.usage(unifiedMeterKey)!;
  assert.equal(live['reserved'], 0);
  assert.equal(live['consumed'], 0, 'April window: March\'s 70 rolled off, the late 80 never entered');
  assert.equal(h.period(unifiedMeterKey, '2026-03-01')?.['settled'], 70);
  assert.equal(h.period(unifiedMeterKey, '2026-03-01')?.['settledLate'], 80);
});

// 17. Worker crash and recovery.
test('C17: recovery settles a dispatched unified hold from journalled usage, or at the estimate once the worker is proven gone', async () => {
  const observed = await unifiedFixture();
  await observed.begin();
  const id = observed.records()[0]!.id;
  await observed.metering.recordObservedUsage('u', id, 30);
  assert.equal(await observed.metering.reconcile('u', id), true);
  assert.equal(observed.records()[0]!.fields['settledQuantity'], 30);
  assert.equal(observed.usage(unifiedMeterKey)?.['consumed'], 30);
  assert.equal(observed.usage(unifiedMeterKey)?.['reserved'], 0);
  // Recovery replays nothing: a second pass over the settled hold is a no-op.
  assert.equal(await observed.metering.reconcile('u', id), false);
  assert.equal(observed.usage(unifiedMeterKey)?.['consumed'], 30);

  // Without proof the dispatching worker is gone, recovery will not guess at an in-flight hold.
  const silent = await unifiedFixture();
  await silent.begin();
  const silentId = silent.records()[0]!.id;
  await assert.rejects(silent.metering.reconcile('u', silentId), { code: 'usage/reconciliation-required' });
  assert.equal(silent.records()[0]!.fields['status'], 'OPEN');
});

test('C17b: an in-flight unified hold without usage is left alone until the worker is proven gone, then settled at its estimate', async () => {
  const h = await unifiedFixture();
  await h.begin();
  const id = h.records()[0]!.id;
  assert.equal(h.records()[0]!.fields['inFlight'], true);
  await assert.rejects(h.metering.release('u', id), { code: 'usage/reconciliation-required' });
  assert.equal(await h.metering.reconcile('u', id, new Date(), { unreportable: true }), true);
  assert.equal(h.records()[0]!.fields['settledQuantity'], expectedEstimate);
  assert.equal(h.records()[0]!.fields['usageEvidence'], 'provider-usage-unavailable');
  assert.equal(h.usage(unifiedMeterKey)?.['reserved'], 0);
  assert.equal(h.usage(unifiedMeterKey)?.['consumed'], expectedEstimate);
  assert.equal(await h.metering.reconcile('u', id, new Date(), { unreportable: true }), false);
});

// 18. Legacy reservations settling after activation.
test('C18: a legacy input/output hold opened before activation settles under its own meter and rules after the switch is turned on', async () => {
  const { db, data } = ledger();
  const legacy = parseRegistry(registryDocument, 'registry');
  const unified = parseRegistry(unifiedRegistryDocument, 'registry');
  let current = { registry: legacy, plans: plansFor(legacy), rates: undefined as AiRateTable | undefined };
  const metering = new MeteringService(db, { get: async () => current } as unknown as ConfigurationStore);
  const entitlements = entitlementsOf(current.plans, 'business');
  const hold = await db.runTransaction((tx: Transaction) => metering.reserveIn(tx, { uid: 'u', entitlements, meterKey: legacy.inputTokenMeterKey, quantity: 100, operationId: 'model-input:s', now: march }));
  current = { registry: unified, plans: plansFor(unified), rates: v1 };
  assert.equal(await metering.settle({ uid: 'u', reservationId: hold.id, actualQuantity: 90, recordOverrun: true, now: april }), true);
  const live = data.get(`users/u/usage/${legacy.inputTokenMeterKey}`)!;
  // Legacy attribution is unchanged: the live window counts the late settlement as it always did.
  assert.equal(live['consumed'], 90);
  assert.equal(live['reserved'], 0);
  assert.equal(data.get(`users/u/usage/${legacy.inputTokenMeterKey}/periods/2026-03-01`)?.['settledLate'], 90);
  assert.equal(data.get(`users/u/usage/${unifiedMeterKey}`), undefined, 'nothing is converted or moved onto the new meter');
});

// 19. Missing and malformed rate configuration.
test('C19: the switch on without a usable rate table fails closed; invalid policies are refused at parse time', async () => {
  const registry = parseRegistry(unifiedRegistryDocument, 'registry');
  assert.throws(() => unifiedAdmissionFor(registry, undefined, async () => v1), EntitlementConfigError);
  const empty = parseAiRateTable({ version: 'v0', referenceUnit: 'ref', models: {} }, 'test');
  assert.throws(() => createCallAdmission({ models, anthropic: {} as Anthropic, uid: 'u', sessionId: 's', inputMeterKey: 'i', outputMeterKey: 'o',
    metering: {} as MeteringService, reservations: { take: async () => ({ id: 'x' }), forget: async () => {} }, authorize: async () => {}, onProblem: () => {},
    unified: { meterKey: unifiedMeterKey, rates: empty, ratesByVersion: async () => empty } }), EntitlementConfigError);
  const meters = registry.meters;
  const reserved = [registry.inputTokenMeterKey, registry.outputTokenMeterKey, registry.buildMeterKey];
  assert.equal(parseAiUnifiedPolicy(undefined, 'r.aiUnified', meters, reserved), undefined);
  assert.throws(() => parseAiUnifiedPolicy({ meterKey: 'ai.missing' }, 'r.aiUnified', meters, reserved), /not a declared meter/);
  assert.throws(() => parseAiUnifiedPolicy({ meterKey: registry.inputTokenMeterKey }, 'r.aiUnified', meters, reserved), /already spent by another role/);
  assert.throws(() => parseAiUnifiedPolicy({ meterKey: registry.storageMeterKey }, 'r.aiUnified', meters, reserved), /MONTHLY COUNTER/);
  assert.throws(() => parseAiUnifiedPolicy('ai.unified', 'r.aiUnified', meters, reserved), /must be an object/);
  assert.throws(() => parseRegistry({ ...registryDocument, aiUnified: { meterKey: 'builds.started' } }, 'registry'), /already spent/);
  // A model the configured table does not price is refused before any hold or provider call.
  const h = await unifiedFixture({ rates: parseAiRateTable({ version: 'v9', referenceUnit: 'ref', models: { 'claude-opus-5': aiRatesV1Document.models['claude-opus-5'] } }, 'test') });
  await assert.rejects(h.run(), EntitlementConfigError);
  assert.equal(h.records().length, 0);
  assert.deepEqual(h.order, []);
});

test('C19b: archived rate tables resolve by their own version; a missing, malformed or mislabelled archive is an error, never another table', async () => {
  const documents = new Map<string, Record<string, unknown>>([['config/registry', unifiedRegistryDocument as unknown as Record<string, unknown>],
    ['config/aiRates', { ...aiRatesV1Document, version: 'v2' }], ['config/aiRates/versions/v1', aiRatesV1Document],
    ['config/aiRates/versions/bad', { version: 'bad' }], ['config/aiRates/versions/mismatch', { ...aiRatesV1Document, version: 'other' }]]);
  const firestore = { doc: (path: string) => ({ get: async () => ({ exists: documents.has(path), data: () => documents.get(path) }) }),
    collection: () => ({ get: async () => ({ docs: planDocuments.map((row) => ({ id: row.key, data: () => row })) }) }) } as unknown as Firestore;
  const store = new ConfigurationStore(firestore, 1000);
  assert.equal((await store.get()).rates?.version, 'v2');
  assert.equal((await store.ratesByVersion('v2')).version, 'v2');
  assert.equal((await store.ratesByVersion('v1')).version, 'v1');
  await assert.rejects(store.ratesByVersion('v0'), /does not exist/);
  await assert.rejects(store.ratesByVersion('bad'), /referenceUnit/);
  await assert.rejects(store.ratesByVersion('mismatch'), /carries version/);
  await assert.rejects(store.ratesByVersion('../registry'), /not a valid document id/);
});

test('C19c: settlement prices a hold under the version persisted on it, even after the current table moved on', async () => {
  // Admitted under v1; by settlement the current table is v2 with doubled Haiku weights. The hold must settle at v1 figures.
  const v2 = parseAiRateTable({ ...aiRatesV1Document, version: 'v2', models: { ...aiRatesV1Document.models,
    'claude-haiku-4-5': { tiers: [{ maxInputTokens: null, input: { num: 1, den: 1 }, output: { num: 5, den: 1 }, cacheWrite5m: { num: 5, den: 4 }, cacheWrite1h: { num: 2, den: 1 }, cacheRead: { num: 1, den: 10 } }] } } }, 'test');
  const h = await unifiedFixture();
  const admitted = await h.begin();
  const stored = h.records()[0]!.fields;
  assert.deepEqual(stored['attributes'], { model: haiku, rateVersion: 'v1' });
  // The table rolls over while the call is in flight: current is v2, v1 is archived.
  const configuration = h.admission as unknown as { unified?: { rates: AiRateTable; ratesByVersion: (v: string) => Promise<AiRateTable> } };
  void configuration;
  const archive = new Map<string, AiRateTable>([['v1', v1], ['v2', v2]]);
  const swapped = await unifiedFixtureWithRatesByVersion(archive, v2);
  const admittedSwapped = await swapped.begin();
  // Rewrite the persisted version to v1 to model a hold admitted before the rollover.
  swapped.data.get(`users/u/reservations/${swapped.records()[0]!.id}`)!['attributes'] = { model: haiku, rateVersion: 'v1' };
  await admittedSwapped.settle({ input: 7, output: 3, raw: { input: 7, output: 3 } });
  const settled = swapped.records()[0]!.fields;
  assert.equal(settled['status'], 'SETTLED');
  assert.equal(settled['settledQuantity'], 11, 'v1 Haiku: 3.5 + 7.5 = 11, not v2\'s 7 + 15 = 22');
  assert.equal((settled['evidence'] as { rateVersion: string }).rateVersion, 'v1');
  await admitted.settle({ input: 7, output: 3, raw: { input: 7, output: 3 } });
  assert.equal(h.records()[0]!.fields['settledQuantity'], 11);
});

test('C19d: a hold whose persisted version is unavailable, or whose attributes are missing or name another model, stays open and is never repriced', async () => {
  for (const attributes of [{ model: haiku, rateVersion: 'v0' }, { model: 'claude-opus-5', rateVersion: 'v1' }, undefined]) {
    const h = await unifiedFixture();
    const admitted = await h.begin();
    const id = h.records()[0]!.id;
    const record = h.data.get(`users/u/reservations/${id}`)!;
    if (attributes === undefined) delete record['attributes']; else record['attributes'] = attributes;
    await admitted.settle({ input: 7, output: 3, raw: { input: 7, output: 3 } });
    const after = h.records()[0]!.fields;
    assert.equal(after['status'], 'OPEN', `attributes ${JSON.stringify(attributes)} must not settle`);
    assert.equal(after['observedQuantity'], undefined);
    assert.equal(h.usage(unifiedMeterKey)?.['consumed'], 0);
    assert.equal(h.usage(unifiedMeterKey)?.['reserved'], expectedEstimate);
    assert.ok(h.problems.some((problem) => problem.what === 'model usage reconciliation required'), 'the operator is told');
  }
});

test('C19e: a ratesByVersion that answers with a differently versioned table is refused', async () => {
  const wrong = parseAiRateTable({ ...aiRatesV1Document, version: 'v9' }, 'test');
  const h = await unifiedFixtureWithRatesByVersion(new Map([['v1', wrong]]), v1);
  const admitted = await h.begin();
  await admitted.settle({ input: 7, output: 3, raw: { input: 7, output: 3 } });
  assert.equal(h.records()[0]!.fields['status'], 'OPEN');
  assert.ok(h.problems.some((problem) => /not the v1 this hold was admitted under/.test(problem.error.message)));
});

test('C19f: complete raw usage survives an unavailable rate version and is settled once, under that version, when it returns — never at the estimate', async () => {
  const archive = new Map<string, AiRateTable>([['v1', v1]]);
  const h = await unifiedFixtureWithRatesByVersion(archive, v1);
  const admitted = await h.begin();
  const id = h.records()[0]!.id;
  // v1 becomes unavailable between dispatch and settlement.
  archive.delete('v1');
  await admitted.settle({ input: 7, cacheRead: 40, output: 3, raw: { input: 7, cacheRead: 40, cacheCreation5m: 16, cacheCreation1h: 0, output: 3 } } as never);
  let hold = h.records()[0]!.fields;
  assert.equal(hold['status'], 'OPEN');
  assert.equal(hold['observedQuantity'], undefined, 'nothing converted, so nothing journalled as the call\'s usage');
  assert.deepEqual(hold['completeRawUsage'], { model: haiku, rateVersion: 'v1', raw: { input: 7, cacheRead: 40, cacheCreation5m: 16, cacheCreation1h: 0, output: 3 } });
  assert.ok(h.problems.some((problem) => problem.what === 'model usage reconciliation required'));
  // Worker recovery while v1 is still unavailable: refuses the estimate, leaves the hold open, nothing charged.
  await assert.rejects(h.metering.reconcile('u', id, new Date(), { unreportable: true }), /no archived table v1/);
  await assert.rejects(h.metering.settleUnobserved('u', id), /complete provider usage/);
  hold = h.records()[0]!.fields;
  assert.equal(hold['status'], 'OPEN');
  assert.equal(h.usage(unifiedMeterKey)?.['consumed'], 0);
  assert.equal(h.usage(unifiedMeterKey)?.['reserved'], expectedEstimate);
  // The current table moves to v2 (doubled weights): still not used for this hold.
  const v2 = parseAiRateTable({ ...aiRatesV1Document, version: 'v2', models: { ...aiRatesV1Document.models,
    'claude-haiku-4-5': { tiers: [{ maxInputTokens: null, input: { num: 1, den: 1 }, output: { num: 5, den: 1 }, cacheWrite5m: { num: 5, den: 4 }, cacheWrite1h: { num: 2, den: 1 }, cacheRead: { num: 1, den: 10 } }] } } }, 'test');
  archive.set('v2', v2);
  await assert.rejects(h.metering.reconcile('u', id, new Date(), { unreportable: true }), /no archived table v1/);
  // v1 is archived again: recovery converts the persisted figures under v1 and settles exactly once.
  archive.set('v1', v1);
  assert.equal(await h.metering.reconcile('u', id, new Date(), { unreportable: true }), true);
  hold = h.records()[0]!.fields;
  assert.equal(hold['status'], 'SETTLED');
  assert.equal(hold['settledQuantity'], 23, 'v1 Haiku: 3.5 + 2 + 10 + 0 + 7.5 = 23 (v2 would be 46)');
  assert.equal(hold['observedQuantity'], 23);
  assert.deepEqual(hold['evidence'], { model: haiku, raw: { input: 7, cacheRead: 40, cacheCreation5m: 16, cacheCreation1h: 0, output: 3 }, complete: true, unified: 23, tier: 0, rateVersion: 'v1' });
  assert.equal(h.usage(unifiedMeterKey)?.['consumed'], 23);
  assert.equal(h.usage(unifiedMeterKey)?.['reserved'], 0);
  assert.equal(h.period(unifiedMeterKey, new Date().toISOString().slice(0, 7) + '-01')?.['unified'], 23);
  // Idempotent: a second recovery pass, a repeated live settlement, and a direct re-settle all change nothing.
  assert.equal(await h.metering.reconcile('u', id, new Date(), { unreportable: true }), false);
  assert.equal(await h.metering.settleFromCompleteRawUsage('u', id), false);
  await admitted.settle({ input: 7, output: 3, raw: { input: 7, cacheRead: 40, cacheCreation5m: 16, cacheCreation1h: 0, output: 3 } });
  assert.equal(h.usage(unifiedMeterKey)?.['consumed'], 23);
  assert.equal(h.records().length, 1);
});

test('C19g: complete raw usage is refused without both authoritative figures and is not written onto a closed hold', async () => {
  const h = await unifiedFixture();
  const admitted = await h.begin();
  const id = h.records()[0]!.id;
  await assert.rejects(h.metering.recordCompleteRawUsage('u', id, { model: haiku, rateVersion: 'v1', raw: { input: 7 } }), /authoritative input and output/);
  await admitted.settle({ input: 7, output: 3, raw: { input: 7, output: 3 } });
  // The live path persisted the figures before converting them; a settled hold keeps them and is never rewritten.
  assert.deepEqual(h.records()[0]!.fields['completeRawUsage'], { model: haiku, rateVersion: 'v1', raw: { input: 7, output: 3 } });
  await h.metering.recordCompleteRawUsage('u', id, { model: haiku, rateVersion: 'v1', raw: { input: 1, output: 1 } });
  assert.deepEqual(h.records()[0]!.fields['completeRawUsage'], { model: haiku, rateVersion: 'v1', raw: { input: 7, output: 3 } }, 'a settled hold is not rewritten');
  assert.equal(h.records()[0]!.fields['settledQuantity'], 11);
});

// 20. Inactive mode preserves existing behaviour.
test('C20: with the switch absent, admission takes the legacy input and output holds and never touches the unified meter', async () => {
  const h = await unifiedFixture({ legacy: true });
  await h.run();
  const keys = h.records().map((record) => record.fields['meterKey']).sort();
  assert.deepEqual(keys, [h.registry.inputTokenMeterKey, h.registry.outputTokenMeterKey].sort());
  assert.equal(h.usage(unifiedMeterKey), undefined);
  assert.equal(h.registry.aiUnified, undefined);
  assert.equal(h.usage(h.registry.inputTokenMeterKey)?.['consumed'], 7);
  assert.equal(h.usage(h.registry.outputTokenMeterKey)?.['consumed'], 3);
});

// 21. No wallet, Stripe or billing side effects.
test('C21: a unified run writes only usage, reservations, the session and the project', async () => {
  const h = await unifiedFixture();
  await h.run();
  for (const path of h.data.keys()) {
    assert.match(path, /^(users\/u\/(usage|reservations)\/|sessions\/s|projects\/p)/, `unexpected document ${path}`);
  }
  assert.ok(![...h.data.keys()].some((path) => /wallet|stripe|credit|invoice/i.test(path)));
});

// 22. PR B unlimited builds remain intact.
test('C22: builds remain unlimited by count under unified admission', async () => {
  const { db, data } = ledger();
  const registry = parseRegistry(unifiedRegistryDocument, 'registry');
  const plans = plansFor(registry);
  const entitlements = entitlementsOf(plans, 'free');
  const configuration = { get: async () => ({ registry, plans, rates: v1 }) } as unknown as ConfigurationStore;
  const entitlementService = { forUser: async () => entitlements } as unknown as EntitlementService;
  const metering = new MeteringService(db, configuration);
  const sessions = new SessionRepository(db, new ProjectRepository(db, {} as UserRepository, entitlementService), entitlementService, configuration, metering, 120);
  const model = entitlements.capabilities.stringList('ai.model.allowlist')[0]!;
  for (let i = 0; i < 12; i++) {
    data.set(`projects/p${i}`, { ownerUid: 'u', platform: 'web', name: `P${i}`, status: 'draft', activeSessionId: null, snapshotBytes: 0, createdAt: Timestamp.now(), visibility: 'private' });
    await sessions.create('u', `p${i}`, { model, effort: 'low', prompt: `build ${i}`, attachments: [] });
  }
  assert.equal(data.get(`users/u/usage/${registry.buildMeterKey}`)?.['consumed'], 12);
  assert.equal(data.get(`users/u/usage/${unifiedMeterKey}`), undefined, 'starting a build spends no unified tokens; the first call does');
});

// Estimate is an upper bound for any valid table.
test('C-UB: the estimate is never below what settlement can charge for the counted prompt, whatever order the table puts the prompt weights in', () => {
  // The counterexample that failed before the fix: plain input weighted above the 5m cache write.
  const inverted = parseAiRateTable({ version: 'x', referenceUnit: 'ref', models: { m: { tiers: [{ maxInputTokens: null,
    input: { num: 2, den: 1 }, output: { num: 1, den: 1 }, cacheWrite5m: { num: 1, den: 1 }, cacheWrite1h: { num: 3, den: 1 }, cacheRead: { num: 1, den: 10 } }] } } }, 'test');
  const estimate = unifiedEstimate(inverted, 'm', 100, 10);
  assert.equal(estimate, 210, 'every counted prompt token at the heaviest prompt weight (input, 2) plus output');
  for (const raw of [{ input: 100, output: 10 }, { cacheRead: 100, output: 10 }, { cacheCreation5m: 100, output: 10 }, { cacheCreation: 100, output: 10 }, { input: 50, cacheRead: 30, cacheCreation5m: 20, output: 10 }]) {
    assert.ok(unifiedFor(inverted, 'm', raw, { undividedCacheWrite: promptCacheTtl })!.unified <= estimate, JSON.stringify(raw));
  }
  // The ceiling is the max of the three prompt weights for the requested TTL.
  const tier = tierFor(inverted, 'm', 100)!;
  assert.deepEqual(promptWeightCeiling(tier, '5m'), { num: 2, den: 1 });
  assert.deepEqual(promptWeightCeiling(tier, '1h'), { num: 3, den: 1 });
  // Randomised: for every tier of every model in v1 and the inverted table, random raw usage whose prompt
  // total equals the counted prompt and whose output is within the ceiling never exceeds the estimate.
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (const table of [v1, inverted]) for (const model of table.models.keys()) for (let i = 0; i < 200; i++) {
    const counted = 1 + Math.floor(random() * 50_000), maxOut = 1 + Math.floor(random() * 8000);
    const split = [random(), random(), random()].map((x) => x * counted);
    const a = Math.floor(split[0]!), b = Math.floor(split[1]!), c = Math.max(0, counted - a - b);
    const raw = random() < 0.5 ? { input: a, cacheRead: b, cacheCreation5m: c, output: Math.floor(random() * maxOut) } : { cacheCreation: counted, output: maxOut };
    const prompt = (raw.input ?? 0) + (raw.cacheRead ?? 0) + (raw.cacheCreation5m ?? 0) + (raw.cacheCreation ?? 0);
    if (prompt > counted) continue;
    assert.ok(unifiedFor(table, model, raw, { undividedCacheWrite: promptCacheTtl })!.unified <= unifiedEstimate(table, model, counted, maxOut), `${table.version} ${model} ${JSON.stringify(raw)}`);
  }
});

// Switch-off: unified holds survive the registry switch being removed.
test('C-SO: unified holds opened while the switch was on still recover, record overruns and pin to their opening period after the switch is removed', async () => {
  const { db, data } = ledger();
  const unified = parseRegistry(unifiedRegistryDocument, 'registry');
  const legacy = parseRegistry(registryDocument, 'registry');
  let current = { registry: unified, plans: plansFor(unified), rates: v1 as AiRateTable | undefined };
  const metering = new MeteringService(db, { get: async () => current } as unknown as ConfigurationStore);
  const entitlements = entitlementsOf(current.plans, 'business');
  const reserve = (now: Date, quantity = 100) => db.runTransaction((tx: Transaction) => metering.reserveIn(tx, { uid: 'u', entitlements, meterKey: unifiedMeterKey, quantity, operationId: 'model-unified:s', now,
    kind: unifiedHoldKind, attributes: { model: haiku, rateVersion: 'v1' } }));
  const open = await reserve(march);          // in flight, nothing observed
  const observed = await reserve(march);      // in flight, usage journalled
  const overrun = await reserve(march);       // in flight, usage above the estimate
  const crossMonth = await reserve(march);    // settled after the month turns
  await metering.markInFlight('u', [open.id, observed.id, overrun.id, crossMonth.id]);
  await metering.recordObservedUsage('u', observed.id, 40);
  await metering.recordObservedUsage('u', overrun.id, 150);
  await metering.recordPartialUsage('u', open.id, { model: haiku, raw: { input: 7 }, complete: false, unified: 4, tier: 0, rateVersion: 'v1' });
  // The switch is turned off (and the rate table removed) with all four holds open.
  current = { registry: legacy, plans: plansFor(legacy), rates: undefined };
  assert.equal(current.registry.aiUnified, undefined);
  // Token recovery: proven-dead worker settles the silent hold at its estimate, carrying the partial evidence.
  await assert.rejects(metering.release('u', open.id), { code: 'usage/reconciliation-required' });
  assert.equal(await metering.reconcile('u', open.id, march, { unreportable: true }), true);
  const openRecord = data.get(`users/u/reservations/${open.id}`)!;
  assert.equal(openRecord['settledQuantity'], 100);
  assert.deepEqual((openRecord['evidence'] as { raw: unknown }).raw, { input: 7 });
  // Observed usage settles at the figure; overrun is recorded for the unified hold without the switch.
  assert.equal(await metering.reconcile('u', observed.id, march), true);
  assert.equal(data.get(`users/u/reservations/${observed.id}`)!['settledQuantity'], 40);
  assert.equal(await metering.reconcile('u', overrun.id, march), true);
  const overrunRecord = data.get(`users/u/reservations/${overrun.id}`)!;
  assert.deepEqual([overrunRecord['settledQuantity'], overrunRecord['overrunQuantity']], [150, 50]);
  assert.equal(data.get(`users/u/usage/${unifiedMeterKey}`)!['consumed'], 290);
  assert.equal(data.get(`users/u/usage/${unifiedMeterKey}`)!['reserved'], 100);
  // Opening-period attribution across the month boundary still holds without the switch.
  await metering.recordObservedUsage('u', crossMonth.id, 60);
  assert.equal(await metering.reconcile('u', crossMonth.id, april), true);
  const live = data.get(`users/u/usage/${unifiedMeterKey}`)!;
  assert.equal(live['reserved'], 0);
  assert.equal(live['consumed'], 0, 'April window: March\'s settlements rolled off and the late one never entered');
  assert.equal(data.get(`users/u/usage/${unifiedMeterKey}/periods/2026-03-01`)!['settledLate'], 60);
  assert.equal(data.get(`users/u/usage/${unifiedMeterKey}/periods/2026-03-01`)!['settled'], 290);
  assert.equal(data.get(`users/u/usage/${unifiedMeterKey}/periods/2026-04-01`), undefined);
  // A legacy hold on the same ledger is untouched by any of this.
  const legacyHold = await db.runTransaction((tx: Transaction) => metering.reserveIn(tx, { uid: 'u', entitlements, meterKey: legacy.inputTokenMeterKey, quantity: 10, operationId: 'model-input:s', now: march }));
  await metering.settle({ uid: 'u', reservationId: legacyHold.id, actualQuantity: 10, now: april });
  assert.equal(data.get(`users/u/usage/${legacy.inputTokenMeterKey}`)!['consumed'], 10, 'legacy late settlement still counts in the live window');
});

// Randomised ledger invariants.
test('ledger invariants hold under a random sequence of unified reservations, settlements, overruns and releases', async () => {
  const h = await unifiedFixture({ planKey: 'free' });
  let seed = 20261106;
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const open = new Map<string, number>();
  let consumed = 0, admitted = 0, refused = 0;
  for (let i = 0; i < 300; i++) {
    const roll = random();
    if (roll < 0.5 || open.size === 0) {
      const quantity = 1 + Math.floor(random() * 30_000);
      try {
        const hold = await h.db.runTransaction((tx: Transaction) => h.metering.reserveIn(tx, { uid: 'u', entitlements: h.entitlements, meterKey: unifiedMeterKey, quantity, operationId: 'fuzz', now: new Date() }));
        open.set(hold.id, quantity); admitted++;
      } catch (error) {
        assert.equal((error as AppError).code, 'usage/limit-reached'); refused++;
        assert.ok(consumed + [...open.values()].reduce((a, b) => a + b, 0) + quantity > h.limit, 'a refusal only when the ceiling would really be passed');
      }
    } else {
      const [id, estimate] = [...open][Math.floor(random() * open.size)]!;
      open.delete(id);
      const kind = random();
      if (kind < 0.6) { const actual = Math.floor(random() * estimate); await h.metering.settle({ uid: 'u', reservationId: id, actualQuantity: actual, now: new Date() }); consumed += actual; }
      else if (kind < 0.8) { const actual = estimate + Math.floor(random() * 500); await h.metering.settle({ uid: 'u', reservationId: id, actualQuantity: actual, recordOverrun: true, now: new Date() }); consumed += actual; }
      else { await h.metering.release('u', id); }
    }
    const usage = h.usage(unifiedMeterKey)!;
    assert.equal(usage['reserved'], [...open.values()].reduce((a, b) => a + b, 0));
    assert.equal(usage['consumed'], consumed);
    assert.ok((usage['reserved'] as number) >= 0 && (usage['consumed'] as number) >= 0);
  }
  assert.ok(admitted > 0 && refused > 0, `admitted ${admitted}, refused ${refused}`);
  const statuses = h.records().map((record) => record.fields['status']);
  assert.equal(statuses.filter((status) => status === 'OPEN').length, open.size);
});
