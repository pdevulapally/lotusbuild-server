import assert from 'node:assert/strict';
import test from 'node:test';
import type { AuthenticatedUser } from '../src/auth/plugin.ts';
import { FamilyService } from '../src/family/service.ts';
import { ledger } from './support/ledger.ts';
import type { SessionRepository } from '../src/sessions/repository.ts';
import Fastify from 'fastify';
import { registerFamilyRoutes } from '../src/family/routes.ts';
import { registerErrorHandler } from '../src/http/errors.ts';
import type { ProjectRepository } from '../src/projects/repository.ts';

const user = (uid: string): AuthenticatedUser => ({ uid, email: `${uid}@example.test`, emailVerified: true, authTime: Date.now() / 1000, displayName: uid, photoUrl: undefined });
test('a child needs invitation, parent approval and an explicit project grant', async () => {
  const { db, data } = ledger();
  const family = new FamilyService(db, 600);
  data.set('projects/p', { ownerUid: 'parent', status: 'draft' });
  const invitation = await family.invite(user('parent'), { adultConfirmed: true, parentalResponsibilityConfirmed: true });
  await family.accept(user('child'), 'parent', invitation.token);
  await assert.rejects(family.parentForProject('child', 'p'));
  await family.confirm(user('parent'), 'child', true);
  await assert.rejects(family.parentForProject('child', 'p'));
  await family.grant(user('parent'), 'child', 'p', true);
  assert.equal(await family.parentForProject('child', 'p'), 'parent');
  await family.confirm(user('parent'), 'child', false);
  await assert.rejects(family.parentForProject('child', 'p'));
});
test('invites are one-use and do not store bearer tokens', async () => {
  const { db, data } = ledger();
  const family = new FamilyService(db, 600);
  const invitation = await family.invite(user('parent'), { adultConfirmed: true, parentalResponsibilityConfirmed: true });
  assert.ok(!JSON.stringify([...data]).includes(invitation.token));
  await family.accept(user('child'), 'parent', invitation.token);
  await assert.rejects(family.accept(user('other'), 'parent', invitation.token));
});
test('another parent cannot approve, revoke or grant access through an existing link', async () => {
  const { db } = ledger();
  const family = new FamilyService(db, 600);
  const invitation = await family.invite(user('parent'), { adultConfirmed: true, parentalResponsibilityConfirmed: true });
  await family.accept(user('child'), 'parent', invitation.token);
  await assert.rejects(family.confirm(user('stranger'), 'child', true));
  await assert.rejects(family.confirm(user('stranger'), 'child', false));
  await assert.rejects(family.grant(user('stranger'), 'child', 'p', true));
});
test('unverified email and self-linking are refused', async () => {
  const { db } = ledger();
  const family = new FamilyService(db, 600);
  await assert.rejects(family.invite({ ...user('parent'), emailVerified: false }, { adultConfirmed: true, parentalResponsibilityConfirmed: true }));
  const invitation = await family.invite(user('parent'), { adultConfirmed: true, parentalResponsibilityConfirmed: true });
  await assert.rejects(family.accept(user('parent'), 'parent', invitation.token));
});

test('child build requests need explicit parent approval and reuse one durable session id', async () => {
  const { db, data } = ledger();
  const family = new FamilyService(db, 600);
  data.set('projects/p', { ownerUid: 'parent', status: 'draft' });
  const invitation = await family.invite(user('parent'), { adultConfirmed: true, parentalResponsibilityConfirmed: true });
  await family.accept(user('child'), 'parent', invitation.token);
  await family.confirm(user('parent'), 'child', true);
  await family.grant(user('parent'), 'child', 'p', true);
  const request = await family.requestBuild('child', 'p', { model: 'model', prompt: 'Please build a game' });
  const ids: string[] = [];
  const sessions = { create: async (uid: string, projectId: string, _input: unknown, id: string) => {
    assert.equal(uid, 'parent'); assert.equal(projectId, 'p'); ids.push(id); return { id };
  } } as unknown as SessionRepository;
  assert.equal(ids.length, 0);
  await assert.rejects(family.decideBuild(user('stranger'), 'child', 'p', request.requestId, true, sessions));
  await Promise.all(Array.from({ length: 3 }, () => family.decideBuild(user('parent'), 'child', 'p', request.requestId, true, sessions)));
  assert.equal(new Set(ids).size, 1);
});

test('a child cannot replace a revoked link while its previous parent erasure is pending', async () => {
  const { db, data } = ledger();
  const family = new FamilyService(db, 600);
  const invitation = await family.invite(user('new-parent'), { adultConfirmed: true, parentalResponsibilityConfirmed: true });
  data.set('familyLinks/child', { status: 'REVOKED', parentUid: 'old-parent' });
  data.set('accountErasures/old-parent', { status: 'PENDING' });
  await assert.rejects(family.accept(user('child'), 'new-parent', invitation.token), { code: 'family/access-denied' });
  assert.equal(data.get('familyLinks/child')?.['parentUid'], 'old-parent');
  data.set('familyLinks/child', { status: 'REVOKED' });
  await family.accept(user('child'), 'new-parent', invitation.token);
  assert.equal(data.get('familyLinks/child')?.['parentUid'], 'new-parent');
});

async function requestFixture() {
  const h = ledger();
  const family = new FamilyService(h.db, 600);
  const link = async (parent: string) => {
    const invitation = await family.invite(user(parent), { adultConfirmed: true, parentalResponsibilityConfirmed: true });
    await family.accept(user('child'), parent, invitation.token);
    await family.confirm(user(parent), 'child', true);
  };
  const request = async (parent: string, projectId: string) => {
    h.data.set(`projects/${projectId}`, { ownerUid: parent, status: 'draft' });
    await family.grant(user(parent), 'child', projectId, true);
    return family.requestBuild('child', projectId, { model: 'model', prompt: `Private ${parent} prompt for ${projectId}` });
  };
  await link('parent-a');
  const oldRequest = await request('parent-a', '01-a');
  const oldPath = 'familyLinks/child/buildRequests/01-a';
  const oldRecord = { ...h.data.get(oldPath) };
  const relink = async () => {
    await family.confirm(user('parent-a'), 'child', false);
    await link('parent-b');
  };
  return { ...h, family, link, request, relink, oldRequest, oldPath, oldRecord };
}

const denied = { code: 'family/access-denied', statusCode: 403, message: 'This family access is not authorized.' };
const noSessions = { create: async () => { throw new Error('Unauthorized request reached session creation.'); } } as unknown as SessionRepository;

test('relinking retains old requests without transferring visibility and preserves child requests', async () => {
  const h = await requestFixture();
  assert.equal((await h.family.buildRequests(user('parent-a'), 'child'))[0]?.requestId, h.oldRequest.requestId);
  await h.relink();
  assert.deepEqual(await h.family.buildRequests(user('parent-b'), 'child'), []);
  const current = await h.request('parent-b', '02-b');
  assert.deepEqual((await h.family.buildRequests(user('parent-b'), 'child')).map((r) => r.requestId), [current.requestId]);
  assert.deepEqual(h.data.get(h.oldPath), h.oldRecord);
  await assert.rejects(h.family.requestBuild('child', '01-a', { model: 'model', prompt: 'Replace old request' }), denied);
  await assert.rejects(h.family.parentForProject('child', '01-a'), denied);
  assert.equal(await h.family.parentForProject('child', '02-b'), 'parent-b');
});

test('mixed-parent pagination scopes before limits and exposes only current-parent cursors', async (t) => {
  const h = await requestFixture();
  await h.request('parent-a', '05-a');
  await h.request('parent-a', '03-a');
  await h.relink();
  for (const id of ['06-b', '02-b', '04-b']) await h.request('parent-b', id);
  const app = Fastify();
  t.after(() => app.close());
  let identity = user('parent-b');
  app.decorate('requireAuth', async (request) => { request.auth = identity; });
  app.decorate('enforceRateLimit', () => async () => {});
  registerErrorHandler(app);
  registerFamilyRoutes(app, h.family, {} as ProjectRepository, noSessions);
  const page = async (suffix = '') => {
    const response = await app.inject(`/family/children/child/build-requests?limit=2${suffix}`);
    assert.equal(response.statusCode, 200);
    return response.json<{ requests: { projectId: string }[]; nextCursor: string | null }>();
  };
  const first = await page();
  assert.deepEqual(first.requests.map((r) => r.projectId), ['02-b', '04-b']);
  assert.equal(first.nextCursor, '04-b');
  const second = await page(`&after=${first.nextCursor}`);
  assert.deepEqual(second.requests.map((r) => r.projectId), ['06-b']);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(await page(), first);
  assert.deepEqual((await page('&after=03-a')).requests.map((r) => r.projectId), ['04-b', '06-b']);
  assert.deepEqual(await page('&after=06-b'), { requests: [], nextCursor: null });
  for (const approved of [true, false]) {
    const response = await app.inject({ method: 'POST',
      url: '/family/children/child/projects/01-a/build-requests/decision',
      payload: { requestId: h.oldRequest.requestId, approved } });
    assert.equal(response.statusCode, 403);
    assert.deepEqual(response.json().error, { code: denied.code, message: denied.message });
  }
  identity = user('parent-a');
  assert.equal((await app.inject('/family/children/child/build-requests')).statusCode, 403);
  identity = user('child');
  for (const url of ['/family/projects/01-a', '/family/projects/01-a/sessions/private-parent-a-session/messages']) {
    const response = await app.inject(url);
    assert.equal(response.statusCode, 403);
    assert.deepEqual(response.json().error, { code: denied.code, message: denied.message });
  }
});

test('direct approval, rejection and completed-request retry cannot cross parent ownership', async () => {
  const h = await requestFixture();
  await h.relink();
  const current = await h.request('parent-b', '02-b');
  for (const status of ['PENDING', 'APPROVING', 'FULFILLED']) {
    const old = { ...h.data.get(h.oldPath), status, sessionId: 'private-parent-a-session' };
    h.data.set(h.oldPath, old);
    for (const approved of [true, false]) {
      await assert.rejects(h.family.decideBuild(user('parent-b'), 'child', '01-a', h.oldRequest.requestId, approved, noSessions), denied);
      await assert.rejects(h.family.decideBuild(user('parent-a'), 'child', '02-b', current.requestId, approved, noSessions), denied);
      await assert.rejects(h.family.decideBuild(user('parent-a'), 'child', '01-a', h.oldRequest.requestId, approved, noSessions), denied);
    }
    assert.deepEqual(h.data.get(h.oldPath), old);
  }
  await assert.rejects(h.family.buildRequests(user('parent-a'), 'child'), denied);
  await assert.rejects(h.family.decideBuild(user('parent-b'), 'child', 'absent', 'absent', true, noSessions), denied);
  assert.deepEqual(await h.family.decideBuild(user('parent-b'), 'child', '02-b', current.requestId, false, noSessions), { status: 'REJECTED' });
});

test('an authorized listing overlapping relinking stays scoped to its original parent', async (t) => {
  const h = await requestFixture();
  const original = h.db.runTransaction.bind(h.db);
  let pause = true;
  let entered!: () => void;
  let resume!: () => void;
  const authorized = new Promise<void>((resolve) => { entered = resolve; });
  const resumed = new Promise<void>((resolve) => { resume = resolve; });
  t.mock.method(h.db, 'runTransaction', async (work: Parameters<typeof original>[0]) => {
    const result = await original(work);
    if (pause) { pause = false; entered(); await resumed; }
    return result;
  });
  const listing = h.family.buildRequests(user('parent-a'), 'child');
  await authorized;
  try {
    await h.relink();
    await h.request('parent-b', '02-b');
  } finally { resume(); }
  assert.deepEqual((await listing).map((r) => r.projectId), ['01-a']);
  await assert.rejects(h.family.buildRequests(user('parent-a'), 'child'), denied);
  assert.deepEqual((await h.family.buildRequests(user('parent-b'), 'child')).map((r) => r.projectId), ['02-b']);
});

test('missing, malformed or foreign request ownership fails closed without replacement', async () => {
  const h = await requestFixture();
  await h.relink();
  const current = await h.request('parent-b', '02-b');
  const path = 'familyLinks/child/buildRequests/02-b';
  for (const parentUid of [undefined, null, '', 42, ['parent-b'], { uid: 'parent-b' }, 'parent-a']) {
    for (const status of ['PENDING', 'FULFILLED']) {
      const record: Record<string, unknown> = { requestId: current.requestId, prompt: 'Retained private prompt', model: 'model', status };
      if (parentUid !== undefined) record['parentUid'] = parentUid;
      h.data.set(path, record);
      assert.deepEqual(await h.family.buildRequests(user('parent-b'), 'child'), []);
      for (const approved of [true, false]) {
        await assert.rejects(h.family.decideBuild(user('parent-b'), 'child', '02-b', current.requestId, approved, noSessions), denied);
      }
      await assert.rejects(h.family.requestBuild('child', '02-b', { model: 'model', prompt: 'New child prompt' }), denied);
      assert.deepEqual(h.data.get(path), record);
    }
  }
});
