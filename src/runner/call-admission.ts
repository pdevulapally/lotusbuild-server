import { timed } from '../diagnostics/timing.ts';
import { AppError } from '../http/errors.ts';
import type Anthropic from '@anthropic-ai/sdk';
import type { MessageCountTokensParams } from '@anthropic-ai/sdk/resources/messages';
import type { AiCallEvidence, MeteringService } from '../metering/service.ts';
import { unifiedFor, type AiRateTable, type RawUsage } from '../entitlements/rates.ts';
import type { AuthoritativeUsage, SpecialistReservations, ProblemReporter } from './agent.ts';
import { modelOutputConfig, type ModelResolver } from '../models/catalog.ts';
import type { TokenCount } from '../models/provider.ts';
import type { AiEffort } from '../entitlements/build-admission.ts';

export interface CallAdmission {
  begin(input: {
    readonly params: MessageCountTokensParams;
    readonly effort: AiEffort;
    readonly maxOutputTokens: number;
    readonly outputReservationId?: string;
    readonly signal: AbortSignal;
  }): Promise<{ settle(usage: AuthoritativeUsage): Promise<void>; params: MessageCountTokensParams; maxOutputTokens: number }>;
}

/** Admission is shared by primary and specialist calls, including every tool loop. */
/**
 * Shadow accounting only: the raw categories are always kept; the unified figure is added when a rate
 * table knows the model and the conversion succeeds. A conversion failure is recorded as its absence,
 * never allowed to fail the settlement of a real hold. The call is complete only when the provider's
 * authoritative prompt and output figures both arrived: `message_start` states every prompt category
 * at once (so `input` stands for the prompt side), the final message or `message_delta` states the
 * output. An interrupted call lacks its output; an output-only or malformed payload lacks its prompt.
 * Either way the figure is known usage, not the call's total.
 */
export function shadowEvidence(rates: AiRateTable | undefined, model: string, raw: RawUsage): AiCallEvidence {
  const complete = raw.input !== undefined && raw.output !== undefined;
  if (rates === undefined) return { model, raw, complete };
  try {
    return { model, raw, complete, ...(unifiedFor(rates, model, raw) ?? {}) };
  } catch {
    return { model, raw, complete };
  }
}

export function createCallAdmission(deps: {
  readonly anthropic: Anthropic;
  /** Provider-specific input count; defaults to Anthropic's count_tokens. An estimate is still reserved in full and settled from authoritative usage. */
  readonly countInputTokens?: (params: MessageCountTokensParams, signal: AbortSignal) => Promise<TokenCount>;
  readonly models: ModelResolver;
  readonly uid: string;
  readonly sessionId: string;
  readonly maxInputTokens?: number;
  readonly inputMeterKey: string;
  readonly outputMeterKey: string;
  readonly metering: MeteringService;
  readonly reservations: SpecialistReservations;
  readonly authorize: () => Promise<void>;
  readonly onProblem: ProblemReporter;
  /** Unified-token rate table for shadow accounting; absent until seeded. */
  readonly rates?: AiRateTable;
}): CallAdmission {
  return {
    async begin(input) {
      input.signal.throwIfAborted();
      await deps.authorize();
      input.signal.throwIfAborted();
      const model = await deps.models.get(input.params.model);
      input.signal.throwIfAborted();
      const outputConfig = modelOutputConfig(model, input.effort);
      const { output_config: _ignored, ...base } = input.params;
      const params = { ...base, ...(outputConfig === undefined ? {} : { output_config: outputConfig }) };
      const maxOutputTokens = Math.min(input.maxOutputTokens, model.maxOutputTokens);
      const count = await timed('model.count_tokens', async (): Promise<TokenCount> => deps.countInputTokens === undefined
        ? { inputTokens: (await deps.anthropic.messages.countTokens(params, { signal: input.signal })).input_tokens, estimated: false }
        : deps.countInputTokens(params, input.signal));

      input.signal.throwIfAborted();
      if (!Number.isSafeInteger(count.inputTokens) || count.inputTokens <= 0) {
        throw new Error('The model provider returned no usable input-token estimate.');
      }
      if (deps.maxInputTokens !== undefined && count.inputTokens > deps.maxInputTokens) throw new AppError({ code: 'fallback/context-exceeded', statusCode: 409, message: 'The task now exceeds the verified fallback context window.' });
      const holds: { id: string; kind: 'input' | 'output' }[] = [];
      const settle = async (usage: AuthoritativeUsage): Promise<void> => {
        const failures: unknown[] = [];
        for (const hold of holds) {
          const actual = usage[hold.kind];
          if (actual === undefined) {
            const reason: unknown = input.signal.aborted ? input.signal.reason : undefined;
            if (!(reason instanceof AppError && reason.code === 'session/cancelled')) {
              deps.onProblem(new Error('Authoritative usage is unavailable; the hold remains open.'), 'model usage reconciliation required');
              continue;
            }
            // The user stopped this call before the provider reported usage. It
            // never will now, so the hold settles at what it reserved: bounded,
            // never under-charged, and the session can finish instead of waiting
            // forever for a reconciliation that cannot come.
            try {
              await deps.metering.settleUnobserved(deps.uid, hold.id);
              await deps.reservations.forget(hold.id);
            } catch (error) { failures.push(error); }
            continue;
          }
          try {
            await deps.metering.recordObservedUsage(deps.uid, hold.id, actual);
            // Shadow evidence travels with the input hold only, so a logical call is
            // recorded exactly once however its output hold is shared.
            const evidence = hold.kind === 'input' && usage.raw !== undefined
              ? shadowEvidence(deps.rates, input.params.model, usage.raw)
              : undefined;
            await deps.metering.settle({ uid: deps.uid, reservationId: hold.id,
              actualQuantity: actual, recordOverrun: hold.kind === 'input', now: new Date(), ...(evidence === undefined ? {} : { evidence }) });
            await deps.reservations.forget(hold.id);
          } catch (error) { failures.push(error); }
        }
        if (failures.length > 0) throw new AggregateError(failures, 'Recording model usage failed.');
      };
      try {
        holds.push({ ...await deps.reservations.take({ meterKey: deps.inputMeterKey,
          quantity: count.inputTokens, operationId: `model-input:${deps.sessionId}` }), kind: 'input' });
        if (input.outputReservationId === undefined) {
          holds.push({ ...await deps.reservations.take({ meterKey: deps.outputMeterKey,
            quantity: maxOutputTokens, operationId: `model-output:${deps.sessionId}` }), kind: 'output' });
        }
        // A downgrade, cancellation or lease loss during the count/holds must
        // be observed before generation. No provider work has started yet.
        await deps.authorize();
        input.signal.throwIfAborted();
        // Persist crash uncertainty before generation. This write is not dispatch.
        await deps.metering.markInFlight(deps.uid, [
          ...holds.map((hold) => hold.id),
          ...(input.outputReservationId === undefined ? [] : [input.outputReservationId]),
        ]);
        input.signal.throwIfAborted();
      } catch (cause) {
        // begin never invokes generation, even when the marker committed but its
        // acknowledgement was lost. Journal known zero before closing so recovery
        // can finish settlement if its own acknowledgement is lost. A specialist's
        // shared output hold belongs to its caller and may contain earlier usage.
        try { await settle({ input: 0, output: 0 }); }
        catch {
          deps.onProblem(new Error('Known-undispatched model usage reconciliation failed.'), 'closing an undispatched model call');
        }
        throw cause;
      }
      return { settle, params, maxOutputTokens };
    },
  };
}
