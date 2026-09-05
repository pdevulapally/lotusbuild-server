import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { Redis } from 'ioredis';
import type { Auth } from 'firebase-admin/auth';
import Fastify, { type FastifyInstance } from 'fastify';

import { authenticatedUser, registerAuth } from './auth/plugin.ts';
import type { BillingRepository } from './billing/repository.ts';
import { registerBillingRoutes } from './billing/routes.ts';
import type { Config } from './config/index.ts';
import type { EntitlementService } from './entitlements/service.ts';
import type { ConfigurationStore } from './entitlements/store.ts';
import type { MeteringService } from './metering/service.ts';
import { registerProjectRoutes } from './projects/routes.ts';
import type { ProjectRepository } from './projects/repository.ts';
import type Stripe from 'stripe';

import type { SessionEvents } from './sessions/events.ts';
import type { SessionRepository } from './sessions/repository.ts';
import { registerSessionRoutes } from './sessions/routes.ts';
import type { UserRepository } from './users/repository.ts';
import { registerErrorHandler } from './http/errors.ts';
import { registerRateLimiting } from './http/rate-limit.ts';
import { redisKeyPrefixes } from './redis/client.ts';

/**
 * Everything the routes need, passed in rather than constructed here, so that
 * building the app never opens a connection and `src/index.ts` stays the one
 * place that decides what talks to what.
 */
import { registerPrivacyRoutes, type PrivacyRequests } from './privacy/requests.ts';
import { registerFamilyRoutes } from './family/routes.ts';
import type { FamilyService } from './family/service.ts';

export interface Dependencies {
  readonly privacyRequests: PrivacyRequests;
  readonly family: FamilyService;
  readonly firebaseAuth: Auth;
  readonly redis: Redis;
  readonly entitlements: EntitlementService;
  readonly metering: MeteringService;
  readonly users: UserRepository;
  readonly projects: ProjectRepository;
  readonly sessions: SessionRepository;
  readonly sessionEvents: SessionEvents;
  readonly configuration: ConfigurationStore;
  readonly stripe: Stripe;
  readonly billing: BillingRepository;
}

export function buildServer(config: Config, dependencies: Dependencies): FastifyInstance {
  const { firebaseAuth, redis, entitlements, metering, users, projects, sessions, sessionEvents } =
    dependencies;
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    // Trust the reverse proxy in front of us for client IP and protocol, which
    // rate limiting and redirect construction both depend on being correct.
    trustProxy: 'loopback',
    // Reject oversized bodies at the parser rather than buffering them; this
    // process shares a box with build sandboxes and cannot afford the memory.
    bodyLimit: 1_048_576,
  });

  registerErrorHandler(app);
  registerAuth(app, firebaseAuth);

  void app.register(rateLimit, {
    // Applied per route through enforceRateLimit, so that the counter can be
    // keyed by an already-verified uid rather than by an IP.
    global: true,
    hook: 'onRequest',
    max: config.HTTP_MAX_REQUESTS_PER_MINUTE,
    timeWindow: 60_000,
    keyGenerator: (request) => `ip:${request.ip}`,
    redis,
    nameSpace: redisKeyPrefixes.rateLimit,
    // A rate limiter that lets everything through when its store is unreachable
    // is not a rate limiter. Redis is on this box; if it is gone, refusing loudly
    // is the honest outcome rather than silently uncapping every plan.
    skipOnError: false,
  });
  registerRateLimiting(app, entitlements);

  void app.register(helmet, {
    // Nothing here serves HTML, so a CSP governs no document. The headers that
    // do matter for a JSON API — nosniff, frameguard, HSTS — stay on.
    contentSecurityPolicy: false,
    // The browser client is on a different origin by design.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });

  void app.register(cors, {
    origin: config.CORS_ALLOWED_ORIGINS.map((url) => url.origin),
    // Identity travels in the Authorization header, never a cookie, so the
    // browser never needs to attach credentials to a cross-origin request.
    credentials: false,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type'],
  });

  // Resolves configuration rather than only proving the process is listening.
  // The registry document went missing once and every route answered 500 while
  // this endpoint stayed green — so deploy.sh passed its own smoke test and CI
  // called the release healthy. The store is TTL-cached, so this is a memory
  // read on all but the first call after expiry.
  app.get('/health', async () => {
    await dependencies.configuration.get();
    return { status: 'ok' };
  });

  app.get('/me', { preHandler: [app.requireAuth, app.enforceRateLimit('read')] }, async (request) => {
    const user = authenticatedUser(request);
    // Session start is where the account record is created, so every later route
    // can rely on it existing rather than each one creating it defensively.
    const stored = await users.ensure(user);
    const resolved = await entitlements.forUser(user.uid);

    // Every field is named explicitly rather than spread from an internal
    // object, so nothing added to those types later leaks into the response.
    return {
      uid: stored.uid,
      email: stored.email,
      emailVerified: user.emailVerified,
      displayName: stored.displayName,
      photoUrl: stored.photoUrl,
      projectCount: stored.projectCount,
      plan: { key: resolved.planKey, name: resolved.planName },
      subscriptionStatus: resolved.subscriptionStatus,
      capabilities: resolved.capabilities.entries(),
      limits: [...resolved.meterLimits.values()].map((limit) => ({
        meterKey: limit.meterKey,
        includedAllowance: limit.includedAllowance,
        hardLimit: limit.hardLimit,
        overageEnabled: limit.overageEnabled,
      })),
    };
  });

  app.get(
    '/me/usage',
    { preHandler: [app.requireAuth, app.enforceRateLimit('read')] },
    async (request) => {
      const user = authenticatedUser(request);
      const stored = await users.ensure(user);
      const resolved = await entitlements.forUser(user.uid);
      const usage = await metering.readUsageBreakdown(user.uid, resolved);

      return {
        uid: stored.uid,
        plan: { key: resolved.planKey, name: resolved.planName },
        meters: usage.map((entry) => ({
          meterKey: entry.meterKey,
          unit: entry.unit,
          label: entry.label,
          kind: entry.kind,
          resetPeriod: entry.resetPeriod,
          consumed: entry.consumed,
          reserved: entry.reserved,
          totalUsed: entry.consumed + entry.reserved,
          includedAllowance: entry.includedAllowance,
          hardLimit: entry.hardLimit,
          overageEnabled: entry.overageEnabled,
          periodStart: entry.periodStart.toISOString(),
        })),
      };
    },
  );


  registerProjectRoutes(app, projects);
  registerPrivacyRoutes(app, dependencies.privacyRequests);
  registerFamilyRoutes(app, dependencies.family, projects, sessions);
  registerSessionRoutes(app, sessions, sessionEvents, {
    heartbeatSeconds: config.SSE_HEARTBEAT_SECONDS,
    maxConnections: config.SSE_MAX_CONNECTIONS,
    maxConnectionsPerUser: config.SSE_MAX_CONNECTIONS_PER_USER,
    maxBufferedBytes: config.SSE_BUFFER_MAX_BYTES,
    reauthenticate: async (token) => { await firebaseAuth.verifyIdToken(token, true); },
  });
  registerBillingRoutes(app, {
    stripe: dependencies.stripe,
    billing: dependencies.billing,
    users,
    configuration: dependencies.configuration,
    webhookSecret: config.STRIPE_WEBHOOK_SECRET,
    // The same staleness budget the configuration itself runs on: a price
    // change and a plan change should reach the pricing page together.
    catalogueTtlMs: config.CONFIG_CACHE_TTL_SECONDS * 1000,
    urls: {
      checkoutSuccess: config.STRIPE_CHECKOUT_SUCCESS_URL,
      checkoutCancel: config.STRIPE_CHECKOUT_CANCEL_URL,
      portalReturn: config.STRIPE_PORTAL_RETURN_URL,
    },
  });

  return app;
}
