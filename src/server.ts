import { installHttpTimings, observeMethods } from './diagnostics/timing.ts';
import cors from '@fastify/cors';
import { RedisBudgetCounter, UploadBudgetGuard } from './attachments/budget.ts';
import { registerAttachmentRoutes } from './attachments/routes.ts';
import type { AttachmentStore } from './attachments/store.ts';
import type { SkillRepository } from './skills/repository.ts';
import { registerSkillRoutes } from './skills/routes.ts';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { Redis } from 'ioredis';
import type { Auth } from 'firebase-admin/auth';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

import { authenticatedUser, registerAuth } from './auth/plugin.ts';
import { registerEmailVerificationRoutes } from './auth/email-verification-routes.ts';
import type { EmailVerificationService } from './auth/email-verification.ts';
import type { BillingRepository } from './billing/repository.ts';
import { registerBillingRoutes } from './billing/routes.ts';
import { registerConnectionRoutes } from './connections/routes.ts';
import type { ConnectionRepository } from './connections/service.ts';
import type { Config } from './config/index.ts';
import type { EntitlementService } from './entitlements/service.ts';
import type { ConfigurationStore } from './entitlements/store.ts';
import type { MeteringService } from './metering/service.ts';
import { registerProjectContentRoutes } from './projects/content-routes.ts';
import type { ProjectFiles } from './projects/files.ts';
import { registerProjectRoutes } from './projects/routes.ts';
import type { ProjectRepository } from './projects/repository.ts';
import type Stripe from 'stripe';

import type { SessionEvents } from './sessions/events.ts';
import type { SessionRepository } from './sessions/repository.ts';
import { registerSessionRoutes } from './sessions/routes.ts';
import type { UserRepository } from './users/repository.ts';
import { registerErrorHandler, safeErrorDiagnostic } from './http/errors.ts';
import { allowedModelCatalog, assertModelSelection } from './models/catalog.ts';
import { registerRateLimiting } from './http/rate-limit.ts';
import { redisKeyPrefixes } from './redis/client.ts';
import { DesktopRelay, registerDesktopRoutes } from './desktop/relay.ts';
import { DesktopTickets, redactDesktopTicket } from './desktop/tickets.ts';

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
  readonly emailVerification: EmailVerificationService;
  readonly redis: Redis;
  readonly entitlements: EntitlementService;
  readonly metering: MeteringService;
  readonly users: UserRepository;
  readonly projects: ProjectRepository;
  readonly projectFiles: ProjectFiles;
  /** Absent until CONNECTION_KEK_V<n> is configured; the integrations routes then answer 503 configuration_required. */
  readonly connections?: ConnectionRepository;
  readonly attachments: AttachmentStore;
  readonly skills: SkillRepository;
  readonly sessions: SessionRepository;
  readonly sessionEvents: SessionEvents;
  readonly configuration: ConfigurationStore;
  readonly stripe: Stripe;
  readonly billing: BillingRepository;
  /**
   * The git revision this build was packaged from, reported on `/health` so a
   * deploy can be checked against what is actually running. Absent in a
   * development checkout, where nothing packaged the tree.
   */
  readonly revision?: string;
}

/** Same fields Fastify logs by default, minus the desktop ticket a URL may carry. */
export const requestLogSerializer = (request: FastifyRequest) => ({
  method: request.method,
  url: redactDesktopTicket(request.url),
  host: request.host,
  remoteAddress: request.ip,
  ...(request.socket?.remotePort === undefined ? {} : { remotePort: request.socket.remotePort }),
});

/** Headers a browser may read off a cross-origin response; everything else is hidden from its JavaScript. */
export const exposedResponseHeaders = ['Content-Disposition', 'Retry-After', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'];

export function buildServer(config: Config, dependencies: Dependencies): FastifyInstance {
  const { firebaseAuth, redis, metering, users } = dependencies;
  const entitlements = observeMethods(dependencies.entitlements, { forUser: 'entitlements.resolve' });
  const projects = observeMethods(dependencies.projects, { readOwned: 'project.read', listOwnedBy: 'project.list' });
  const sessions = observeMethods(dependencies.sessions, { readOwned: 'session.read', create: 'session.admit', submitMessage: 'session.admit' });
  const sessionEvents = observeMethods(dependencies.sessionEvents, { append: 'events.append', history: 'events.replay' });
  const app = Fastify({
    logger: { level: config.LOG_LEVEL, serializers: {
      // Fastify's serializer type requires these strings; none comes from the error.
      err: (error) => ({ type: 'SafeErrorDiagnostic', message: 'Operational failure', stack: '', ...safeErrorDiagnostic(error) }),
      // The desktop WebSocket ticket rides in the query string, and the default
      // serializer logs the whole URL.
      req: requestLogSerializer,
    } },
    // Trust the reverse proxy in front of us for client IP and protocol, which
    // rate limiting and redirect construction both depend on being correct.
    trustProxy: 'loopback',
    // Reject oversized bodies at the parser rather than buffering them; this
    // process shares a box with build sandboxes and cannot afford the memory.
    bodyLimit: 1_048_576,
    // SSE requests are intentionally long-lived. Waiting for every active
    // response during app.close() would make a deploy wait until systemd kills
    // the process, so close their sockets after the shutdown hooks have told
    // WebSocket viewers why the server is going away.
    forceCloseConnections: true,
  });

  installHttpTimings(app, (timing) => app.log.debug({ timing }, 'phase timing'));
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
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Last-Event-ID', 'Idempotency-Key'],
    // Without this a cross-origin caller cannot read the retry hint off a 429,
    // because Retry-After is not one of the headers browsers reveal by default.
    exposedHeaders: exposedResponseHeaders,
  });

  // Every route is declared inside this plugin, and that is load-bearing.
  // @fastify/rate-limit attaches itself to a route from an onRoute hook, and
  // onRoute fires when app.get() is *called*, not when the route is finally
  // added. A plugin registered with `void app.register(...)` has not loaded by
  // the time the next line of this function runs, so routes declared straight
  // on the root were declared before the hook existed and were never limited
  // per address. A child plugin is only run after the plugins registered
  // before it have loaded, which is what makes the limit apply.
  void app.register(async (api) => {
    // Resolves configuration rather than only proving the process is listening.
    // The registry document went missing once and every route answered 500 while
    // this endpoint stayed green — so deploy.sh passed its own smoke test and CI
    // called the release healthy. The store is TTL-cached, so this is a memory
    // read on all but the first call after expiry.
    api.get('/health', async () => {
      await dependencies.configuration.get();
      return dependencies.revision === undefined
        ? { status: 'ok' }
        : { status: 'ok', revision: dependencies.revision };
    });

    api.get('/me', { preHandler: [api.requireAuth, api.enforceRateLimit('read')] }, async (request) => {
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
        models: await allowedModelCatalog(redis, resolved),
        limits: [...resolved.meterLimits.values()].map((limit) => ({
          meterKey: limit.meterKey,
          includedAllowance: limit.includedAllowance,
          hardLimit: limit.hardLimit,
          overageEnabled: limit.overageEnabled,
        })),
      };
    });

    registerEmailVerificationRoutes(api, dependencies.emailVerification);

    api.get<{ Params: { sessionId: string } }>('/sessions/:sessionId/usage', {
      preHandler: [api.requireAuth, api.enforceRateLimit('read')],
      schema: { params: { type: 'object', required: ['sessionId'], additionalProperties: false,
        properties: { sessionId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' } } } },
    }, async (request, reply) => {
      const user = authenticatedUser(request);
      const session = await sessions.readOwned(user.uid, request.params.sessionId);
      reply.header('cache-control', 'no-store');
      return { sessionId: session.id, meters: await metering.readOperationUsage(user.uid, session.id) };
    });

    api.get<{ Querystring: { limit?: number } }>('/me/sessions', {
      preHandler: [api.requireAuth, api.enforceRateLimit('read')],
      schema: { querystring: { type: 'object', additionalProperties: false,
        properties: { limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 } } } },
    }, async (request, reply) => {
      const user = authenticatedUser(request);
      const recent = await sessions.listRecentForOwner(user.uid, request.query.limit ?? 20);
      reply.header('cache-control', 'no-store');
      return {
        sessions: recent.map((session) => ({
          id: session.id,
          projectId: session.projectId,
          status: session.status,
          mode: session.mode,
          messageCount: session.messageCount,
          heartbeatAt: session.heartbeatAt?.toISOString() ?? null,
          createdAt: session.createdAt.toISOString(),
        })),
      };
    });

    api.get(
      '/me/usage',
      { preHandler: [api.requireAuth, api.enforceRateLimit('read')] },
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

    await registerDesktopRoutes(api, {
      redis,
      sessions,
      tickets: new DesktopTickets(redis),
      relay: new DesktopRelay(
        { redis, sessions, tickets: new DesktopTickets(redis) },
        {
          maxConnections: config.DESKTOP_MAX_CONNECTIONS,
          maxConnectionsPerUser: config.DESKTOP_MAX_CONNECTIONS_PER_USER,
          maxViewersPerSession: config.DESKTOP_MAX_VIEWERS_PER_SESSION,
          streamMaxSeconds: config.DESKTOP_STREAM_MAX_SECONDS,
          pingSeconds: config.DESKTOP_PING_SECONDS,
          bufferMaxBytes: config.DESKTOP_BUFFER_MAX_BYTES,
          clientMaxBytesPerSecond: config.DESKTOP_CLIENT_MAX_BYTES_PER_SECOND,
          allowedOrigins: new Set(config.CORS_ALLOWED_ORIGINS.map((url) => url.origin)),
          upstreamDomain: config.E2B_DOMAIN,
        },
      ),
    });
    registerProjectRoutes(api, projects);
    // No connector has provider credentials on any server yet: the catalogue is
    // browsable, every start attempt reports configuration_required.
    registerConnectionRoutes(api, { connections: dependencies.connections, configured: new Set() });
    registerProjectContentRoutes(api, projects, dependencies.projectFiles, sessions);
    registerPrivacyRoutes(api, dependencies.privacyRequests);
    registerFamilyRoutes(api, dependencies.family, projects, sessions);
    registerSkillRoutes(api, dependencies.skills);
    registerAttachmentRoutes(api, { store: dependencies.attachments, entitlements, budget: new UploadBudgetGuard(new RedisBudgetCounter(redis)) });
    registerSessionRoutes(api, sessions, sessionEvents, {
      attachments: dependencies.attachments,
      validateModel: async (uid, model, effort) => {
        const resolved = await entitlements.forUser(uid);
        const models = await allowedModelCatalog(redis, resolved);
        assertModelSelection(models, model, effort);
        return models.find(item => item.id === model)?.efforts.at(-1);
      },
      heartbeatSeconds: config.SSE_HEARTBEAT_SECONDS,
      maxConnections: config.SSE_MAX_CONNECTIONS,
      maxConnectionsPerUser: config.SSE_MAX_CONNECTIONS_PER_USER,
      maxBufferedBytes: config.SSE_BUFFER_MAX_BYTES,
      reauthenticate: async (token) => { await firebaseAuth.verifyIdToken(token, true); },
    });
    registerBillingRoutes(api, {
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
  });

  return app;
}
