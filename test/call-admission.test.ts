import assert from 'node:assert/strict';
import test from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import type { MeteringService, Reservation } from '../src/metering/service.ts';
import { createCallAdmission } from '../src/runner/call-admission.ts';

function harness(failSecond = false, rejectRecheck = false) {
  const events: string[] = [];
  let checks = 0;
  const admission = createCallAdmission({
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
  return { events, begin: () => admission.begin({ params: { model: 'test', messages: [{ role: 'user', content: 'hi' }] }, maxOutputTokens: 20, signal: new AbortController().signal }) };
}
test('a refused output hold releases the input hold without dispatching', async () => {
  const h = harness(true);
  await assert.rejects(h.begin(), /quota/);
  assert.deepEqual(h.events, ['hold:input:10', 'release:input', 'forget:input']);
});
test('lease loss during admission releases both undispatched holds', async () => {
  const h = harness(false, true);
  await assert.rejects(h.begin(), /lease lost/);
  assert.ok(!h.events.some((event) => event.startsWith('dispatch:')));
  assert.ok(h.events.includes('release:input'));
  assert.ok(h.events.includes('release:output'));
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
