import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import type { Auth } from 'firebase-admin/auth';
import Stripe from 'stripe';
import { registerAuth } from '../src/auth/plugin.ts';
import { registerBillingRoutes } from '../src/billing/routes.ts';
import { registerErrorHandler } from '../src/http/errors.ts';
import { registerProjectRoutes } from '../src/projects/routes.ts';
import type { ProjectRepository } from '../src/projects/repository.ts';
import type { SessionEvents } from '../src/sessions/events.ts';
import type { SessionRepository } from '../src/sessions/repository.ts';
import { registerSessionRoutes } from '../src/sessions/routes.ts';

const project = { id: 'p1', name: 'App', description: undefined, platform: 'web', status: 'draft', publicPreviewEnabled: false, createdAt: new Date(0) };
const session = { id: 's1', projectId: 'p1', status: 'FAILED', model: 'm', effort: 'low', sandboxId: undefined,
  error: 'Cancelled by user', messageCount: 1, heartbeatAt: undefined, createdAt: new Date(0) };

/** `verified` undefined models a token that carries no email_verified claim at all. */
function harness(verified: boolean | undefined) {
  const touched: string[] = [];
  const app = Fastify({ logger: false });
  registerAuth(app, { verifyIdToken: async () => ({ uid: 'u1', auth_time: Date.now() / 1000, exp: Date.now() / 1000 + 3600,
    ...(verified === undefined ? {} : { email_verified: verified }) }) } as unknown as Auth);
  registerErrorHandler(app);
  app.decorate('enforceRateLimit', () => async () => { touched.push('rate-limit'); });
  registerProjectRoutes(app, {
    create: async () => { touched.push('projects.create'); return project; },
    listOwnedBy: async () => [],
    delete: async () => {},
    setPublicPreview: async () => ({ enabled: false, terminationPending: false }),
  } as unknown as ProjectRepository);
  registerSessionRoutes(app, {
    create: async () => { touched.push('sessions.create'); return { ...session, status: 'QUEUED' }; },
    readOwned: async () => { touched.push('sessions.readOwned'); return { ...session, status: 'IDLE' }; },
    appendPrompt: async () => { touched.push('sessions.appendPrompt'); return session; },
    cancel: async () => session,
    deleteQueuedMessage: async () => {},
  } as unknown as SessionRepository, { append: async (_id: string, type: string, data: Record<string, unknown>) => ({ id: '1-0', type, data }) } as unknown as SessionEvents,
  { heartbeatSeconds: 15, maxConnections: 10, maxConnectionsPerUser: 2, maxBufferedBytes: 1024, reauthenticate: async () => {} });
  registerBillingRoutes(app, { stripe: new Stripe('fixture-api-key'), webhookSecret: 'fixture-webhook-key', catalogueTtlMs: 1000,
    configuration: { get: async () => { touched.push('billing.configuration'); throw new Error('must not be reached'); } } } as unknown as Parameters<typeof registerBillingRoutes>[1]);
  return { app, touched };
}

const headers = { authorization: 'Bearer token', 'idempotency-key': 'stable-test-command-1' };
const gated = [
  { method: 'POST', url: '/projects', payload: { name: 'App', platform: 'web' } },
  { method: 'POST', url: '/projects/p1/sessions', payload: { prompt: 'Build it', model: 'm' } },
  { method: 'POST', url: '/sessions/s1/messages', payload: { prompt: 'More' } },
  { method: 'POST', url: '/billing/checkout', payload: { planKey: 'pro' } },
] as const;

test('an unverified email is refused with a stable code on every gated route, before anything else runs', async (t) => {
  for (const verified of [false, undefined]) {
    const h = harness(verified);
    t.after(() => h.app.close());
    for (const route of gated) {
      const response = await h.app.inject({ ...route, headers });
      assert.equal(response.statusCode, 403, `${route.method} ${route.url} (verified=${String(verified)})`);
      const body = response.json();
      assert.deepEqual(Object.keys(body).sort(), ['error', 'requestId']);
      assert.deepEqual(body.error, { code: 'auth/email-not-verified', message: 'Verify your email address to use this feature.' });
    }
    // Neither the rate limiter, nor a repository, nor configuration was consulted.
    assert.deepEqual(h.touched, []);
  }
});

test('a verified email passes the gate', async (t) => {
  const h = harness(true);
  t.after(() => h.app.close());
  const created = await h.app.inject({ method: 'POST', url: '/projects', headers, payload: { name: 'App', platform: 'web' } });
  assert.equal(created.statusCode, 201);
  const started = await h.app.inject({ method: 'POST', url: '/projects/p1/sessions', headers, payload: { prompt: 'Build it', model: 'm' } });
  assert.equal(started.statusCode, 201);
  assert.ok(h.touched.includes('rate-limit'));
});

test('an unverified user can still read, cancel and delete', async (t) => {
  const h = harness(false);
  t.after(() => h.app.close());
  const list = await h.app.inject({ method: 'GET', url: '/projects', headers });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.json(), { projects: [] });
  assert.equal((await h.app.inject({ method: 'DELETE', url: '/projects/p1', headers })).statusCode, 204);
  assert.equal((await h.app.inject({ method: 'POST', url: '/sessions/s1/cancel', headers })).statusCode, 200);
  assert.equal((await h.app.inject({ method: 'DELETE', url: '/sessions/s1/queued-messages/m1', headers })).statusCode, 204);
  assert.equal((await h.app.inject({ method: 'PATCH', url: '/projects/p1/public-preview', headers, payload: { enabled: false } })).statusCode, 200);
});

test('a missing or invalid token is still a 401, not a verification error', async (t) => {
  const h = harness(false);
  t.after(() => h.app.close());
  const response = await h.app.inject({ method: 'POST', url: '/projects', payload: { name: 'App', platform: 'web' } });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, 'auth/missing-token');
});
