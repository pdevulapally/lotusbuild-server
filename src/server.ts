import Fastify, { type FastifyInstance } from 'fastify';

import type { Config } from './config/index.ts';

/**
 * Builds the application without listening, so tests can drive real routes via
 * `app.inject()` instead of booting a process. A code path only reachable by
 * starting the server is a code path nothing tests.
 */
export function buildServer(config: Config): FastifyInstance {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    // Trust the reverse proxy in front of us for client IP and protocol, which
    // rate limiting and redirect construction both depend on being correct.
    trustProxy: true,
    // Reject oversized bodies at the parser rather than buffering them; this
    // process shares a box with build sandboxes and cannot afford the memory.
    bodyLimit: 1_048_576,
  });

  app.get('/health', async () => ({ status: 'ok' }));

  return app;
}
