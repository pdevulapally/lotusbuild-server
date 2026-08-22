import assert from 'node:assert/strict';
import { test } from 'node:test';

import Fastify from 'fastify';

import { AppError, registerErrorHandler } from './errors.ts';

function appThatThrows(error: unknown) {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  app.get('/boom', async () => {
    throw error;
  });
  app.post(
    '/validated',
    { schema: { body: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } },
    async () => ({ ok: true }),
  );
  return app;
}

test('an AppError is returned as its own code, status and details', async () => {
  const app = appThatThrows(
    new AppError({
      code: 'quota/exhausted',
      statusCode: 402,
      message: 'Your plan has no build seconds left.',
      details: { remainingSeconds: 0 },
    }),
  );

  const response = await app.inject({ method: 'GET', url: '/boom' });

  assert.equal(response.statusCode, 402);
  assert.deepEqual(response.json(), {
    error: {
      code: 'quota/exhausted',
      message: 'Your plan has no build seconds left.',
      details: { remainingSeconds: 0 },
    },
    requestId: 'req-1',
  });
  await app.close();
});

test('an unexpected error never leaks its message to the client', async () => {
  const app = appThatThrows(new Error('connection to 10.0.0.4 failed: password=hunter2'));

  const response = await app.inject({ method: 'GET', url: '/boom' });
  const payload = response.payload;

  assert.equal(response.statusCode, 500);
  assert.equal(response.json().error.code, 'internal/unexpected');
  assert.doesNotMatch(payload, /hunter2/);
  assert.doesNotMatch(payload, /10\.0\.0\.4/);
  await app.close();
});

test('a schema violation is a 400 in the same envelope, not a raw Fastify error', async () => {
  const app = appThatThrows(new Error('unused'));

  const response = await app.inject({ method: 'POST', url: '/validated', payload: {} });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'request/invalid');
  await app.close();
});

test('an unmatched route uses the envelope too', async () => {
  const app = appThatThrows(new Error('unused'));

  const response = await app.inject({ method: 'GET', url: '/nope' });

  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, 'request/not-found');
  await app.close();
});
