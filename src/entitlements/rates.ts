import { EntitlementConfigError } from './values.ts';

/**
 * Unified-token rate table: how raw provider usage converts into the one
 * customer-facing AI allowance. Weights are exact rationals relative to the
 * reference unit (one Sonnet 5 input token), stored as configuration so a
 * provider price change is a new version, never a code change.
 *
 * Lives at `config/aiRates` (the current table, carrying its own `version`);
 * superseded tables are archived at `config/aiRates/versions/{version}` by the
 * admin script. PR A only reads the current document.
 */
export const aiRatesDocumentPath = 'config/aiRates';
/** Where a superseded table of the given version is archived, so a hold admitted under it settles under it. */
export function aiRatesVersionPath(version: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(version)) throw new EntitlementConfigError(`Rate table version "${version}" is not a valid document id.`);
  return `${aiRatesDocumentPath}/versions/${version}`;
}

export interface Rational { readonly num: number; readonly den: number }

export interface AiRateTier {
  /** Requests whose prompt (all input categories) is at most this many tokens use this tier; `null` = no upper bound. */
  readonly maxInputTokens: number | null;
  readonly input: Rational;
  readonly output: Rational;
  readonly cacheWrite5m: Rational;
  readonly cacheWrite1h: Rational;
  readonly cacheRead: Rational;
}

export interface AiRateTable {
  readonly version: string;
  readonly referenceUnit: string;
  /** Keyed by the exact provider model id used in the catalog. */
  readonly models: ReadonlyMap<string, readonly AiRateTier[]>;
}

/** Raw provider categories for one call. `undefined` means the provider did not report the category. */
export interface RawUsage {
  readonly input?: number;
  readonly cacheRead?: number;
  readonly cacheCreation5m?: number;
  readonly cacheCreation1h?: number;
  /** Cache creation the provider reported without a TTL breakdown. */
  readonly cacheCreation?: number;
  readonly output?: number;
}

const rateCategories = ['input', 'output', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead'] as const;

function rational(value: unknown, where: string): Rational {
  if (typeof value !== 'object' || value === null) throw new EntitlementConfigError(`${where} must be a {num, den} rational.`);
  const { num, den } = value as Record<string, unknown>;
  if (!Number.isSafeInteger(num) || (num as number) < 0) throw new EntitlementConfigError(`${where}.num must be a non-negative safe integer.`);
  if (!Number.isSafeInteger(den) || (den as number) < 1) throw new EntitlementConfigError(`${where}.den must be a positive safe integer.`);
  return { num: num as number, den: den as number };
}

export function parseAiRateTable(value: unknown, where: string): AiRateTable {
  if (typeof value !== 'object' || value === null) throw new EntitlementConfigError(`${where} is not an object.`);
  const fields = value as Record<string, unknown>;
  if (typeof fields['version'] !== 'string' || fields['version'].length === 0) throw new EntitlementConfigError(`${where}.version must be a non-empty string.`);
  if (typeof fields['referenceUnit'] !== 'string' || fields['referenceUnit'].length === 0) throw new EntitlementConfigError(`${where}.referenceUnit must be a non-empty string.`);
  const rawModels = fields['models'];
  if (typeof rawModels !== 'object' || rawModels === null) throw new EntitlementConfigError(`${where}.models is not an object.`);
  const models = new Map<string, readonly AiRateTier[]>();
  for (const [modelId, entry] of Object.entries(rawModels as Record<string, unknown>)) {
    const at = `${where}.models.${modelId}`;
    const tiers = (entry as Record<string, unknown> | null)?.['tiers'];
    if (!Array.isArray(tiers) || tiers.length === 0) throw new EntitlementConfigError(`${at}.tiers must be a non-empty array.`);
    const parsed: AiRateTier[] = tiers.map((tier, index) => {
      const t = `${at}.tiers[${index}]`;
      if (typeof tier !== 'object' || tier === null) throw new EntitlementConfigError(`${t} is not an object.`);
      const max = (tier as Record<string, unknown>)['maxInputTokens'];
      if (max !== null && (!Number.isSafeInteger(max) || (max as number) < 1)) throw new EntitlementConfigError(`${t}.maxInputTokens must be null or a positive safe integer.`);
      const weights = Object.fromEntries(rateCategories.map((key) => [key, rational((tier as Record<string, unknown>)[key], `${t}.${key}`)]));
      return { maxInputTokens: max as number | null, ...weights } as AiRateTier;
    });
    for (let i = 1; i < parsed.length; i += 1) {
      const previous = parsed[i - 1]!.maxInputTokens, current = parsed[i]!.maxInputTokens;
      if (previous === null || (current !== null && current <= previous)) throw new EntitlementConfigError(`${at}.tiers must have strictly increasing maxInputTokens with only the last unbounded.`);
    }
    if (parsed[parsed.length - 1]!.maxInputTokens !== null) throw new EntitlementConfigError(`${at}.tiers: the last tier must be unbounded (maxInputTokens: null).`);
    models.set(modelId, parsed);
  }
  return { version: fields['version'], referenceUnit: fields['referenceUnit'], models };
}

export interface UnifiedConversion {
  readonly unified: number;
  readonly tier: number;
  readonly rateVersion: string;
}

/**
 * Converts one call's raw usage into unified tokens: exact rational arithmetic in
 * BigInt, rounded up once over the whole call. Categories the provider did not
 * report contribute nothing — they are not assumed to be zero, they are absent.
 * Cache creation without a TTL breakdown is priced at the 5-minute write rate,
 * the lower of the two. Returns undefined for a model the table does not price.
 */
export function unifiedFor(table: AiRateTable, modelId: string, usage: RawUsage, options: { readonly undividedCacheWrite?: '5m' | '1h' } = {}): UnifiedConversion | undefined {
  const tiers = table.models.get(modelId);
  if (tiers === undefined) return undefined;
  const prompt = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheCreation5m ?? 0) + (usage.cacheCreation1h ?? 0) + (usage.cacheCreation ?? 0);
  const tierIndex = tiers.findIndex((tier) => tier.maxInputTokens === null || prompt <= tier.maxInputTokens);
  const tier = tiers[tierIndex]!;
  const parts: readonly [number | undefined, Rational][] = [
    [usage.input, tier.input], [usage.output, tier.output], [usage.cacheRead, tier.cacheRead],
    [usage.cacheCreation5m, tier.cacheWrite5m], [usage.cacheCreation1h, tier.cacheWrite1h],
    // Shadow accounting keeps PR A's 5-minute reading of an undivided figure; active admission asks for the 1-hour
    // weight, the higher of the two, so a payload without a TTL breakdown can never under-charge.
    [usage.cacheCreation, options.undividedCacheWrite === '1h' ? tier.cacheWrite1h : tier.cacheWrite5m],
  ];
  // Sum of fractions over a common denominator, then one ceiling.
  let numerator = 0n, denominator = 1n;
  for (const [quantity, weight] of parts) {
    if (quantity === undefined) continue;
    if (!Number.isSafeInteger(quantity) || quantity < 0) throw new Error(`Invalid usage quantity ${quantity} for ${modelId}.`);
    const n = BigInt(quantity) * BigInt(weight.num), d = BigInt(weight.den);
    numerator = numerator * d + n * denominator;
    denominator *= d;
  }
  const unified = (numerator + denominator - 1n) / denominator;
  if (unified > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`Unified token total for ${modelId} exceeds the safe integer range.`);
  return { unified: Number(unified), tier: tierIndex, rateVersion: table.version };
}

/**
 * Reference table v1: published Anthropic prices (platform.claude.com, read
 * 2026-11-06) as ratios to Sonnet 5 input ($2/MTok). Seeded in development
 * only; production receives its document through the reviewed admin script.
 */
const r = (num: number, den = 1): Rational => ({ num, den });
export const aiRatesV1Document = {
  version: 'v1',
  referenceUnit: 'claude-sonnet-5 input token ($2 per million, 2026-11-06)',
  models: {
    'claude-haiku-4-5': { tiers: [{ maxInputTokens: null, input: r(1, 2), output: r(5, 2), cacheWrite5m: r(5, 8), cacheWrite1h: r(1), cacheRead: r(1, 20) }] },
    'claude-sonnet-5': { tiers: [{ maxInputTokens: null, input: r(1), output: r(5), cacheWrite5m: r(5, 4), cacheWrite1h: r(2), cacheRead: r(1, 10) }] },
    'claude-opus-5': { tiers: [{ maxInputTokens: null, input: r(5, 2), output: r(25, 2), cacheWrite5m: r(25, 8), cacheWrite1h: r(5), cacheRead: r(1, 4) }] },
  },
} as const;
