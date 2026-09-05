import { AppError } from '../http/errors.ts';
import type { Platform } from './schema.ts';
import type { UserEntitlements } from './service.ts';

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
