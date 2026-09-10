import assert from 'node:assert/strict';
import test from 'node:test';
import type { AuthenticatedUser } from '../src/auth/plugin.ts';
import { FamilyService } from '../src/family/service.ts';
import { ledger } from './support/ledger.ts';
import type { SessionRepository } from '../src/sessions/repository.ts';

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
