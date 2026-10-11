import { AppError } from '../http/errors.ts';
import type { Platform } from './schema.ts';
import type { UserEntitlements } from './service.ts';

export const aiEfforts = ['low', 'standard', 'high', 'xhigh'] as const;
export type AiEffort = (typeof aiEfforts)[number];

function effortIndex(value: string): number {
  return aiEfforts.indexOf(value as AiEffort);
}

/**
 * A user may spend less than their plan permits, never more.
 *
 * The entitlement remains the ceiling and the default, so an omitted request
 * preserves the existing contract. Unknown configured values fail closed:
 * accepting one would make the relative-cost comparison meaningless.
 */
export function resolveAiEffort(entitlements: UserEntitlements, requested?: AiEffort): AiEffort {
  const maximum = entitlements.capabilities.string('ai.effort');
  const maximumIndex = effortIndex(maximum);
  if (maximumIndex < 0) {
    throw new Error(`Unsupported configured AI effort "${maximum}".`);
  }
  if (requested === undefined) return aiEfforts[maximumIndex]!;
  if (effortIndex(requested) > maximumIndex) {
    throw new AppError({
      code: 'session/effort-not-permitted',
      statusCode: 403,
      message: `The ${entitlements.planName} plan cannot use the selected reasoning effort.`,
      details: { requested, maximum, plan: entitlements.planKey },
    });
  }
  return requested;
}

/** One policy for creation, continuation and the provider-spend boundary. */
export function assertBuildAllowed(entitlements: UserEntitlements, platform: Platform, model: string): void {
  if (!entitlements.capabilities.boolean('ai.run')) {
    throw new AppError({ code: 'session/ai-not-permitted', statusCode: 403,
      message: `The ${entitlements.planName} plan cannot run builds.` });
  }
  if (!entitlements.capabilities.boolean(`platform.${platform}`)) {
    throw new AppError({ code: 'session/platform-not-permitted', statusCode: 403,
      message: `The ${entitlements.planName} plan cannot build ${platform} projects.` });
  }
  if (!entitlements.capabilities.allows('ai.model.allowlist', model)) {
    throw new AppError({ code: 'session/model-not-permitted', statusCode: 403,
      message: `The ${entitlements.planName} plan cannot use the selected model.`,
      details: { model, permitted: entitlements.capabilities.stringList('ai.model.allowlist'), plan: entitlements.planKey } });
  }
}
