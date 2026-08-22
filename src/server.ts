import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import type { Auth } from 'firebase-admin/auth';
import Fastify, { type FastifyInstance } from 'fastify';

import { authenticatedUser, registerAuth } from './auth/plugin.ts';
import type { Config } from './config/index.ts';
import { registerErrorHandler } from './http/errors.ts';

/**
 * Builds the application without listening, so tests can drive real routes via
 * `app.inject()` instead of booting a process. A code path only reachable by
 * starting the server is a code path nothing tests.
 */
export function buildServer(config: Config, firebaseAuth: Auth): FastifyInstance {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    // Trust the reverse proxy in front of us for client IP and protocol, which
    // rate limiting and redirect construction both depend on being correct.
    trustProxy: true,
    // Reject oversized bodies at the parser rather than buffering them; this
    // process shares a box with build sandboxes and cannot afford the memory.
    bodyLimit: 1_048_576,
  });

  registerErrorHandler(app);
  registerAuth(app, firebaseAuth);

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

  app.get('/health', async () => ({ status: 'ok' }));

  app.get(
    '/me',
    {
      preHandler: app.requireAuth,
      schema: {
        // The response schema is a whitelist: anything added to the object later
        // cannot leak to the client without being declared here first.
        response: {
          200: {
            type: 'object',
            required: ['uid', 'emailVerified'],
            additionalProperties: false,
            properties: {
              uid: { type: 'string' },
              email: { type: 'string' },
              emailVerified: { type: 'boolean' },
            },
          },
        },
      },
    },
    async (request) => {
      const user = authenticatedUser(request);
      return { uid: user.uid, email: user.email, emailVerified: user.emailVerified };
    },
  );

  return app;
}
