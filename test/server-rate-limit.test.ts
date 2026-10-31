import assert from 'node:assert/strict';
import test from 'node:test';
import { buildServer, exposedResponseHeaders, type Dependencies } from '../src/server.ts';
import type { Config } from '../src/config/index.ts';

const origin = 'https://app.example.test';
const revision = 'a'.repeat(40);

/** A Redis that reports the counter it is told to, and records the keys it was asked about. */
function harness(count: number, extra: Partial<Dependencies> = {}) {
  const keys: string[] = [];
  const config = { LOG_LEVEL: 'silent', HTTP_MAX_REQUESTS_PER_MINUTE: 1, CORS_ALLOWED_ORIGINS: [new URL(origin)],
    CONFIG_CACHE_TTL_SECONDS: 60, SSE_HEARTBEAT_SECONDS: 15, SSE_MAX_CONNECTIONS: 10, SSE_MAX_CONNECTIONS_PER_USER: 2, DESKTOP_MAX_CONNECTIONS: 10, DESKTOP_MAX_CONNECTIONS_PER_USER: 2, DESKTOP_MAX_VIEWERS_PER_SESSION: 2, DESKTOP_STREAM_MAX_SECONDS: 600, DESKTOP_PING_SECONDS: 20, DESKTOP_BUFFER_MAX_BYTES: 1048576, DESKTOP_CLIENT_MAX_BYTES_PER_SECOND: 16384, E2B_DOMAIN: 'e2b.test',
    SSE_BUFFER_MAX_BYTES: 1024 } as unknown as Config;
  const rateLimit = (...args: unknown[]) => {
    keys.push(String(args[0]));
    (args.at(-1) as (error: null, result: [number, number]) => void)(null, [count, 60000]);
  };
  const app = buildServer(config, { redis: { rateLimit, rateLimitRead: rateLimit }, firebaseAuth: {},
    entitlements: {}, projects: {}, sessions: {}, sessionEvents: {}, configuration: { get: async () => ({}) }, ...extra } as unknown as Dependencies);
  return { app, keys };
}

test('the per-address limit applies to routes declared in buildServer, and its 429 stays readable cross-origin', async (t) => {
  const h = harness(2);
  t.after(() => h.app.close());
  // /health has no handler-side dependencies that could answer 200 by accident, and
  // /me is limited before authentication ever runs.
  for (const url of ['/health', '/me', '/projects']) {
    const response = await h.app.inject({ method: 'GET', url, headers: { origin } });
    assert.equal(response.statusCode, 429, url);
    assert.equal(response.headers['access-control-allow-origin'], origin, `${url} 429 must carry CORS headers`);
    assert.equal(response.headers['x-ratelimit-limit'], '1');
    assert.ok(response.headers['retry-after'] !== undefined);
  }
  assert.ok(h.keys.length >= 3, 'the counter was consulted for every request');
  assert.ok(h.keys.every((key) => key.includes('ip:')), 'keyed by address');
});

test("/plans keeps its own, higher per-address limit", async (t) => {
  const h = harness(121);
  t.after(() => h.app.close());
  const response = await h.app.inject({ method: 'GET', url: '/plans', headers: { origin } });
  assert.equal(response.statusCode, 429);
  assert.equal(response.headers['x-ratelimit-limit'], '120');
  assert.equal(response.headers['access-control-allow-origin'], origin);
});

test('a request under the limit is served and carries the rate-limit headers', async (t) => {
  const h = harness(1);
  t.after(() => h.app.close());
  const response = await h.app.inject({ method: 'GET', url: '/health', headers: { origin } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['x-ratelimit-limit'], '1');
});

test('the browser is allowed to read the retry and rate-limit headers', async (t) => {
  const h = harness(1);
  t.after(() => h.app.close());
  const response = await h.app.inject({ method: 'GET', url: '/health', headers: { origin } });
  const exposed = String(response.headers['access-control-expose-headers']).split(',').map((name) => name.trim().toLowerCase());
  for (const name of exposedResponseHeaders) assert.ok(exposed.includes(name.toLowerCase()), name);
});

test('/health reports the packaged revision when there is one, and nothing invented when there is not', async (t) => {
  const packaged = harness(1, { revision });
  const development = harness(1);
  t.after(() => Promise.all([packaged.app.close(), development.app.close()]));
  assert.deepEqual((await packaged.app.inject({ method: 'GET', url: '/health' })).json(), { status: 'ok', revision });
  assert.deepEqual((await development.app.inject({ method: 'GET', url: '/health' })).json(), { status: 'ok' });
});
