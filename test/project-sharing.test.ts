import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Timestamp } from 'firebase-admin/firestore';

import { ProjectFiles, isProjectPath, snapshotMembers, type ProjectFilesOptions } from '../src/projects/files.ts';
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

function snapshotOf(build: (repo: string) => void, options: Partial<ProjectFilesOptions> = {}) {
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
  const files = new ProjectFiles({ readUrl: async () => 'https://storage.invalid/snap' }, async () => new Response(archive), options);
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

test('a snapshot containing a symlink or hardlink is refused as a whole', async () => {
  const { files, project } = snapshotOf((repo) => symlinkSync('/etc', join(repo, '.git', 'escape')));
  await assert.rejects(files.tree(project), { code: 'project/files-unavailable' });
  const linked = snapshotOf((repo) => linkSync(join(repo, '.git', 'HEAD'), join(repo, '.git', 'HEAD2')));
  await assert.rejects(linked.files.tree(linked.project), { code: 'project/files-unavailable' });
});

/** Puts logging `git` and `tar` wrappers first on PATH so a test can see exactly which commands ran. */
async function withCommandLog<T>(body: (log: () => string[]) => Promise<T>): Promise<T> {
  const bin = mkdtempSync(join(tmpdir(), 'lb-bin-'));
  const logFile = join(bin, 'log');
  writeFileSync(logFile, '');
  for (const tool of ['git', 'tar']) {
    const real = execFileSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim();
    writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> '${logFile}'\nexec '${real}' "$@"\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  const path = process.env['PATH'];
  process.env['PATH'] = `${bin}:${path}`;
  try {
    return await body(() => readFileSync(logFile, 'utf8').split('\n').filter(Boolean));
  } finally {
    process.env['PATH'] = path;
    rmSync(bin, { recursive: true, force: true });
  }
}

function plantSmudgeFilter(repo: string, gitDir: string, marker: string, infoAttributes = true) {
  writeFileSync(join(gitDir, 'config'), `[core]\n\trepositoryformatversion = 0\n[filter "x"]\n\tsmudge = touch ${marker}; cat\n\tclean = cat\n`);
  if (infoAttributes) {
    mkdirSync(join(gitDir, 'info'), { recursive: true });
    writeFileSync(join(gitDir, 'info', 'attributes'), '* filter=x\n');
  }
  writeFileSync(join(repo, '.gitattributes'), '* filter=x\n');
}

test('a snapshot that redirects git through commondir to a smudge filter is refused before git runs', async () => {
  const marker = join(mkdtempSync(join(tmpdir(), 'lb-marker-')), 'pwned');
  const { files, project } = snapshotOf((repo) => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    writeFileSync(join(repo, '.gitattributes'), '* filter=x\n');
    git('add', '.gitattributes'); git('commit', '-q', '-m', 'attributes');
    mkdirSync(join(repo, '.git', 'cd'));
    plantSmudgeFilter(repo, join(repo, '.git', 'cd'), marker);
    writeFileSync(join(repo, '.git', 'commondir'), 'cd\n');
  });
  await withCommandLog(async (log) => {
    await assert.rejects(files.tree(project), { code: 'project/files-unavailable' });
    await assert.rejects(files.archive(project), { code: 'project/files-unavailable' });
    assert.ok(!log().some((line) => line.startsWith('git ')), log().join('\n'));
    assert.ok(!log().some((line) => line.startsWith('tar -x')), log().join('\n'));
  });
  assert.equal(existsSync(marker), false);
  for (const planted of ['gitdir', 'config.worktree', 'info/attributes', 'objects/info/alternates', 'worktrees/w/HEAD']) {
    const line = `-rw-r--r-- 0/0 1 2026-01-01 00:00:00 .git/${planted}`;
    assert.throws(() => snapshotMembers(`${line}\n-rw-r--r-- 0/0 1 2026-01-01 00:00:00 .git/HEAD\n`, { maxBytes: 1e9, maxMembers: 10 }), { code: 'project/files-unavailable' }, planted);
  }
});

test('filters and attributes written into the snapshot never run, and the zip holds the raw saved blobs', async () => {
  const marker = join(mkdtempSync(join(tmpdir(), 'lb-marker-')), 'pwned');
  const { files, project } = snapshotOf((repo) => {
    execFileSync('chmod', ['+x', join(repo, 'index.html')]);
    execFileSync('git', ['add', 'index.html'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'exec'], { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    execFileSync('git', ['gc', '-q'], { cwd: repo });
    plantSmudgeFilter(repo, join(repo, '.git'), marker, false);
    execFileSync('git', ['add', '.gitattributes'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'attributes'], { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  });
  rmSync(marker, { force: true });
  const zip = await withCommandLog(async (log) => {
    const out = await files.archive(project);
    assert.ok(!log().some((line) => / archive /.test(` ${line} `)), log().join('\n'));
    return out;
  });
  assert.equal(existsSync(marker), false);
  const dir = mkdtempSync(join(tmpdir(), 'lb-zip-'));
  try {
    writeFileSync(join(dir, 'out.zip'), zip);
    const listing = JSON.parse(execFileSync('python3', ['-I', '-c', [
      'import json, sys, zipfile',
      'z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None',
      'print(json.dumps({i.filename: [z.read(i).hex(), i.external_attr >> 16] for i in z.infolist()}))',
    ].join('\n'), join(dir, 'out.zip')], { encoding: 'utf8' })) as Record<string, [string, number]>;
    assert.deepEqual(Object.keys(listing).sort(), ['.gitattributes', 'index.html', 'logo.bin', 'src/app.ts']);
    assert.equal(Buffer.from(listing['src/app.ts']![0], 'hex').toString('utf8'), 'export const ok = true;\n');
    assert.equal(listing['logo.bin']![0], '00010203');
    assert.equal(listing['index.html']![1], 0o100755);
    assert.equal(listing['src/app.ts']![1], 0o100644);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a snapshot whose unpacked size or member count exceeds the cap is refused before anything is extracted', async () => {
  const big = (repo: string) => writeFileSync(join(repo, '.git', 'objects', 'pack', `pack-${'a'.repeat(40)}.pack`), Buffer.alloc(4 * 1024 * 1024));
  const { files, project } = snapshotOf(big, { maxUnpackedBytes: 1024 * 1024 });
  await withCommandLog(async (log) => {
    await assert.rejects(files.tree(project), { code: 'project/files-unavailable' });
    assert.ok(log().some((line) => line.startsWith('tar -tvzf')), log().join('\n'));
    assert.ok(!log().some((line) => line.startsWith('tar -x')), log().join('\n'));
    assert.ok(!log().some((line) => line.startsWith('git ')), log().join('\n'));
  });
  const many = snapshotOf(() => {}, { maxArchiveMembers: 5 });
  await assert.rejects(many.files.tree(many.project), { code: 'project/files-unavailable' });
  const ok = snapshotOf(big, { maxUnpackedBytes: 64 * 1024 * 1024 });
  assert.equal((await ok.files.tree(ok.project)).head, 'main');
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
