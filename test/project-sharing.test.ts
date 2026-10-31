import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Timestamp } from 'firebase-admin/firestore';

import { ProjectFiles, isProjectPath } from '../src/projects/files.ts';
import { type Project, ProjectRepository } from '../src/projects/repository.ts';
import type { UserRepository } from '../src/users/repository.ts';
import type { EntitlementService } from '../src/entitlements/service.ts';
import { ledger } from './support/ledger.ts';

function fixture(fields: Record<string, unknown> = {}) {
  const h = ledger();
  h.data.set('projects/p', { ownerUid: 'owner', name: 'P', platform: 'web', status: 'draft', activeSessionId: null, createdAt: Timestamp.now(), ...fields });
  return { ...h, projects: new ProjectRepository(h.db, {} as UserRepository, {} as EntitlementService) };
}

test('projects are private by default and every refusal is an indistinguishable 404', async () => {
  const h = fixture();
  assert.equal((await h.projects.readOwned('owner', 'p')).visibility, 'private');
  await assert.rejects(h.projects.readShared('p', undefined), { code: 'project/not-found' });
  await assert.rejects(h.projects.readShared('missing', undefined), { code: 'project/not-found' });
  await assert.rejects(h.projects.readOwned('stranger', 'p'), { code: 'project/not-found' });
});

test('only the owner can change visibility, and a link needs its exact token', async () => {
  const h = fixture();
  await assert.rejects(h.projects.setVisibility('stranger', 'p', 'public'), { code: 'project/not-found' });
  const { shareToken } = await h.projects.setVisibility('owner', 'p', 'link');
  assert.match(shareToken!, /^[A-Za-z0-9_-]{32}$/);
  assert.equal((await h.projects.readShared('p', shareToken!)).id, 'p');
  await assert.rejects(h.projects.readShared('p', undefined), { code: 'project/not-found' });
  const wrongLast = shareToken!.endsWith('x') ? 'y' : 'x';
  await assert.rejects(h.projects.readShared('p', `${shareToken!.slice(0, 31)}${wrongLast}`), { code: 'project/not-found' });
  const rotated = await h.projects.setVisibility('owner', 'p', 'link', true);
  assert.notEqual(rotated.shareToken, shareToken);
  await assert.rejects(h.projects.readShared('p', shareToken!), { code: 'project/not-found' });
});

test('leaving link-only revokes the old link for good', async () => {
  const h = fixture();
  const { shareToken } = await h.projects.setVisibility('owner', 'p', 'link');
  await h.projects.setVisibility('owner', 'p', 'private');
  const again = await h.projects.setVisibility('owner', 'p', 'link');
  assert.notEqual(again.shareToken, shareToken);
  await assert.rejects(h.projects.readShared('p', shareToken!), { code: 'project/not-found' });
});

test('public projects are readable without a token, but not once the account is being erased', async () => {
  const h = fixture({ visibility: 'public' });
  assert.equal((await h.projects.readShared('p', undefined)).visibility, 'public');
  h.data.set('accountErasures/owner', { status: 'PENDING' });
  await assert.rejects(h.projects.readShared('p', undefined), { code: 'project/not-found' });
});

function snapshotOf(build: (repo: string) => void) {
  const repo = mkdtempSync(join(tmpdir(), 'lb-files-test-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'index.html'), '<h1>Ember</h1>\n');
  execFileSync('mkdir', ['-p', join(repo, 'src')]);
  writeFileSync(join(repo, 'src', 'app.ts'), 'export const ok = true;\n');
  writeFileSync(join(repo, 'logo.bin'), Buffer.from([0, 1, 2, 3]));
  git('add', '.'); git('commit', '-q', '-m', 'init');
  git('checkout', '-q', '-b', 'feature');
  writeFileSync(join(repo, 'feature.md'), '# Feature\n');
  git('add', '.'); git('commit', '-q', '-m', 'feature');
  git('checkout', '-q', 'main');
  build(repo);
  execFileSync('tar', ['-czf', join(repo, 'snap.tgz'), '.git'], { cwd: repo });
  const archive = readFileSync(join(repo, 'snap.tgz'));
  rmSync(repo, { recursive: true, force: true });
  const files = new ProjectFiles({ readUrl: async () => 'https://storage.invalid/snap' }, async () => new Response(archive));
  const project = { id: 'p', snapshot: { kind: 'immutable', objectName: 'o', generation: '1' } } as unknown as Project;
  return { files, project };
}

test('the saved tree, branches and file contents are read from the git snapshot', async () => {
  const { files, project } = snapshotOf(() => {});
  const tree = await files.tree(project);
  assert.equal(tree.head, 'main');
  assert.deepEqual([...tree.branches].sort(), ['feature', 'main']);
  assert.deepEqual(tree.files.map((file) => file.path).sort(), ['index.html', 'logo.bin', 'src/app.ts']);
  assert.ok((await files.tree(project, 'feature')).files.some((file) => file.path === 'feature.md'));
  assert.equal((await files.read(project, 'src/app.ts')).content, 'export const ok = true;\n');
  assert.deepEqual(await files.read(project, 'logo.bin'), { path: 'logo.bin', size: 4, binary: true, truncated: false, content: null });
  await assert.rejects(files.tree(project, 'nope'), { code: 'project/branch-not-found' });
  await assert.rejects(files.read(project, '../etc/passwd'), { code: 'project/file-not-found' });
  await assert.rejects(files.read(project, '.git/config'), { code: 'project/file-not-found' });
});

test('a snapshot containing a symlink is refused as a whole', async () => {
  const { files, project } = snapshotOf((repo) => symlinkSync('/etc', join(repo, '.git', 'escape')));
  await assert.rejects(files.tree(project), { code: 'project/files-unavailable' });
});

test('project paths reject traversal, absolute paths and git internals', () => {
  for (const bad of ['', '/etc/passwd', 'a/../b', '.git/HEAD', 'a//b', 'a\\b', 'x\u0000']) assert.equal(isProjectPath(bad), false, bad);
  assert.equal(isProjectPath('src/app.ts'), true);
});

test('saved changes list each commit and diff it against its parent, refusing unknown or malformed commits', async () => {
  const { files, project } = snapshotOf(() => {});
  const { commits } = await files.history(project);
  assert.ok(commits.length >= 1);
  assert.match(commits[0]!.sha, /^[0-9a-f]{40,64}$/);
  const changes = await files.changes(project, commits[0]!.sha);
  assert.ok(changes.files.length > 0);
  assert.ok(changes.files.every((file) => !file.path.startsWith('.git')));
  assert.match(changes.patch, /^diff --git /m);
  for (const bad of ['a'.repeat(40), '../HEAD', 'HEAD', '--output=/tmp/x']) {
    await assert.rejects(files.changes(project, bad), { code: 'project/commit-not-found' }, bad);
  }
});

test('the saved version downloads as a zip of the branch, without git internals', async () => {
  const { files, project } = snapshotOf(() => {});
  const zip = await files.archive(project);
  assert.equal(zip.subarray(0, 2).toString('latin1'), 'PK');
  assert.ok(zip.includes(Buffer.from('index.html')));
  assert.ok(!zip.includes(Buffer.from('feature.md')));
  assert.ok((await files.archive(project, 'feature')).includes(Buffer.from('feature.md')));
  await assert.rejects(files.archive(project, 'nope'), { code: 'project/branch-not-found' });
});
