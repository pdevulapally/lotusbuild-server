import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import type { Auth } from 'firebase-admin/auth';

import type { EmailVerificationService } from '../src/auth/email-verification.ts';
import { registerEmailVerificationRoutes } from '../src/auth/email-verification-routes.ts';
import { registerAuth } from '../src/auth/plugin.ts';
import { registerErrorHandler } from '../src/http/errors.ts';

function harness(verified: boolean) {
  const calls: Array<{ operation: string; value?: string }> = [];
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerAuth(app, {
    verifyIdToken: async () => ({
      uid: 'u1',
      email: 'person@example.test',
      email_verified: verified,
      auth_time: 1,
      exp: 4_000_000_000,
    }),
  } as unknown as Auth);
  app.decorate('enforceRateLimit', () => async () => {});
  registerEmailVerificationRoutes(app, {
    send: async () => {
      calls.push({ operation: 'send' });
      return { expiresInSeconds: 600, resendAfterSeconds: 60 };
    },
    verify: async (_uid: string, code: string) => {
      calls.push({ operation: 'verify', value: code });
    },
  } as unknown as EmailVerificationService);
  return { app, calls };
}

const headers = { authorization: 'Bearer fixture' };

test('an unverified authenticated user can request and submit a code', async (t) => {
  const h = harness(false);
  t.after(() => h.app.close());

  const sent = await h.app.inject({ method: 'POST', url: '/auth/email-verification/code', headers });
  assert.equal(sent.statusCode, 200);
  assert.deepEqual(sent.json(), { verified: false, expiresInSeconds: 600, resendAfterSeconds: 60 });

  const verified = await h.app.inject({
    method: 'POST',
    url: '/auth/email-verification/verify',
    headers,
    payload: { code: '012345' },
  });
  assert.equal(verified.statusCode, 200);
  assert.deepEqual(verified.json(), { verified: true });
  assert.deepEqual(h.calls, [{ operation: 'send' }, { operation: 'verify', value: '012345' }]);
});

test('a verified provider account bypasses code delivery and validation', async (t) => {
  const h = harness(true);
  t.after(() => h.app.close());
  assert.deepEqual((await h.app.inject({
    method: 'POST',
    url: '/auth/email-verification/code',
    headers,
  })).json(), { verified: true, expiresInSeconds: 0, resendAfterSeconds: 0 });
  assert.deepEqual((await h.app.inject({
    method: 'POST',
    url: '/auth/email-verification/verify',
    headers,
    payload: { code: '012345' },
  })).json(), { verified: true });
  assert.deepEqual(h.calls, []);
});

test('verification accepts exactly six decimal digits', async (t) => {
  const h = harness(false);
  t.after(() => h.app.close());
  for (const code of ['12345', '1234567', '12a456', '１２３４５６']) {
    const response = await h.app.inject({
      method: 'POST',
      url: '/auth/email-verification/verify',
      headers,
      payload: { code },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'request/invalid');
  }
  assert.deepEqual(h.calls, []);
});
