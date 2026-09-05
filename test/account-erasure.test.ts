import assert from 'node:assert/strict';
import test from 'node:test';
import type { Auth } from 'firebase-admin/auth';
import type { ProjectRepository } from '../src/projects/repository.ts';
import type { SessionRepository } from '../src/sessions/repository.ts';
import { AccountErasure } from '../src/privacy/erasure.ts';
import { ledger } from './support/ledger.ts';

const decision = { requestReference: 'request-1', billingReviewReference: 'review-1', retentionDecisionReference: 'policy-1' };
function fixture() {
  const h = ledger();
  const events: string[] = [];
  const service = new AccountErasure(h.db, {
    updateUser: async () => { events.push('disable'); }, revokeRefreshTokens: async () => { events.push('revoke'); }, deleteUser: async () => { events.push('delete-identity'); },
  } as unknown as Auth, { delete: async (_uid: string, id: string) => { events.push('delete-project'); h.data.delete(`projects/${id}`); } } as unknown as ProjectRepository,
  { cancel: async () => { events.push('cancel'); } } as unknown as SessionRepository, async () => { events.push('clear-cache'); });
  return { ...h, events, service };
}
test('erasure disables access but waits for active work without deleting project data', async () => {
  const h = fixture();
  h.data.set('sessions/s', { ownerUid: 'u', status: 'RUNNING' });
  h.data.set('projects/p', { ownerUid: 'u' });
  await assert.rejects(h.service.apply('u', decision), { code: 'account/erasure-pending' });
  assert.deepEqual(h.events, ['disable', 'revoke', 'cancel']);
  assert.ok(h.data.has('projects/p'));
  assert.equal(h.data.get('accountErasures/u')?.['status'], 'PENDING');
});
test('erasure preserves unresolved reservations rather than guessing zero usage', async () => {
  const h = fixture();
  h.data.set('users/u/reservations/r', { status: 'OPEN' });
  await assert.rejects(h.service.apply('u', decision), { code: 'account/reconciliation-required' });
  assert.ok(!h.events.includes('delete-identity'));
});
test('live erasure retains reviewed financial records and reports provider confirmation pending', async () => {
  const h = fixture();
  h.data.set('users/u', { email: 'private@example.test' });
  h.data.set('users/u/reservations/closed', { status: 'SETTLED' });
  h.data.set('projects/p', { ownerUid: 'u' });
  h.data.set('familyLinks/child', { parentUid: 'u', childEmail: 'child@example.test', status: 'ACTIVE' });
  h.data.set('familyLinks/child/projects/p', { enabled: true });
  const result = await h.service.apply('u', decision);
  assert.equal(result.status, 'LIVE_CONTENT_ERASED_VENDOR_CONFIRMATION_PENDING');
  assert.ok(!h.data.has('users/u'));
  assert.ok(h.data.has('users/u/reservations/closed'));
  assert.ok(!h.data.has('projects/p'));
  assert.equal(h.data.get('familyLinks/child')?.['status'], 'REVOKED');
  assert.equal(h.data.get('familyLinks/child')?.['parentUid'], undefined);
  assert.ok(!h.data.has('familyLinks/child/projects/p'));
  await h.service.apply('u', decision);
});
