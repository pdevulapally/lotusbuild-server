import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import type { Auth } from 'firebase-admin/auth';
import { registerAuth } from '../src/auth/plugin.ts';
import { registerErrorHandler } from '../src/http/errors.ts';
import { registerProjectRoutes } from '../src/projects/routes.ts';
import type { ProjectRepository } from '../src/projects/repository.ts';

function harness() {
  const created: Record<string, unknown>[] = [];
  const app = Fastify({ logger: false });
  registerAuth(app, { verifyIdToken: async () => ({ uid: 'u1', email_verified: true, auth_time: Date.now() / 1000, exp: Date.now() / 1000 + 3600 }) } as unknown as Auth);
  registerErrorHandler(app);
  app.decorate('enforceRateLimit', () => async () => {});
  registerProjectRoutes(app, {
    create: async (_uid: string, input: Record<string, unknown>) => {
      created.push(input);
      return { id: 'p1', name: input['name'], description: input['description'], platform: input['platform'], status: 'draft',
        publicPreviewEnabled: false, createdAt: new Date(0) };
    },
  } as unknown as ProjectRepository);
  return { app, created };
}

const headers = { authorization: 'Bearer token' };

test('a project is created without the caller choosing a platform', async (t) => {
  const h = harness();
  t.after(() => h.app.close());
  const response = await h.app.inject({ method: 'POST', url: '/projects', headers, payload: { name: ' App ', description: ' A thing ' } });
  assert.equal(response.statusCode, 201);
  assert.deepEqual(h.created, [{ name: 'App', description: 'A thing', platform: 'web' }]);
  // The response contract is unchanged for now: clients still see the stored platform.
  assert.equal(response.json().platform, 'web');
});

test('a client that still sends platform is not obeyed', async (t) => {
  const h = harness();
  t.after(() => h.app.close());
  for (const platform of ['web', 'mobile', 'anything']) {
    const response = await h.app.inject({ method: 'POST', url: '/projects', headers, payload: { name: 'App', platform } });
    assert.equal(response.statusCode, 201, platform);
  }
  assert.deepEqual(h.created.map((input) => input['platform']), ['web', 'web', 'web']);
});

test('a name is still required', async (t) => {
  const h = harness();
  t.after(() => h.app.close());
  const response = await h.app.inject({ method: 'POST', url: '/projects', headers, payload: { description: 'no name' } });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'request/invalid');
  assert.deepEqual(h.created, []);
});
