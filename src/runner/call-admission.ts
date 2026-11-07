import { timed } from '../diagnostics/timing.ts';
import { AppError } from '../http/errors.ts';
import type Anthropic from '@anthropic-ai/sdk';
import type { MessageCountTokensParams } from '@anthropic-ai/sdk/resources/messages';
import type { AiCallEvidence, MeteringService } from '../metering/service.ts';
import { promptWeightCeiling, tierFor, unifiedFor, type AiRateTable, type RawUsage } from '../entitlements/rates.ts';
import { unifiedHoldKind } from '../metering/service.ts';
import { promptCacheTtl } from './agent.ts';
import { EntitlementConfigError } from '../entitlements/values.ts';
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

export interface UnifiedAdmission {
  readonly meterKey: string;
  readonly rates: AiRateTable;
  readonly ratesByVersion: (version: string) => Promise<AiRateTable>;
}

/** Fields a unified hold is priced on; read back at settlement, never recomputed. */
export const unifiedHoldAttributes = { model: 'model', rateVersion: 'rateVersion' } as const;

/**
 * What one call can cost at most, in unified tokens: every counted prompt token at
 * the heaviest weight a prompt token can carry in its tier (plain input, cache read,
 * or a cache write at the TTL the request asks for — whichever the table makes
 * largest), plus the output ceiling at the output weight. One ceiling over the
 * whole figure, like settlement. Settlement reads an undivided cache figure at the
 * same TTL, so it can never price a counted prompt token above this. A prompt the
 * provider later counts above the estimate (crossing a tier) settles as a recorded
 * overrun, never silently.
 */
export function unifiedEstimate(table: AiRateTable, model: string, inputTokens: number, maxOutputTokens: number): number {
  const tier = tierFor(table, model, inputTokens);
  if (tier === undefined) throw new EntitlementConfigError(`Model "${model}" has no entry in rate table ${table.version}, so the call cannot be admitted.`);
  const prompt = promptWeightCeiling(tier, promptCacheTtl);
  const numerator = BigInt(inputTokens) * BigInt(prompt.num) * BigInt(tier.output.den) + BigInt(maxOutputTokens) * BigInt(tier.output.num) * BigInt(prompt.den);
  const denominator = BigInt(prompt.den) * BigInt(tier.output.den);
  const estimate = (numerator + denominator - 1n) / denominator;
  if (estimate > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`Unified estimate for ${model} exceeds the safe integer range.`);
  return Math.max(1, Number(estimate));
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
  /**
   * Unified AI Token admission. Present means every call takes one hold on this
   * meter, priced by `rates` at admission and settled by the table of the same
   * version; the legacy input/output holds are not taken. Absent is today's
   * behaviour. Chosen by the caller from the registry's `aiUnified` policy.
   */
  readonly unified?: UnifiedAdmission;
}): CallAdmission {
  if (deps.unified !== undefined && deps.unified.rates.models.size === 0) {
    throw new EntitlementConfigError(`Rate table ${deps.unified.rates.version} prices no model; unified admission cannot start.`);
  }
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
      if (deps.unified !== undefined) {
        return beginUnified(deps, deps.unified, input, params, maxOutputTokens, count.inputTokens);
      }
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

type AdmissionDeps = Parameters<typeof createCallAdmission>[0];
type Admitted = Awaited<ReturnType<CallAdmission['begin']>>;

/**
 * One hold per logical call. Pre-dispatch: the hold is taken for the estimate,
 * the lease and entitlement re-checked, and the hold marked in flight; only then
 * does the caller generate. Settlement converts the provider's authoritative raw
 * categories with the table of the version recorded on the hold, journals the
 * figure, and settles once; an overrun above the estimate is recorded, never
 * dropped, never allowed to go negative. A call whose figures are incomplete
 * (interrupted before output, or an undivided cache figure) stays open for
 * reconciliation exactly as a legacy hold would: estimate only on a proven Stop
 * or dead worker, never guessed here.
 */
async function beginUnified(deps: AdmissionDeps, unified: UnifiedAdmission,
  input: Parameters<CallAdmission['begin']>[0], params: Admitted['params'], maxOutputTokens: number, inputTokens: number): Promise<Admitted> {
  const model = input.params.model;
  const estimate = unifiedEstimate(unified.rates, model, inputTokens, maxOutputTokens);
  let hold: { readonly id: string } | undefined;
  const settle = async (usage: AuthoritativeUsage): Promise<void> => {
    if (hold === undefined) return;
    const id = hold.id;
    const raw = usage.raw;
    const knownZero = raw === undefined && usage.input === 0 && usage.output === 0;
    const complete = raw !== undefined && raw.input !== undefined && raw.output !== undefined;
    if (!knownZero && !complete) {
      const partial = raw === undefined ? undefined : shadowEvidence(unified.rates, model, raw);
      const reason: unknown = input.signal.aborted ? input.signal.reason : undefined;
      if (!(reason instanceof AppError && reason.code === 'session/cancelled')) {
        // Known figures are kept on the open hold for recovery and audit; they are
        // not the call's consumption, so nothing is journalled as observed.
        if (partial !== undefined) {
          try { await deps.metering.recordPartialUsage(deps.uid, id, partial); }
          catch (error) { deps.onProblem(error instanceof Error ? error : new Error(String(error)), 'recording partial model usage'); }
        }
        deps.onProblem(new Error('Authoritative usage is unavailable; the unified hold remains open.'), 'model usage reconciliation required');
        return;
      }
      // Stopped by the user before the provider finished reporting: settles at the
      // estimate, keeping whatever partial figures arrived as evidence marked partial.
      await deps.metering.settleUnobserved(deps.uid, id, new Date(), partial);
      await deps.reservations.forget(id);
      return;
    }
    let actual = 0;
    let evidence: AiCallEvidence | undefined;
    if (!knownZero && raw !== undefined) {
      // Priced under the version and model the hold was admitted with, as persisted on
      // the reservation — never the table in memory, which may have moved on since.
      const stored = await deps.metering.reservationRecord(deps.uid, id);
      const attributes = stored['attributes'] as Record<string, unknown> | undefined;
      const storedVersion = attributes?.[unifiedHoldAttributes.rateVersion], storedModel = attributes?.[unifiedHoldAttributes.model];
      if (typeof storedVersion !== 'string' || storedModel !== model) {
        deps.onProblem(new Error(`Unified hold ${id} carries no usable rate version/model (${String(storedVersion)}, ${String(storedModel)}); it remains open.`), 'model usage reconciliation required');
        return;
      }
      let table: AiRateTable;
      try { table = await unified.ratesByVersion(storedVersion); }
      catch (error) {
        deps.onProblem(error instanceof Error ? error : new Error(String(error)), 'model usage reconciliation required');
        return;
      }
      if (table.version !== storedVersion) {
        deps.onProblem(new Error(`Rate table ${table.version} is not the ${storedVersion} this hold was admitted under; it remains open.`), 'model usage reconciliation required');
        return;
      }
      const conversion = unifiedFor(table, model, raw, { undividedCacheWrite: promptCacheTtl });
      if (conversion === undefined) {
        deps.onProblem(new EntitlementConfigError(`Model "${model}" is absent from rate table ${table.version}; the unified hold remains open.`), 'model usage reconciliation required');
        return;
      }
      actual = conversion.unified;
      evidence = { model, raw, complete: true, ...conversion };
    }
    await deps.metering.recordObservedUsage(deps.uid, id, actual);
    await deps.metering.settle({ uid: deps.uid, reservationId: id, actualQuantity: actual, recordOverrun: true, now: new Date(),
      ...(evidence === undefined ? {} : { evidence }) });
    await deps.reservations.forget(id);
  };
  try {
    hold = await deps.reservations.take({ meterKey: unified.meterKey, quantity: estimate, operationId: `model-unified:${deps.sessionId}`, kind: unifiedHoldKind,
      attributes: { [unifiedHoldAttributes.model]: model, [unifiedHoldAttributes.rateVersion]: unified.rates.version } });
    await deps.authorize();
    input.signal.throwIfAborted();
    await deps.metering.markInFlight(deps.uid, [hold.id]);
    input.signal.throwIfAborted();
  } catch (cause) {
    try { await settle({ input: 0, output: 0 }); }
    catch { deps.onProblem(new Error('Known-undispatched model usage reconciliation failed.'), 'closing an undispatched model call'); }
    throw cause;
  }
  return { settle, params, maxOutputTokens };
}
