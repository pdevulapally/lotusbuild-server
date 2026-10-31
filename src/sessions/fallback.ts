import type Anthropic from '@anthropic-ai/sdk';
import type { FallbackPolicy } from '../entitlements/fallback.ts';
import { policyFingerprint } from '../entitlements/fallback.ts';
import type { UserEntitlements } from '../entitlements/service.ts';
import type { Registry, SandboxProvider } from '../entitlements/schema.ts';
import { aiEfforts } from '../entitlements/build-admission.ts';
import { AppError } from '../http/errors.ts';
import type { ContinuationCheckpoint } from '../runner/continuation.ts';
import { enumField, integerField, optionalStringField, stringField, type Fields } from '../support/documents.ts';

export const fallbackStatuses = ['AWAITING_CONSENT', 'QUEUED', 'RUNNING', 'CAPACITY_WAIT', 'EXHAUSTED', 'SHARED_LIMIT', 'UNAVAILABLE', 'COMPLETED'] as const;
export interface FallbackOffer {
  readonly model: string;
  readonly effort: FallbackPolicy['effort'];
  readonly inputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxInputTokens: number;
  readonly policyFingerprint: string;
}
export interface FallbackState {
  readonly status: typeof fallbackStatuses[number];
  readonly lane?: 'premium' | 'fallback';
  readonly resumable?: boolean;
  readonly sourceVersion?: string;
  readonly imageExpiresAt?: string;
  readonly reason: string;
  readonly checkpointId?: string;
  readonly offer?: FallbackOffer;
  readonly resetAt?: string;
  readonly retryAt?: string;
  readonly limitLabel?: string;
  readonly consent?: boolean;
}

export function parseFallbackState(value: unknown): FallbackState | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid fallback state.');
  const fields = value as Fields;
  const offer = fields['offer'];
  let parsed: FallbackOffer | undefined;
  if (offer !== undefined) {
    if (offer === null || typeof offer !== 'object' || Array.isArray(offer)) throw new Error('Invalid fallback offer.');
    const record = offer as Fields;
    parsed = { model: stringField(record, 'model', 'fallback'), effort: enumField(record, 'effort', 'fallback', aiEfforts),
      inputTokens: integerField(record, 'inputTokens', 'fallback', { min: 1 }), maxOutputTokens: integerField(record, 'maxOutputTokens', 'fallback', { min: 1 }), maxInputTokens: integerField(record, 'maxInputTokens', 'fallback', { min: 1 }),
      policyFingerprint: stringField(record, 'policyFingerprint', 'fallback') };
  }
  const imageDeadline = optionalStringField(fields, 'imageExpiresAt');
  if (imageDeadline !== undefined && !Number.isFinite(Date.parse(imageDeadline))) throw new Error('Invalid screenshot expiry.');
  const optional = (key: string) => { const value = optionalStringField(fields, key); return value === undefined ? {} : { [key]: value }; };
  return { status: enumField(fields, 'status', 'fallback', fallbackStatuses),
    ...(fields['lane'] === undefined ? {} : { lane: enumField(fields, 'lane', 'fallback', ['premium', 'fallback']) }), reason: stringField(fields, 'reason', 'fallback'),
    ...(fields['resumable'] === true ? { resumable: true } : {}), ...optional('sourceVersion'), ...optional('imageExpiresAt'), ...optional('checkpointId'), ...optional('resetAt'), ...optional('retryAt'), ...optional('limitLabel'),
    ...(parsed === undefined ? {} : { offer: parsed }), ...(fields['consent'] === true ? { consent: true } : {}) };
}

export function requireFallbackPolicy(registry: Registry, entitlements: UserEntitlements, fingerprint?: string): FallbackPolicy {
  const policy = registry.fallback;
  if (policy === undefined || !policy.eligiblePlanKeys.includes(entitlements.planKey) || (fingerprint !== undefined && policyFingerprint(policy) !== fingerprint)) {
    throw new AppError({ code: 'fallback/unavailable', statusCode: 409, message: 'Fallback is unavailable for the current configuration or plan. Review the current offer.' });
  }
  for (const key of [policy.inputTokenMeterKey, policy.outputTokenMeterKey]) {
    const limit = entitlements.meterLimits.get(key);
    if (limit === undefined || limit.hardLimit <= 0 || limit.overageEnabled) throw new AppError({ code: 'fallback/unavailable', statusCode: 409, message: 'A separate bounded fallback allowance has not been configured.' });
  }
  return policy;
}

/** Read-only provider verification, performed as part of an authorized task, never at seed/activation time. */
export async function verifyFallbackModel(anthropic: Anthropic, policy: FallbackPolicy, checkpoint: ContinuationCheckpoint,
  provider: SandboxProvider, currentEffort: FallbackPolicy['effort'], outputCeiling: number, signal: AbortSignal): Promise<FallbackOffer> {
  if (aiEfforts.indexOf(policy.effort) > aiEfforts.indexOf(currentEffort) || policy.maxOutputTokens > outputCeiling) throw new Error('Fallback exceeds the authorized effort or output ceiling.');
  const info = await anthropic.models.retrieve(policy.model, undefined, { signal });
  const effort = policy.effort === 'standard' ? 'medium' : policy.effort;
  if (info.id !== policy.model || info.capabilities?.effort[effort]?.supported !== true ||
      info.max_input_tokens === null || !Number.isSafeInteger(info.max_input_tokens) || info.max_input_tokens <= 0 || info.max_tokens === null || !Number.isSafeInteger(info.max_tokens) || policy.maxOutputTokens > info.max_tokens) throw new Error('The configured model capabilities are unverified or incompatible.');
  const hasImages = checkpoint.conversation.some((message) => Array.isArray(message.content) && message.content.some((block) => block.type === 'image' || (block.type === 'tool_result' && Array.isArray(block.content) && block.content.some((nested) => nested.type === 'image'))));
  if (hasImages && info.capabilities.image_input.supported !== true) throw new Error('The configured fallback cannot read this task’s images.');
  const computer = (checkpoint.request.tools ?? []).some((tool) => 'type' in tool && String(tool.type).startsWith('computer'));
  if (computer && provider.desktop?.computerModels?.includes(policy.model) !== true) throw new Error('Computer operation is not approved for this fallback model.');
  const count = await anthropic.messages.countTokens({ ...checkpoint.request, messages: checkpoint.conversation, model: policy.model, output_config: { effort } }, { signal });
  if (!Number.isSafeInteger(count.input_tokens) || count.input_tokens <= 0 || count.input_tokens > info.max_input_tokens) throw new Error('The saved task exceeds the verified fallback context window.');
  return { model: info.id, effort: policy.effort, inputTokens: count.input_tokens, maxOutputTokens: policy.maxOutputTokens, maxInputTokens: info.max_input_tokens, policyFingerprint: policyFingerprint(policy) };
}

export function tokenLimit(error: unknown, registry: Registry, lane: 'premium' | 'fallback'): error is AppError {
  if (!(error instanceof AppError) || error.code !== 'usage/limit-reached' || typeof error.details !== 'object' || error.details === null) return false;
  const fields = error.details as Fields;
  const meters = lane === 'premium' ? [registry.inputTokenMeterKey, registry.outputTokenMeterKey]
    : [registry.fallback?.inputTokenMeterKey, registry.fallback?.outputTokenMeterKey];
  return fields['kind'] === 'COUNTER' && meters.includes(String(fields['meterKey']));
}


export function quotaMetadata(error: AppError): { resetAt?: string; limitLabel?: string } {
  const details = error.details;
  if (typeof details !== 'object' || details === null) return {};
  return { ...('resetAt' in details && typeof details.resetAt === 'string' ? { resetAt: details.resetAt } : {}),
    ...('label' in details && typeof details.label === 'string' ? { limitLabel: details.label } : {}) };
}
