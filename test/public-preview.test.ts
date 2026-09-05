import assert from 'node:assert/strict';
import test from 'node:test';
import { Timestamp } from 'firebase-admin/firestore';
import { ProjectRepository } from '../src/projects/repository.ts';
import type { UserRepository } from '../src/users/repository.ts';
import type { EntitlementService } from '../src/entitlements/service.ts';
import { workspaceTools, type ToolContext } from '../src/runner/tools.ts';
import { ledger } from './support/ledger.ts';

function fixture() {
  const h = ledger();
  h.data.set('projects/p', { ownerUid: 'owner', name: 'P', platform: 'web', status: 'draft', activeSessionId: null, createdAt: Timestamp.now() });
  return { ...h, projects: new ProjectRepository(h.db, {} as UserRepository, {} as EntitlementService) };
}
test('public preview is off by default and only the owner can enable it', async () => {
  const h = fixture();
  assert.equal((await h.projects.readOwned('owner', 'p')).publicPreviewEnabled, false);
  await assert.rejects(h.projects.setPublicPreview('stranger', 'p', true), { code: 'project/not-found' });
  assert.deepEqual(await h.projects.setPublicPreview('owner', 'p', true), { enabled: true, terminationPending: false });
});
test('revoking a running public preview requests termination and does not claim instant revocation', async () => {
  const h = fixture();
  Object.assign(h.data.get('projects/p')!, { activeSessionId: 's', publicPreviewEnabled: true });
  h.data.set('sessions/s', { ownerUid: 'owner', projectId: 'p', status: 'RUNNING' });
  assert.deepEqual(await h.projects.setPublicPreview('owner', 'p', false), { enabled: false, terminationPending: true });
  assert.equal(h.data.get('sessions/s')?.['cancelRequested'], true);
  await assert.rejects(h.projects.setPublicPreview('owner', 'p', true), { code: 'project/session-active' });
});
test('a private preview tool cannot start a public server or emit a URL', async () => {
  const preview = workspaceTools.get('start_preview')!;
  const result = await preview.run({ command: 'start-server', port: 3000 }, {} as ToolContext);
  assert.equal(result.isError, true);
  assert.match(result.text, /disabled/);
});
test('an account erasure fence prevents new project mutations', async () => {
  const h = fixture();
  h.data.set('accountErasures/owner', { status: 'PENDING' });
  await assert.rejects(h.db.runTransaction((tx) => h.projects.readOwnedInTransaction(tx, 'owner', 'p')), { code: 'account/erasure-pending' });
  // Cleanup can still finalize existing resources under its own lease checks.
  await h.db.runTransaction((tx) => h.projects.readOwnedInTransaction(tx, 'owner', 'p', true));
});
