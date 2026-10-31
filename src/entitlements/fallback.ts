import { continuationProtocolMaxBytes } from '../runner/continuation.ts';
import { modelProviderKeys, type ModelProviderKey } from '../models/provider.ts';
import { createHash } from 'node:crypto';
import { aiEfforts, type AiEffort } from './build-admission.ts';
import type { MeterDefinition } from './schema.ts';
import { DocumentShapeError, enumField, integerField, stringArrayField, stringField, type Fields } from '../support/documents.ts';

export interface FallbackPolicy {
  readonly provider: ModelProviderKey;
  readonly model: string;
  readonly effort: AiEffort;
  readonly eligiblePlanKeys: readonly string[];
  readonly inputTokenMeterKey: string;
  readonly outputTokenMeterKey: string;
  readonly maxPremiumDispatches: number;
  readonly capacityRetrySeconds: number;
  readonly maxCheckpointBytes: number;
  readonly maxOutputTokens: number;
}

/** No policy means unavailable. No model, allowance or scheduling weight is supplied by code. */
export function parseFallbackPolicy(value: unknown, where: string, meters: ReadonlyMap<string, MeterDefinition>, premiumMeters: readonly string[]): FallbackPolicy | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new DocumentShapeError(`${where}: expected fallback policy.`);
  const fields = value as Fields;
  const policy: FallbackPolicy = {
    provider: enumField(fields, 'provider', where, modelProviderKeys),
    model: stringField(fields, 'model', where), effort: enumField(fields, 'effort', where, aiEfforts),
    eligiblePlanKeys: stringArrayField(fields, 'eligiblePlanKeys', where),
    inputTokenMeterKey: stringField(fields, 'inputTokenMeterKey', where), outputTokenMeterKey: stringField(fields, 'outputTokenMeterKey', where),
    maxPremiumDispatches: integerField(fields, 'maxPremiumDispatches', where, { min: 1 }),
    capacityRetrySeconds: integerField(fields, 'capacityRetrySeconds', where, { min: 1 }),
    maxCheckpointBytes: integerField(fields, 'maxCheckpointBytes', where, { min: 1, max: continuationProtocolMaxBytes }),
    maxOutputTokens: integerField(fields, 'maxOutputTokens', where, { min: 1 }),
  };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(policy.model) || policy.eligiblePlanKeys.length === 0 || new Set(policy.eligiblePlanKeys).size !== policy.eligiblePlanKeys.length) {
    throw new DocumentShapeError(`${where}: an exact model and distinct eligible plans are required.`);
  }
  if (policy.inputTokenMeterKey === policy.outputTokenMeterKey) throw new DocumentShapeError(`${where}: fallback meters must be distinct.`);
  for (const key of [policy.inputTokenMeterKey, policy.outputTokenMeterKey]) {
    const meter = meters.get(key);
    if (meter?.kind !== 'COUNTER' || premiumMeters.includes(key)) throw new DocumentShapeError(`${where}: fallback needs separate declared counter meters.`);
  }
  return policy;
}

export function policyFingerprint(policy: FallbackPolicy): string {
  return createHash('sha256').update(JSON.stringify(policy)).digest('hex');
}
