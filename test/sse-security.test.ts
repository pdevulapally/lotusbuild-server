import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import type { Auth } from 'firebase-admin/auth';
import { registerAuth } from '../src/auth/plugin.ts';
import { AppError, registerErrorHandler } from '../src/http/errors.ts';
import { closingFrame, registerSessionRoutes } from '../src/sessions/routes.ts';
import type { SessionRepository } from '../src/sessions/repository.ts';
import type { SessionEvent, SessionEvents } from '../src/sessions/events.ts';

async function fixture(expiresInSeconds = 3600) {
  const app = Fastify({ logger: false });
  let revoked = false;
  let listener: ((event: SessionEvent) => void) | undefined;
  let subscriptions = 0;
  const verify = async () => { if (revoked) throw new Error('revoked'); return { uid: 'alice', auth_time: Date.now() / 1000, exp: Date.now() / 1000 + expiresInSeconds }; };
  registerAuth(app, { verifyIdToken: verify } as unknown as Auth);
  registerErrorHandler(app);
  app.decorate('enforceRateLimit', () => async () => {});
  registerSessionRoutes(app, { readOwned: async (uid: string, id: string) => {
    if (uid !== 'alice' || id !== 'owned') throw new AppError({ code: 'session/not-found', statusCode: 404, message: 'No such session.' });
    return { id };
  } } as unknown as SessionRepository, {
    subscribe: async (_id: string, callback: (event: SessionEvent) => void) => {
      subscriptions++; listener = callback; return () => { subscriptions--; listener = undefined; };
    },
    replay: async function* () {},
  } as unknown as SessionEvents, { heartbeatSeconds: 0.02, maxConnections: 10, maxConnectionsPerUser: 1,
    maxBufferedBytes: 1024, reauthenticate: async () => { await verify(); } });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  return { app, address, revoke: () => { revoked = true; }, count: () => subscriptions, emit: (event: SessionEvent) => listener?.(event) };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check());
}
const headers = { Authorization: 'Bearer test-token' };

test('SSE enforces account connection limits and releases capacity on disconnect', async () => {
  const h = await fixture();
  const abort = new AbortController();
  try {
    const first = await fetch(`${h.address}/sessions/owned/events`, { headers, signal: abort.signal });
    assert.equal(first.status, 200);
    await until(() => h.count() === 1);
    const second = await fetch(`${h.address}/sessions/owned/events`, { headers });
    assert.equal(second.status, 429);
    abort.abort();
    await until(() => h.count() === 0);
  } finally { abort.abort(); await h.app.close(); }
});
test('SSE closes after token revocation and drops oversized live events', async () => {
  for (const cause of ['revocation', 'oversize']) {
    const h = await fixture();
    const abort = new AbortController();
    try {
      const response = await fetch(`${h.address}/sessions/owned/events`, { headers, signal: abort.signal });
      assert.equal(response.status, 200);
      await until(() => h.count() === 1);
      if (cause === 'revocation') h.revoke();
      else h.emit({ id: '1-0', type: 'test', data: { content: 'x'.repeat(2000) } });
      await until(() => h.count() === 0);
    } finally { abort.abort(); await h.app.close(); }
  }
});

test('SSE tells the client why the server ended the stream, in a final frame with no id', async () => {
  type Harness = Awaited<ReturnType<typeof fixture>>;
  const cases: { reason: 'authorization-failed' | 'slow-consumer' | 'token-expired'; expiresIn: number; trigger: (h: Harness) => void }[] = [
    { reason: 'authorization-failed', expiresIn: 3600, trigger: (h) => h.revoke() },
    { reason: 'slow-consumer', expiresIn: 3600, trigger: (h) => h.emit({ id: '1-0', type: 'test', data: { content: 'x'.repeat(2000) } }) },
    { reason: 'token-expired', expiresIn: 0.1, trigger: () => {} },
  ];
  for (const { reason, expiresIn, trigger } of cases) {
    const h = await fixture(expiresIn);
    try {
      const response = await fetch(`${h.address}/sessions/owned/events`, { headers });
      assert.equal(response.status, 200);
      await until(() => h.count() === 1);
      trigger(h);
      // Resolves only if the server ended the response; a bare socket drop would reject.
      const text = await response.text();
      assert.ok(text.endsWith(closingFrame(reason)), `${reason}: ${JSON.stringify(text)}`);
      assert.equal(closingFrame(reason), `event: stream.closing\ndata: {"reason":"${reason}"}\n\n`);
      assert.equal(closingFrame(reason).includes('id:'), false);
      await until(() => h.count() === 0);
    } finally { await h.app.close(); }
  }
});

test('SSE sends no closing frame when the client is the one that hung up', async () => {
  const h = await fixture();
  const abort = new AbortController();
  try {
    const response = await fetch(`${h.address}/sessions/owned/events`, { headers, signal: abort.signal });
    await until(() => h.count() === 1);
    abort.abort();
    await assert.rejects(response.text());
    await until(() => h.count() === 0);
  } finally { abort.abort(); await h.app.close(); }
});
