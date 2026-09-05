import type Anthropic from '@anthropic-ai/sdk';
import type { MessageCountTokensParams } from '@anthropic-ai/sdk/resources/messages';
import type { MeteringService } from '../metering/service.ts';
import type { AuthoritativeUsage, SpecialistReservations, ProblemReporter } from './agent.ts';

export interface CallAdmission {
  begin(input: {
    readonly params: MessageCountTokensParams;
    readonly maxOutputTokens: number;
    readonly outputReservationId?: string;
    readonly signal: AbortSignal;
  }): Promise<{ settle(usage: AuthoritativeUsage): Promise<void> }>;
}

/** Admission is shared by primary and specialist calls, including every tool loop. */
export function createCallAdmission(deps: {
  readonly anthropic: Anthropic;
  readonly uid: string;
  readonly sessionId: string;
  readonly inputMeterKey: string;
  readonly outputMeterKey: string;
  readonly metering: MeteringService;
  readonly reservations: SpecialistReservations;
  readonly authorize: () => Promise<void>;
  readonly onProblem: ProblemReporter;
}): CallAdmission {
  return {
    async begin(input) {
      input.signal.throwIfAborted();
      await deps.authorize();
      const count = await deps.anthropic.messages.countTokens(input.params, { signal: input.signal });
      if (!Number.isSafeInteger(count.input_tokens) || count.input_tokens <= 0) {
        throw new Error('Anthropic returned no usable input-token estimate.');
      }
      const holds: { id: string; kind: 'input' | 'output' }[] = [];
      let dispatchMarked = false;
      try {
        holds.push({ ...await deps.reservations.take({ meterKey: deps.inputMeterKey,
          quantity: count.input_tokens, operationId: `model-input:${deps.sessionId}` }), kind: 'input' });
        if (input.outputReservationId === undefined) {
          holds.push({ ...await deps.reservations.take({ meterKey: deps.outputMeterKey,
            quantity: input.maxOutputTokens, operationId: `model-output:${deps.sessionId}` }), kind: 'output' });
        }
        // A downgrade, cancellation or lease loss during the count/holds must
        // be observed before generation. No provider work has started yet.
        await deps.authorize();
        input.signal.throwIfAborted();
        // Set before awaiting: a lost commit acknowledgement is also ambiguous.
        dispatchMarked = true;
        await deps.metering.markInFlight(deps.uid, [
          ...holds.map((hold) => hold.id),
          ...(input.outputReservationId === undefined ? [] : [input.outputReservationId]),
        ]);
      } catch (cause) {
        if (!dispatchMarked) {
          for (const hold of holds) {
            try {
              await deps.metering.release(deps.uid, hold.id);
              await deps.reservations.forget(hold.id);
            } catch (cleanup) { deps.onProblem(cleanup instanceof Error ? cleanup : new Error(String(cleanup)), 'releasing an undispatched model hold'); }
          }
        }
        throw cause;
      }
      return {
        async settle(usage) {
          const failures: unknown[] = [];
          for (const hold of holds) {
            const actual = usage[hold.kind];
            if (actual === undefined) {
              deps.onProblem(new Error('Authoritative usage is unavailable; the hold remains open.'), 'model usage reconciliation required');
              continue;
            }
            try {
              await deps.metering.recordObservedUsage(deps.uid, hold.id, actual);
              await deps.metering.settle({ uid: deps.uid, reservationId: hold.id,
                actualQuantity: actual, recordOverrun: hold.kind === 'input', now: new Date() });
              await deps.reservations.forget(hold.id);
            } catch (error) { failures.push(error); }
          }
          if (failures.length > 0) throw new AggregateError(failures, 'Recording model usage failed.');
        },
      };
    },
  };
}
