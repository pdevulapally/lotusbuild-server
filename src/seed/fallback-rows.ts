import { parseFallbackPolicy, type FallbackPolicy } from '../entitlements/fallback.ts';
import type { MeterDefinition } from '../entitlements/schema.ts';

type Fields = Record<string, unknown>;

export interface FallbackAllowance {
  readonly planKey: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface FallbackChange {
  readonly path: string;
  readonly from: unknown;
  readonly to: unknown;
}

/** The approved fallback lane: a free OpenRouter model behind its own bounded allowances. */
export const fallbackMeters: readonly MeterDefinition[] = [
  { key: 'ai.fallback.tokens.input', unit: 'tokens', kind: 'COUNTER', resetPeriod: 'MONTHLY', label: 'Fallback input tokens' },
  { key: 'ai.fallback.tokens.output', unit: 'tokens', kind: 'COUNTER', resetPeriod: 'MONTHLY', label: 'Fallback output tokens' },
];

export const fallbackPolicyDocument = {
  provider: 'openrouter',
  model: 'google/gemma-4-31b-it:free',
  effort: 'low',
  eligiblePlanKeys: ['free', 'pro', 'business'],
  inputTokenMeterKey: 'ai.fallback.tokens.input',
  outputTokenMeterKey: 'ai.fallback.tokens.output',
  maxPremiumDispatches: 1,
  capacityRetrySeconds: 120,
  maxCheckpointBytes: 256 * 1024,
  maxOutputTokens: 8192,
} as const;

export const fallbackAllowances: readonly FallbackAllowance[] = [
  { planKey: 'free', inputTokens: 600_000, outputTokens: 60_000 },
  { planKey: 'pro', inputTokens: 2_000_000, outputTokens: 200_000 },
  { planKey: 'business', inputTokens: 2_000_000, outputTokens: 200_000 },
];

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Adds the fallback meters and policy to a live registry document. Every other
 * field is returned untouched; a meter that already exists with the same
 * definition is left alone, one with a different definition is refused rather
 * than silently redefined, because counters already recorded under it would
 * change meaning.
 */
export function withFallbackPolicy(registry: Fields, policy: Fields = fallbackPolicyDocument, meters: readonly MeterDefinition[] = fallbackMeters): { fields: Fields; changes: readonly FallbackChange[] } {
  const existing = registry['meters'];
  if (!Array.isArray(existing)) throw new Error('The registry document has no meters array.');
  const changes: FallbackChange[] = [];
  const merged: unknown[] = [...existing];
  for (const meter of meters) {
    const current = existing.find((row: unknown) => row !== null && typeof row === 'object' && (row as Fields)['key'] === meter.key);
    if (current === undefined) { merged.push(meter); changes.push({ path: `meters[${meter.key}]`, from: undefined, to: meter }); continue; }
    if (!same(current, meter)) throw new Error(`Meter ${meter.key} already exists with a different definition; refusing to redefine it.`);
  }
  const declared = new Map<string, MeterDefinition>(merged.map((row) => [(row as MeterDefinition).key, row as MeterDefinition]));
  const premium = ['inputTokenMeterKey', 'outputTokenMeterKey', 'buildMeterKey', 'sandboxTimeMeterKey', 'storageMeterKey'].map((key) => String(registry[key]));
  const parsed: FallbackPolicy | undefined = parseFallbackPolicy(policy, 'registry.fallback', declared, premium);
  if (parsed === undefined) throw new Error('A fallback policy is required.');
  if (!same(registry['fallback'], policy)) changes.push({ path: 'fallback', from: registry['fallback'], to: policy });
  return { fields: { ...registry, meters: merged, fallback: policy }, changes };
}

/**
 * Gives one plan its bounded fallback allowances: hard limits equal to the
 * included amount, never overage, so the fallback lane can never bill.
 */
export function withFallbackAllowances(plan: Fields, allowance: FallbackAllowance, policy: { readonly inputTokenMeterKey: string; readonly outputTokenMeterKey: string } = fallbackPolicyDocument): { fields: Fields; changes: readonly FallbackChange[] } {
  const rows = plan['meterLimits'];
  if (!Array.isArray(rows)) throw new Error('The plan document has no meterLimits array.');
  const wanted = [
    { meterKey: policy.inputTokenMeterKey, includedAllowance: allowance.inputTokens, hardLimit: allowance.inputTokens, overageEnabled: false },
    { meterKey: policy.outputTokenMeterKey, includedAllowance: allowance.outputTokens, hardLimit: allowance.outputTokens, overageEnabled: false },
  ];
  const changes: FallbackChange[] = [];
  const meterLimits: unknown[] = [...rows];
  for (const row of wanted) {
    const index = meterLimits.findIndex((current) => current !== null && typeof current === 'object' && (current as Fields)['meterKey'] === row.meterKey);
    const current = index === -1 ? undefined : meterLimits[index];
    if (same(current, row)) continue;
    changes.push({ path: `meterLimits[${row.meterKey}]`, from: current, to: row });
    if (index === -1) meterLimits.push(row); else meterLimits[index] = row;
  }
  return { fields: { ...plan, meterLimits }, changes };
}
