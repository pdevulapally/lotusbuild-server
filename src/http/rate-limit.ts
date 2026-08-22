import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';

import { authenticatedUser } from '../auth/plugin.ts';
import type { EntitlementService } from '../entitlements/service.ts';
import type { RateLimitClass } from '../entitlements/schema.ts';
import { AppError } from './errors.ts';

/**
 * Per-plan rate limiting, applied after authentication.
 *
 * The limit belongs to the caller's plan, so the counter has to be keyed by uid
 * — which means the token must already be verified. That rules out the usual
 * `onRequest` wiring: at that point nothing has checked who the caller is, and
 * keying on an unverified claim would let anyone drain a chosen victim's bucket.
 * So this is a preHandler registered after `requireAuth`, driven by the plugin's
 * own composable checker rather than a second implementation of the counter.
 */
export function registerRateLimiting(
  app: FastifyInstance,
  entitlements: EntitlementService,
): void {
  const limitsFor = async (request: FastifyRequest, routeClass: RateLimitClass) => {
    const user = authenticatedUser(request);
    const resolved = await entitlements.forUser(user.uid);
    const limit = resolved.rateLimits.get(routeClass);
    if (limit === undefined) {
      // A plan that declares no limit for a class would otherwise be unlimited,
      // which is the one outcome a rate limiter must never produce by omission.
      throw new AppError({
        code: 'config/rate-limit-missing',
        statusCode: 500,
        message: `Plan "${resolved.planKey}" declares no "${routeClass}" rate limit.`,
      });
    }
    return limit;
  };

  const checkers = new Map<RateLimitClass, ReturnType<FastifyInstance['createRateLimit']>>();

  const checkerFor = (routeClass: RateLimitClass) => {
    const existing = checkers.get(routeClass);
    if (existing !== undefined) {
      return existing;
    }
    const checker = app.createRateLimit({
      // Both are resolved per request because they come from the caller's plan,
      // and an upgrade must take effect without a deploy.
      max: async (request) => (await limitsFor(request, routeClass)).maxRequests,
      timeWindow: async (request) => (await limitsFor(request, routeClass)).windowSeconds * 1000,
      keyGenerator: (request) => `${routeClass}:${authenticatedUser(request).uid}`,
    });
    checkers.set(routeClass, checker);
    return checker;
  };

  // `app.rateLimit` is the plugin's own decorator, so this one is named
  // differently rather than shadowing it.
  app.decorate('enforceRateLimit', (routeClass: RateLimitClass): preHandlerHookHandler => {
    return async (request, reply) => {
      // Resolved on first use, not at route registration: the plugin that
      // provides createRateLimit has not finished loading while routes are being
      // declared.
      const result = await checkerFor(routeClass)(request);

      // `isAllowed` is only the allow-list short circuit — it is false on the
      // ordinary path even when the request is under the limit. The verdict is
      // `isExceeded`, which is how the plugin's own hook reads it.
      if (result.isAllowed) {
        return;
      }

      reply.header('x-ratelimit-limit', String(result.max));
      reply.header('x-ratelimit-remaining', String(result.remaining));
      reply.header('x-ratelimit-reset', String(result.ttlInSeconds));

      if (!result.isExceeded) {
        return;
      }

      reply.header('retry-after', String(result.ttlInSeconds));
      throw new AppError({
        code: 'rate-limit/exceeded',
        statusCode: 429,
        message: `Too many ${routeClass} requests. Retry in ${result.ttlInSeconds}s.`,
        details: {
          routeClass,
          limit: result.max,
          windowSeconds: Math.round(result.timeWindow / 1000),
          retryAfterSeconds: result.ttlInSeconds,
        },
      });
    };
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Builds the preHandler enforcing this route class against the caller's plan. */
    enforceRateLimit(routeClass: RateLimitClass): preHandlerHookHandler;
  }
}
