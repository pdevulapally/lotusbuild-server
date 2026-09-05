import assert from 'node:assert/strict';
import test from 'node:test';
import { PrivacyRequests } from '../src/privacy/requests.ts';
import { ledger } from './support/ledger.ts';

test('parallel privacy requests return one durable acknowledgement without claiming erasure', async () => {
  const { db, data } = ledger();
  const requests = new PrivacyRequests(db);
  const replies = await Promise.all(Array.from({ length: 8 }, () => requests.submit('u', 'erasure')));
  assert.equal(new Set(replies.map((r) => r.reference)).size, 1);
  assert.ok(replies.every((r) => r.status === 'RECEIVED'));
  assert.equal(data.size, 1);
});
test('privacy request listing is scoped to the authenticated account', async () => {
  const { db } = ledger();
  const requests = new PrivacyRequests(db);
  await requests.submit('alice', 'access');
  assert.deepEqual(await requests.list('bob'), []);
  assert.equal((await requests.list('alice')).length, 1);
});
