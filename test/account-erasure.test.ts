import assert from 'node:assert/strict';
import test from 'node:test';
import type { Auth } from 'firebase-admin/auth';
import type { ProjectRepository } from '../src/projects/repository.ts';
import type { SessionRepository } from '../src/sessions/repository.ts';
import type { AuthenticatedUser } from '../src/auth/plugin.ts';
import { FamilyService } from '../src/family/service.ts';
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
test('account erasure removes operational receipts containing chat data only for that account', async () => {
  const h = fixture();
  h.data.set('mutationReceipts/a', { uid: 'u', body: { prompt: 'Private instruction' } });
  h.data.set('mutationReceipts/b', { uid: 'another-user', body: {} });
  await h.service.apply('u', decision);
  assert.ok(!h.data.has('mutationReceipts/a')); assert.ok(h.data.has('mutationReceipts/b'));
});
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

for (const failingPath of ['projects', 'buildRequests']) {
  test(`erasure retries cleanup interrupted at family ${failingPath}`, async (t) => {
    const h = fixture();
    h.data.set('familyLinks/child', { parentUid: 'u', childEmail: 'child@example.test', status: 'ACTIVE' });
    h.data.set('familyLinks/child/projects/p', { enabled: true });
    h.data.set('familyLinks/child/buildRequests/p', { parentUid: 'u', prompt: 'Private instruction' });
    const collection = h.db.collection.bind(h.db);
    let fail = true;
    t.mock.method(h.db, 'collection', (path: string) => {
      const query = collection(path);
      if (path === `familyLinks/child/${failingPath}`) {
        const limit = query.limit.bind(query);
        t.mock.method(query, 'limit', (size: number) => {
          const page = limit(size);
          const get = page.get.bind(page);
          t.mock.method(page, 'get', async () => {
            if (fail) { fail = false; throw new Error('Interrupted cleanup'); }
            return get();
          });
          return page;
        });
      }
      return query;
    });
    await assert.rejects(h.service.apply('u', decision), /Interrupted cleanup/);
    assert.equal(h.data.get('familyLinks/child')?.['status'], 'REVOKED');
    assert.equal(h.data.get('familyLinks/child')?.['parentUid'], 'u');
    assert.equal(h.data.get('accountErasures/u')?.['status'], 'PENDING');
    await h.service.apply('u', decision);
    assert.ok(!h.data.has('familyLinks/child/projects/p'));
    assert.ok(!h.data.has('familyLinks/child/buildRequests/p'));
    assert.equal(h.data.get('familyLinks/child')?.['parentUid'], undefined);
    await h.service.apply('u', decision);
  });
}

const actor = (uid: string): AuthenticatedUser => ({ uid, email: `${uid}@example.test`, emailVerified: true,
  authTime: Date.now() / 1000, displayName: uid, photoUrl: undefined });

for (const boundary of ['revoke', 'projects', 'buildRequests', 'unlink']) {
  test(`overlapping erasure cannot mutate a new family after pausing before ${boundary}`, async (t) => {
    const h = fixture();
    const family = new FamilyService(h.db, 600);
    h.data.set('familyLinks/child', { parentUid: 'u', status: 'ACTIVE' });
    h.data.set('familyLinks/child/projects/p', { enabled: true });
    h.data.set('familyLinks/child/buildRequests/p', { parentUid: 'u', prompt: 'Old request' });
    let entered!: () => void;
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    const collection = h.db.collection.bind(h.db);
    let waiting = true;
    t.mock.method(h.db, 'collection', (path: string) => {
      const query = collection(path);
      const target = boundary === 'revoke' ? 'familyLinks'
        : `familyLinks/child/${boundary === 'unlink' ? 'buildRequests' : boundary}`;
      if (path !== target) return query;
      // apply() uses a filtered query for the initial parent-link page.
      const selected = boundary === 'revoke' ? query.where('parentUid', '==', 'u') : query;
      if (boundary === 'revoke') t.mock.method(query, 'where', () => selected);
      const limit = selected.limit.bind(selected);
      t.mock.method(selected, 'limit', (size: number) => {
        const page = limit(size);
        const get = page.get.bind(page);
        t.mock.method(page, 'get', async () => {
          const result = await get();
          if (waiting && (boundary === 'unlink' ? result.empty : !result.empty)) {
            waiting = false; entered(); await resume;
          }
          return result;
        });
        return page;
      });
      return query;
    });
    const slow = h.service.apply('u', decision);
    await paused;
    try {
      await h.service.apply('u', decision);
      const invite = await family.invite(actor('new-parent'), { adultConfirmed: true, parentalResponsibilityConfirmed: true });
      await family.accept(actor('child'), 'new-parent', invite.token);
      await family.confirm(actor('new-parent'), 'child', true);
      // Reuse the exact document IDs captured by the slow worker's old page.
      h.data.set('projects/p', { ownerUid: 'new-parent', status: 'draft' });
      await family.grant(actor('new-parent'), 'child', 'p', true);
      await family.requestBuild('child', 'p', { model: 'model-1', prompt: 'New private request' });
    } finally { release(); await slow; }
    assert.equal(h.data.get('familyLinks/child')?.['parentUid'], 'new-parent');
    assert.equal(h.data.get('familyLinks/child')?.['status'], 'ACTIVE');
    assert.equal(h.data.get('familyLinks/child/projects/p')?.['enabled'], true);
    assert.equal(h.data.get('familyLinks/child/buildRequests/p')?.['prompt'], 'New private request');
  });
}

test('family erasure deletes every page before permitting a new link', async () => {
  const h = fixture();
  h.data.set('familyLinks/child', { parentUid: 'u', status: 'ACTIVE' });
  for (let i = 0; i < 205; i++) {
    h.data.set(`familyLinks/child/projects/${i}`, { enabled: true });
    h.data.set(`familyLinks/child/buildRequests/${i}`, { parentUid: 'u' });
  }
  await h.service.apply('u', decision);
  assert.equal([...h.data.keys()].filter((path) => path.startsWith('familyLinks/child/')).length, 0);
  assert.equal(h.data.get('familyLinks/child')?.['parentUid'], undefined);
});
