import assert from 'node:assert/strict';
import { fixtureModels } from './support/models.ts';
import test from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import type { ContentBlock } from '@anthropic-ai/sdk/resources/messages';
import { MeteringService, type Reservation } from '../src/metering/service.ts';
import { createCallAdmission } from '../src/runner/call-admission.ts';
import { runAgentTurn } from '../src/runner/agent.ts';
import { Timestamp } from 'firebase-admin/firestore';
import { parseRegistry, parsePlan } from '../src/entitlements/schema.ts';
import { ResolvedEntitlements, type EntitlementService, type UserEntitlements } from '../src/entitlements/service.ts';
import type { ConfigurationStore } from '../src/entitlements/store.ts';
import { registryDocument, planDocuments } from '../src/seed/config.ts';
import { ProjectRepository } from '../src/projects/repository.ts';
import { SessionRepository } from '../src/sessions/repository.ts';
import type { UserRepository } from '../src/users/repository.ts';
import type { RunningSandbox } from '../src/sandboxes/provider.ts';
import { ledger } from './support/ledger.ts';

function harness(failSecond = false, rejectRecheck = false, models = fixtureModels) {
  const events: string[] = [];
  let checks = 0;
  const admission = createCallAdmission({
    models,
    uid: 'user', sessionId: 'session', inputMeterKey: 'input', outputMeterKey: 'output',
    anthropic: { messages: { countTokens: async () => ({ input_tokens: 10 }) } } as unknown as Anthropic,
    authorize: async () => { checks++; if (rejectRecheck && checks === 2) throw new Error('lease lost'); },
    onProblem: (_error, context) => { events.push(context); },
    reservations: {
      take: async ({ meterKey, quantity }) => {
        if (failSecond && meterKey === 'output') throw new Error('quota');
        events.push(`hold:${meterKey}:${quantity}`);
        return { id: meterKey } as Reservation;
      },
      forget: async (id) => { events.push(`forget:${id}`); },
    },
    metering: {
      markInFlight: async (_uid: string, ids: string[]) => { events.push(`dispatch:${ids.join(',')}`); },
      release: async (_uid: string, id: string) => { events.push(`release:${id}`); },
      recordObservedUsage: async (_uid: string, id: string, quantity: number) => { events.push(`journal:${id}:${quantity}`); },
      settle: async (input: { reservationId: string; actualQuantity: number; recordOverrun: boolean }) => {
        events.push(`settle:${input.reservationId}:${input.actualQuantity}:${input.recordOverrun}`);
      },
    } as unknown as MeteringService,
  });
  return { events, begin: () => admission.begin({ effort: 'low', params: { model: 'test', messages: [{ role: 'user', content: 'hi' }] }, maxOutputTokens: 20, signal: new AbortController().signal }) };
}
test('a refused output hold releases the input hold without dispatching', async () => {
  const h = harness(true);
  await assert.rejects(h.begin(), /quota/);
  assert.deepEqual(h.events, ['hold:input:10', 'journal:input:0', 'settle:input:0:true', 'forget:input']);
});

test('native reasoning omits effort from counted and generated params and bounds output tokens', async () => {
  const h = harness(false, false, {get: async id => ({id, name: id, efforts: [], maxOutputTokens: 12})});
  const admitted = await h.begin();
  assert.equal(Object.hasOwn(admitted.params, 'output_config'), false);
  assert.equal(admitted.maxOutputTokens, 12);
  assert.ok(h.events.includes('hold:output:12'));
});
test('unsupported provider effort fails before any token holds are created', async () => {
  const h = harness(false, false, {get: async id => ({id, name: id, efforts: ['standard'], maxOutputTokens: 12})});
  await assert.rejects(h.begin(), /does not support/);
  assert.deepEqual(h.events, []);
});
test('lease loss during admission releases both undispatched holds', async () => {
  const h = harness(false, true);
  await assert.rejects(h.begin(), /lease lost/);
  assert.ok(!h.events.some((event) => event.startsWith('dispatch:')));
  assert.ok(h.events.includes('settle:input:0:true'));
  assert.ok(h.events.includes('settle:output:0:false'));
});
test('observed usage is journalled before settlement and input overruns are recorded', async () => {
  const h = harness();
  await (await h.begin()).settle({ input: 15, output: 7 });
  assert.deepEqual(h.events, ['hold:input:10', 'hold:output:20', 'dispatch:input,output',
    'journal:input:15', 'settle:input:15:true', 'forget:input', 'journal:output:7', 'settle:output:7:false', 'forget:output']);
});
test('missing authoritative usage preserves dispatched holds', async () => {
  const h = harness();
  await (await h.begin()).settle({ input: undefined, output: undefined });
  assert.ok(h.events.includes('dispatch:input,output'));
  assert.ok(!h.events.some((event) => /^(release|forget|settle|journal):/.test(event)));
});

test('token counting receives cancellation and creates no holds after its aborted response', async () => {
  const controller = new AbortController();
  let holds = 0;
  const admission = createCallAdmission({ models: fixtureModels, uid: 'u', sessionId: 's', inputMeterKey: 'input', outputMeterKey: 'output',
    anthropic: { messages: { countTokens: async (_params: unknown, options: { signal: AbortSignal }) => {
      assert.equal(options.signal, controller.signal); controller.abort(); return { input_tokens: 10 };
    } } } as unknown as Anthropic,
    authorize: async () => {}, onProblem: () => {}, metering: {} as MeteringService,
    reservations: { take: async () => { holds++; throw new Error('Must not reserve after cancellation'); }, forget: async () => {} },
  });
  await assert.rejects(admission.begin({ effort: 'low', params: { model: 'test', messages: [] }, maxOutputTokens: 10, signal: controller.signal }));
  assert.equal(holds, 0);
});

/** Real admission, agent, fenced session reservations and metering; fake only the store and SDK. */
async function modelFixture(models = fixtureModels) {
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
  data.set('projects/p', { ownerUid: 'u', platform: 'web', name: 'Fixture', status: 'draft', activeSessionId: 's', snapshotBytes: 0, createdAt: Timestamp.now() });
  data.set('sessions/s', { ownerUid: 'u', projectId: 'p', status: 'QUEUED', model: entitlements.capabilities.stringList('ai.model.allowlist')[0],
    effort: 'high', claimableAt: Timestamp.now(), messageCount: 1, createdAt: Timestamp.now() });
  const session = (await sessions.claim('runner'))!;
  const authority = { sessionId: 's', runnerId: 'runner', token: session.leaseToken! };
  const controller = new AbortController();
  const problems: { error: Error; what: string }[] = [];
  const onProblem = (error: Error, what: string) => { problems.push({ error, what }); };
  let calls = 0;
  const requests: unknown[] = [];
  const sdk = {
    countTokens: async (params: unknown) => {requests.push(params); return {input_tokens: 10};},
    stream: (params?: unknown) => {
      requests.push(params);
      calls++;
      return { on: () => {}, finalMessage: async (): Promise<{ content: ContentBlock[]; usage: { input_tokens: number; output_tokens: number }; stop_reason: string }> => ({
        content: [{ type: 'text', text: 'Done', citations: null }], usage: { input_tokens: 7, output_tokens: 3 }, stop_reason: 'end_turn',
      }) };
    },
  };
  const anthropic = { messages: sdk } as unknown as Anthropic;
  const reservations = {
    take: (input: { meterKey: string; quantity: number; operationId: string }) => sessions.reserveSpecialistTokens('s', 'runner', {
      ...input, leaseToken: authority.token, entitlements, now: new Date(),
    }),
    forget: (id: string) => sessions.forgetSpecialistReservation('s', authority, id),
  };
  const admission = createCallAdmission({ models, anthropic, uid: 'u', sessionId: 's',
    inputMeterKey: registry.inputTokenMeterKey, outputMeterKey: registry.outputTokenMeterKey, metering, reservations,
    authorize: () => sessions.assertPersistenceLease(authority), onProblem });
  const begin = () => admission.begin({ effort: 'low', params: { model: session.model, messages: [] }, maxOutputTokens: 20, signal: controller.signal });
  const run = async () => runAgentTurn({ admission, anthropic, session, project: await projects.readOwned('u', 'p'),
    provider: registry.sandboxProviders.get('web')!, sandbox: { readFile: async () => 'Fixture file' } as unknown as RunningSandbox, withValidationSandbox: undefined,
    messages: [{ seq: 0, role: 'user', content: 'Build', createdAt: new Date() }], entitlements, registry, metering,
    limits: { maxSteps: 2, maxOutputTokens: 20, toolOutputMaxChars: 4096, maxSpecialistConsultations: 1,
      specialistMaxSteps: 2, commandTimeoutMs: 1000, previewReadyTimeoutSeconds: 1 },
    events: { text: () => {}, step: async () => {}, toolCall: async () => {}, toolResult: async () => {},
      preview: async () => {}, specialistStarted: async () => {}, specialistCompleted: async () => {} },
    signal: controller.signal, assertStillOurs: () => {}, drainSteer: () => undefined, desktopReady: false, reservations, onProblem });
  const records = () => [...data].filter(([path]) => path.startsWith('users/u/reservations/')).map(([path, fields]) => ({ id: path.split('/').at(-1)!, fields }));
  const usage = (key: string) => data.get(`users/u/usage/${key}`)!;
  return { db, data, metering, registry, entitlements, sessions, authority, sdk, controller, problems, reservations,
    admission, begin, run, records, usage, requests, calls: () => calls };
}

test('native-effort agent generation and token counting both omit the unsupported parameter', async () => {
  const h = await modelFixture({get: async id => ({id, name: id, efforts: [], maxOutputTokens: 8})});
  await h.run();
  assert.equal(h.calls(), 1);
  assert.equal(h.requests.length, 2);
  for (const params of h.requests) assert.equal(Object.hasOwn(params as object, 'output_config'), false);
  assert.equal((h.requests[1] as {max_tokens: number}).max_tokens, 8);
});

test('I05: committed mark with lost acknowledgement never invokes generation and restores quota', async () => {
  const h = await modelFixture();
  const primary = new Error('mark acknowledgement lost');
  const mark = h.metering.markInFlight.bind(h.metering);
  h.metering.markInFlight = async (uid, ids) => { await mark(uid, ids); throw primary; };
  await assert.rejects(h.run(), (error) => error === primary);
  assert.equal(h.calls(), 0);
  assert.equal(h.records().length, 2);
  for (const { fields } of h.records()) {
    assert.equal(fields['status'], 'SETTLED');
    assert.equal(fields['observedQuantity'], 0);
    assert.equal(fields['settledQuantity'], 0);
    assert.equal(fields['inFlight'], true, 'retain the attempted ledger marker as history');
    const usage = h.usage(fields['meterKey'] as string);
    assert.equal(usage['reserved'], 0);
    assert.equal(usage['consumed'], 0);
  }
  assert.deepEqual(h.data.get('sessions/s')!['specialistReservationIds'], []);
  assert.equal(h.problems.length, 0);
});

for (const window of ['before commit', 'cancel during mark', 'cancel after mark commit', 'cancel after admission'] as const) {
  test(`known-undispatched cleanup restores both holds: ${window}`, async () => {
    const h = await modelFixture();
    const primary = new Error(window);
    const mark = h.metering.markInFlight.bind(h.metering);
    if (window === 'cancel after admission') {
      const begin = h.admission.begin.bind(h.admission);
      h.admission.begin = async (input) => { const admitted = await begin(input); h.controller.abort(primary); return admitted; };
    } else {
      h.metering.markInFlight = async (uid, ids) => {
        if (window === 'before commit') throw primary;
        if (window === 'cancel after mark commit') await mark(uid, ids);
        h.controller.abort(primary);
        if (window === 'cancel during mark') throw primary;
      };
    }
    await assert.rejects(h.run(), (error) => error === primary);
    assert.equal(h.calls(), 0);
    assert.equal(h.records().length, 2);
    for (const { fields } of h.records()) {
      assert.equal(fields['status'], 'SETTLED');
      assert.equal(fields['settledQuantity'], 0);
      assert.equal(h.usage(fields['meterKey'] as string)['reserved'], 0);
      assert.equal(h.usage(fields['meterKey'] as string)['consumed'], 0);
    }
  });
}

for (const window of ['synchronous invocation failure', 'response failure', 'abort after invocation', 'timeout after invocation'] as const) {
  test(`provider uncertainty is never reconciled as undispatched: ${window}`, async () => {
    const h = await modelFixture();
    const primary = window === 'timeout after invocation' ? new DOMException(window, 'TimeoutError') : new Error(window);
    const stream = h.sdk.stream;
    h.sdk.stream = () => {
      const result = stream();
      if (window === 'synchronous invocation failure') throw primary;
      result.finalMessage = async () => {
        if (window === 'abort after invocation' || window === 'timeout after invocation') h.controller.abort(primary);
        throw primary;
      };
      return result;
    };
    await assert.rejects(h.run(), (error) => error === primary);
    assert.equal(h.calls(), 1);
    for (const { fields } of h.records()) {
      assert.equal(fields['status'], 'OPEN');
      assert.equal(fields['inFlight'], true);
      assert.equal(fields['observedQuantity'], undefined);
      assert.equal(fields['settledQuantity'], undefined);
      assert.equal(h.usage(fields['meterKey'] as string)['reserved'], fields['estimatedQuantity']);
      assert.equal(h.usage(fields['meterKey'] as string)['consumed'], 0);
    }
    assert.equal((h.data.get('sessions/s')!['specialistReservationIds'] as string[]).length, 2);
  });
}

test('successful provider usage settles exactly once and duplicate cleanup cannot reopen holds', async () => {
  const h = await modelFixture();
  await h.run();
  assert.equal(h.calls(), 1);
  for (const { id, fields } of h.records()) {
    const actual = fields['meterKey'] === h.registry.inputTokenMeterKey ? 7 : 3;
    assert.equal(fields['status'], 'SETTLED');
    assert.equal(fields['observedQuantity'], actual);
    assert.equal(fields['settledQuantity'], actual);
    await h.metering.recordObservedUsage('u', id, actual);
    assert.equal(await h.metering.reconcile('u', id), false);
    assert.equal(await h.metering.settle({ uid: 'u', reservationId: id, actualQuantity: actual, now: new Date() }), false);
    await assert.rejects(h.metering.markInFlight('u', [id]), /closed reservation/);
    await assert.rejects(h.metering.recordObservedUsage('u', id, 0), /contradicts/);
    assert.equal(h.usage(fields['meterKey'] as string)['reserved'], 0);
    assert.equal(h.usage(fields['meterKey'] as string)['consumed'], actual);
  }
});

test('duplicate known-undispatched settlement restores quota without touching another reservation', async () => {
  const h = await modelFixture();
  const other = await h.metering.reserve({ uid: 'u', entitlements: h.entitlements, meterKey: h.registry.inputTokenMeterKey,
    quantity: 5, operationId: 'unrelated-call', now: new Date() });
  await h.metering.markInFlight('u', [other.id]);
  const otherBefore = { ...await h.metering.reservationRecord('u', other.id) };
  const admitted = await h.begin();
  assert.equal(h.usage(h.registry.inputTokenMeterKey)['reserved'], 15);
  await Promise.all([admitted.settle({ input: 0, output: 0 }), admitted.settle({ input: 0, output: 0 })]);
  await admitted.settle({ input: 0, output: 0 });
  assert.equal(h.calls(), 0);
  assert.deepEqual(await h.metering.reservationRecord('u', other.id), otherBefore);
  assert.equal(h.usage(h.registry.inputTokenMeterKey)['reserved'], 5);
  assert.equal(h.usage(h.registry.outputTokenMeterKey)['reserved'], 0);
  for (const { id, fields } of h.records()) if (id !== other.id) {
    assert.equal(fields['status'], 'SETTLED');
    assert.equal(fields['settledQuantity'], 0);
    assert.equal(h.usage(fields['meterKey'] as string)['consumed'], 0);
  }
  // Prove spendable capacity through the actual reservation admission, not just status.
  const capped = { ...h.entitlements, meterLimits: new Map(h.entitlements.meterLimits) };
  capped.meterLimits.set(h.registry.inputTokenMeterKey, { meterKey: h.registry.inputTokenMeterKey, includedAllowance: 15, hardLimit: 15, overageEnabled: false });
  await h.metering.reserve({ uid: 'u', entitlements: capped, meterKey: h.registry.inputTokenMeterKey,
    quantity: 10, operationId: 'next-call', now: new Date() });
  assert.equal(h.usage(h.registry.inputTokenMeterKey)['reserved'], 15);
});

for (const stage of ['observation', 'settlement'] as const) {
  test(`lost ${stage} acknowledgement during cleanup remains durably reconcilable and idempotent`, async () => {
    const h = await modelFixture();
    const primary = new Error('original mark acknowledgement failure');
    const mark = h.metering.markInFlight.bind(h.metering);
    h.metering.markInFlight = async (uid, ids) => { await mark(uid, ids); throw primary; };
    const observe = h.metering.recordObservedUsage.bind(h.metering);
    const settle = h.metering.settle.bind(h.metering);
    let failed = false;
    if (stage === 'observation') h.metering.recordObservedUsage = async (...args) => {
      await observe(...args);
      if (!failed) { failed = true; throw new Error('private ledger payload'); }
    };
    else h.metering.settle = async (input) => {
      const result = await settle(input);
      if (!failed) { failed = true; throw new Error('private ledger payload'); }
      return result;
    };
    await assert.rejects(h.run(), (error) => error === primary);
    assert.equal(h.calls(), 0);
    assert.equal(h.problems.length, 1);
    assert.ok(!h.problems[0]!.error.message.includes('private ledger payload'));
    assert.equal((h.data.get('sessions/s')!['specialistReservationIds'] as string[]).length, 1);
    h.metering.recordObservedUsage = observe;
    h.metering.settle = settle;
    for (const { id, fields } of h.records()) {
      assert.equal(fields['observedQuantity'], 0, 'known non-dispatch survives failed cleanup acknowledgement');
      await h.metering.reconcile('u', id);
      assert.equal(await h.metering.reconcile('u', id), false);
      await h.reservations.forget(id);
      assert.equal(h.usage(fields['meterKey'] as string)['reserved'], 0);
      assert.equal(h.usage(fields['meterKey'] as string)['consumed'], 0);
    }
    assert.deepEqual(h.data.get('sessions/s')!['specialistReservationIds'], []);
  });
}

for (const stage of ['authorization', 'token counting', 'reservation acknowledgement', 'marking'] as const) {
  test(`timeout before generation preserves a recoverable zero-cost outcome: ${stage}`, async () => {
    const h = await modelFixture();
    const timeout = new DOMException('Timed out before generation', 'TimeoutError');
    if (stage === 'authorization') h.sessions.assertPersistenceLease = async () => { throw timeout; };
    if (stage === 'token counting') h.sdk.countTokens = async () => { throw timeout; };
    if (stage === 'reservation acknowledgement') {
      const take = h.reservations.take;
      h.reservations.take = async (input) => { await take(input); throw timeout; };
    }
    if (stage === 'marking') {
      const mark = h.metering.markInFlight.bind(h.metering);
      h.metering.markInFlight = async (uid, ids) => { await mark(uid, ids); throw timeout; };
    }
    await assert.rejects(h.run(), (error) => error === timeout);
    assert.equal(h.calls(), 0);
    if (stage === 'authorization' || stage === 'token counting') assert.equal(h.records().length, 0);
    for (const { id, fields } of h.records()) {
      // A take acknowledgement can lose the local ID, but the real atomic take
      // retained it on the session without an in-flight marker for existing recovery.
      if (stage === 'reservation acknowledgement') {
        assert.ok((h.data.get('sessions/s')!['specialistReservationIds'] as string[]).includes(id));
        assert.equal(fields['inFlight'], undefined);
      }
      await h.metering.reconcile('u', id);
      assert.equal(h.usage(fields['meterKey'] as string)['reserved'], 0);
      assert.equal(h.usage(fields['meterKey'] as string)['consumed'], 0);
    }
  });
}

for (const failure of ['first mark', 'later mark', 'synchronous dispatch'] as const) {
  test(`specialist shared output preserves the correct dispatch evidence: ${failure}`, async () => {
    const h = await modelFixture();
    const role = [...h.registry.specialists.values()].find((item) => !item.validation)!.key;
    const mark = h.metering.markInFlight.bind(h.metering);
    let marks = 0;
    h.metering.markInFlight = async (uid, ids) => {
      await mark(uid, ids);
      marks++;
      if ((failure === 'first mark' && marks === 2) || (failure === 'later mark' && marks === 3)) {
        throw new Error('Specialist mark acknowledgement lost');
      }
    };
    const stream = h.sdk.stream;
    h.sdk.stream = () => {
      const result = stream();
      const invocation = h.calls();
      if (failure === 'synchronous dispatch' && invocation === 2) throw new Error('SDK invocation failed synchronously');
      if (invocation === 1) result.finalMessage = async () => ({
        content: [{ type: 'tool_use', id: 'consult', name: 'consult_specialist', input: { role, question: 'Inspect the file' }, caller: { type: 'direct' } }],
        usage: { input_tokens: 7, output_tokens: 3 }, stop_reason: 'tool_use',
      });
      if (failure === 'later mark' && invocation === 2) result.finalMessage = async () => ({
        content: [{ type: 'tool_use', id: 'read', name: 'read_file', input: { path: 'README.md' }, caller: { type: 'direct' } }],
        usage: { input_tokens: 7, output_tokens: 3 }, stop_reason: 'tool_use',
      });
      return result;
    };
    await h.run();
    const shared = h.records().filter(({ fields }) => String(fields['operationId']).startsWith('specialist:'));
    assert.equal(shared.length, 1);
    const fields = shared[0]!.fields;
    if (failure === 'synchronous dispatch') {
      assert.equal(fields['status'], 'OPEN');
      assert.equal(fields['observedQuantity'], undefined);
      assert.equal(fields['settledQuantity'], undefined);
      assert.equal(h.usage(h.registry.outputTokenMeterKey)['reserved'], 40);
      const specialistInput = h.records().filter(({ fields }) => fields['status'] === 'OPEN' && fields['meterKey'] === h.registry.inputTokenMeterKey);
      assert.equal(specialistInput.length, 1);
    } else {
      assert.equal(fields['status'], 'SETTLED');
      assert.equal(fields['settledQuantity'], failure === 'first mark' ? 0 : 3);
      assert.equal(h.usage(h.registry.outputTokenMeterKey)['reserved'], 0);
      assert.ok(h.records().every(({ fields }) => fields['status'] === 'SETTLED'));
      assert.equal(h.calls(), failure === 'first mark' ? 2 : 3, 'failed admission adds no generation invocation');
    }
  });
}
