import assert from 'node:assert/strict';
import test from 'node:test';
import { buildServer, type Dependencies } from '../src/server.ts';
import type { Config } from '../src/config/index.ts';

test('server permits authenticated SSE resume preflight only for configured origins', async () => {
  const config = { LOG_LEVEL: 'silent', HTTP_MAX_REQUESTS_PER_MINUTE: 100,
    CORS_ALLOWED_ORIGINS: [new URL('https://app.example.test')], CONFIG_CACHE_TTL_SECONDS: 60,
    SSE_HEARTBEAT_SECONDS: 15, SSE_MAX_CONNECTIONS: 10, SSE_MAX_CONNECTIONS_PER_USER: 2, DESKTOP_MAX_CONNECTIONS: 10, DESKTOP_MAX_CONNECTIONS_PER_USER: 2, DESKTOP_MAX_VIEWERS_PER_SESSION: 2, DESKTOP_STREAM_MAX_SECONDS: 600, DESKTOP_PING_SECONDS: 20, DESKTOP_BUFFER_MAX_BYTES: 1048576, DESKTOP_CLIENT_MAX_BYTES_PER_SECOND: 16384, E2B_DOMAIN: 'e2b.test', SSE_BUFFER_MAX_BYTES: 1024,
  } as unknown as Config;
  const rateLimit = (...args: unknown[]) => {
    const callback = args.at(-1);
    assert.equal(typeof callback, 'function');
    if (typeof callback === 'function') callback(null, [1, 60000]);
  };
  // Only OPTIONS is exercised. Provider methods are deliberately absent, so an
  // unexpected authenticated/provider operation cannot silently succeed.
  const app = buildServer(config, { redis: { rateLimit, rateLimitRead: rateLimit }, firebaseAuth: {} } as unknown as Dependencies);
  try {
    for (const origin of ['https://app.example.test', 'https://untrusted.example.test']) {
      const response = await app.inject({ method: 'OPTIONS', url: '/sessions/owned/events', headers: {
        origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization,last-event-id',
      } });
      if (origin === 'https://app.example.test') {
        assert.equal(response.statusCode, 204);
        assert.equal(response.headers['access-control-allow-origin'], origin);
        const headers = String(response.headers['access-control-allow-headers']).toLowerCase().split(',').map((h) => h.trim());
        assert.ok(headers.includes('authorization'));
        assert.ok(headers.includes('last-event-id'));
      } else {
        assert.equal(response.headers['access-control-allow-origin'], undefined);
      }
    }
  } finally { await app.close(); }
});

test('server shutdown closes long-lived HTTP streams', async () => {
  const config = {
    LOG_LEVEL: 'silent',
    HTTP_MAX_REQUESTS_PER_MINUTE: 100,
    CORS_ALLOWED_ORIGINS: [new URL('https://app.example.test')],
  } as unknown as Config;
  const app = buildServer(config, {
    redis: {},
    firebaseAuth: {},
  } as unknown as Dependencies);
  assert.equal(app.initialConfig.forceCloseConnections, true);
  await app.close();
});
