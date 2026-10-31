import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import type { Auth } from 'firebase-admin/auth';

import { registerAuth } from '../src/auth/plugin.ts';
import { CredentialKeyring } from '../src/connections/credentials.ts';
import { connectorKeys } from '../src/connections/registry.ts';
import { registerConnectionRoutes } from '../src/connections/routes.ts';
import { ConnectionRepository } from '../src/connections/service.ts';
import { registerErrorHandler } from '../src/http/errors.ts';
import { ledger } from './support/ledger.ts';

function harness(configuredKeyring = true) {
  const store = ledger();
  const repository = new ConnectionRepository(store.db, new CredentialKeyring(new Map([[1, randomBytes(32)]])));
  let uid = 'alice';
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerAuth(app, { verifyIdToken: async () => ({ uid, email: 'a@example.test', email_verified: true, auth_time: 1, exp: 4_000_000_000 }) } as unknown as Auth);
  app.decorate('enforceRateLimit', () => async () => {});
  registerConnectionRoutes(app, { connections: configuredKeyring ? repository : undefined, configured: new Set() });
  return { app, store, repository, as: (next: string) => { uid = next; } };
}
const headers = { authorization: 'Bearer fixture' };

describe('connection routes', () => {
  it('lists the catalogue in the agreed order, all awaiting provider setup', async (t) => {
    const h = harness();
    t.after(() => h.app.close());
    const response = await h.app.inject({ method: 'GET', url: '/connections/catalogue', headers });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { connectors: Array<{ key: string; status: string }> };
    assert.deepEqual(body.connectors.map((c) => c.key), [...connectorKeys]);
    assert.ok(body.connectors.every((c) => c.status === 'configuration_required'));
    const start = await h.app.inject({ method: 'POST', url: '/connections/netlify/start', headers });
    assert.equal(start.statusCode, 503);
    assert.equal((start.json() as { error: { code: string } }).error.code, 'connections/configuration-required');
    assert.equal((await h.app.inject({ method: 'POST', url: '/connections/github/start', headers })).statusCode, 404);
    assert.equal((await h.app.inject({ method: 'GET', url: '/connections' })).statusCode, 401);
  });

  it('serves a user their own connections with grants and never the credential', async (t) => {
    const h = harness();
    t.after(() => h.app.close());
    await h.repository.begin({ id: 'c1', ownerUid: 'alice', connector: 'netlify' });
    await h.repository.activate({ id: 'c1', ownerUid: 'alice', account: { id: 'n1', name: 'Alice' }, scopes: ['sites'], secret: Buffer.from('nfp_secret_token'), projectIds: ['p1'] });
    const list = await h.app.inject({ method: 'GET', url: '/connections', headers });
    assert.equal(list.statusCode, 200);
    assert.equal((list.json() as { connections: unknown[] }).connections.length, 1);
    const detail = await h.app.inject({ method: 'GET', url: '/connections/c1', headers });
    const connection = (detail.json() as { connection: { status: string; grantedProjectIds: string[] } }).connection;
    assert.equal(connection.status, 'active');
    assert.deepEqual(connection.grantedProjectIds, ['p1']);
    const sealed = h.store.data.get('connection_credentials/c1')!;
    for (const payload of [list.body, detail.body]) {
      assert.equal(payload.includes('nfp_secret_token'), false);
      assert.equal(payload.includes(sealed['ciphertext'] as string), false);
      assert.equal(payload.includes('wrappedKey'), false);
    }
    const grants = await h.app.inject({ method: 'PUT', url: '/connections/c1/grants', headers, payload: { projectIds: ['p2', 'p2'] } });
    assert.equal(grants.statusCode, 200);
    assert.deepEqual((grants.json() as { connection: { grantedProjectIds: string[] } }).connection.grantedProjectIds, ['p2']);
    assert.equal((await h.app.inject({ method: 'PUT', url: '/connections/c1/grants', headers, payload: { projectIds: ['../x'] } })).statusCode, 400);
    h.as('mallory');
    assert.equal((await h.app.inject({ method: 'GET', url: '/connections/c1', headers })).statusCode, 404);
    assert.equal((await h.app.inject({ method: 'DELETE', url: '/connections/c1', headers })).statusCode, 404);
    assert.equal((await h.app.inject({ method: 'GET', url: '/connections', headers })).json().connections.length, 0);
    h.as('alice');
    const gone = await h.app.inject({ method: 'DELETE', url: '/connections/c1', headers });
    assert.equal(gone.statusCode, 200);
    assert.deepEqual(gone.json(), { ...gone.json(), providerRevoked: false });
    assert.equal((gone.json() as { connection: { status: string } }).connection.status, 'revoked');
    assert.equal(h.store.data.has('connection_credentials/c1'), false);
  });

  it('reports configuration_required everywhere while no key-encryption key is set', async (t) => {
    const h = harness(false);
    t.after(() => h.app.close());
    const response = await h.app.inject({ method: 'GET', url: '/connections', headers });
    assert.equal(response.statusCode, 503);
    assert.equal((response.json() as { error: { code: string } }).error.code, 'connections/configuration-required');
  });
});
