import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';

import { CredentialKeyring } from '../src/connections/credentials.ts';
import { ConnectionInactiveError, ConnectionNotFoundError, ConnectionNotGrantedError, ConnectionRepository } from '../src/connections/service.ts';
import { ledger } from './support/ledger.ts';

const setup = () => {
  const store = ledger();
  for (const id of ['p1', 'p2', 'p3']) store.data.set(`projects/${id}`, { ownerUid: 'alice', status: 'draft' });
  const repository = new ConnectionRepository(store.db, new CredentialKeyring(new Map([[1, randomBytes(32)]])));
  return { store, repository };
};
const account = { id: 'acct-1', name: 'Alice', team: 'Acme' };

describe('ConnectionRepository', () => {
  it('activates with a sealed credential and grants only the listed projects', async () => {
    const { store, repository } = setup();
    await repository.begin({ id: 'c1', ownerUid: 'alice', connector: 'netlify' });
    assert.equal((await repository.read('c1', 'alice')).status, 'connecting');
    const active = await repository.activate({ id: 'c1', ownerUid: 'alice', account, scopes: ['sites:write'], secret: Buffer.from('tok'), projectIds: ['p1'] });
    assert.equal(active.status, 'active');
    assert.deepEqual(await repository.grantedProjects('c1', 'alice'), ['p1']);
    const stored = store.data.get('connection_credentials/c1');
    assert.ok(stored && typeof stored['ciphertext'] === 'string' && !JSON.stringify(stored).includes('tok'));
    assert.equal(JSON.stringify(store.data.get('connections/c1')).includes('tok'), false);
    const opened = await repository.openCredential({ id: 'c1', ownerUid: 'alice', projectId: 'p1' });
    assert.equal(opened.secret.toString(), 'tok');
    await assert.rejects(repository.openCredential({ id: 'c1', ownerUid: 'alice', projectId: 'p2' }), ConnectionNotGrantedError);
    await assert.rejects(repository.openCredential({ id: 'c1', ownerUid: 'mallory', projectId: 'p1' }), ConnectionNotFoundError);
    await assert.rejects(repository.read('c1', 'mallory'), ConnectionNotFoundError);
    assert.equal((await repository.listForUser('mallory')).length, 0);
    assert.equal((await repository.listForUser('alice')).length, 1);
  });

  it('replaces grants and refuses secrets once disconnected or unhealthy', async () => {
    const { store, repository } = setup();
    await repository.begin({ id: 'c1', ownerUid: 'alice', connector: 'vercel' });
    await repository.activate({ id: 'c1', ownerUid: 'alice', account, scopes: [], secret: Buffer.from('tok'), projectIds: ['p1', 'p2'] });
    await repository.setGrants('c1', 'alice', ['p2', 'p3']);
    assert.deepEqual([...(await repository.grantedProjects('c1', 'alice'))].sort(), ['p2', 'p3']);
    await assert.rejects(repository.openCredential({ id: 'c1', ownerUid: 'alice', projectId: 'p1' }), ConnectionNotGrantedError);
    const expired = await repository.setStatus('c1', 'alice', 'expired', 'refresh token rejected');
    assert.equal(expired.health?.ok, false);
    await assert.rejects(repository.openCredential({ id: 'c1', ownerUid: 'alice', projectId: 'p2' }),
      (e: unknown) => e instanceof ConnectionInactiveError && e.status === 'expired');
    const revoked = await repository.disconnect('c1', 'alice');
    assert.equal(revoked.status, 'revoked');
    assert.equal(store.data.has('connection_credentials/c1'), false);
    await assert.rejects(repository.openCredential({ id: 'c1', ownerUid: 'alice', projectId: 'p2' }), ConnectionInactiveError);
    await assert.rejects(repository.disconnect('c1', 'mallory'), ConnectionNotFoundError);
  });

  it('grants only projects the user owns, and stops honouring a grant once the project is gone', async () => {
    const store = ledger();
    for (const id of ['p1', 'p2']) store.data.set(`projects/${id}`, { ownerUid: 'alice', status: 'draft' });
    store.data.set('projects/bobs', { ownerUid: 'bob', status: 'draft' });
    const repository = new ConnectionRepository(store.db, new CredentialKeyring(new Map([[1, randomBytes(32)]])));
    await repository.begin({ id: 'c1', ownerUid: 'alice', connector: 'netlify' });
    await assert.rejects(repository.activate({ id: 'c1', ownerUid: 'alice', account, scopes: [], secret: Buffer.from('tok'), projectIds: ['p1', 'bobs'] }), /No accessible project/);
    assert.equal(store.data.has('connection_credentials/c1'), false);
    await repository.activate({ id: 'c1', ownerUid: 'alice', account, scopes: [], secret: Buffer.from('tok'), projectIds: ['p1'] });
    await assert.rejects(repository.setGrants('c1', 'alice', ['p1', 'bobs']), /No accessible project/);
    await assert.rejects(repository.setGrants('c1', 'alice', ['p1', 'missing']), /No accessible project/);
    assert.deepEqual([...(await repository.grantedProjects('c1', 'alice'))], ['p1']);
    await assert.rejects(repository.openCredential({ id: 'c1', ownerUid: 'alice', projectId: 'bobs' }), /No accessible project/);
    const opened = await repository.openCredential({ id: 'c1', ownerUid: 'alice', projectId: 'p1' });
    assert.equal(opened.secret.toString(), 'tok');
    store.data.set('projects/p1', { ownerUid: 'alice', status: 'deleting' });
    await assert.rejects(repository.openCredential({ id: 'c1', ownerUid: 'alice', projectId: 'p1' }), /No accessible project/);
    store.data.set('projects/p1', { ownerUid: 'alice', status: 'draft' });
    store.data.set('accountErasures/alice', { requestedAt: 1 });
    await assert.rejects(repository.openCredential({ id: 'c1', ownerUid: 'alice', projectId: 'p1' }), /No accessible project/);
  });
});
