import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectFilesScript } from '../src/sandboxes/project-files.ts';

test('the sandbox helper has valid Python syntax', () => {
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-I', '-c', 'import sys; compile(sys.stdin.read(), "helper", "exec")'], { input: projectFilesScript, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('Linux file operations reject path, symlink, hardlink and Git-internal escapes', { skip: process.platform !== 'linux' && 'Requires Linux descriptor-relative filesystem APIs used by E2B' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lotusbuild-path-'));
  const root = join(dir, 'project');
  await mkdir(root);
  const run = (op: string, path: string, extra = {}) => spawnSync('python3', ['-I', '-c', projectFilesScript], {
    env: { ...process.env, LOTUSBUILD_FILE_REQUEST: JSON.stringify({ root, op, path, budget: 4096, ...extra }) }, encoding: 'utf8', timeout: 10000,
  });
  try {
    await writeFile(join(dir, 'secret'), 'outside');
    await writeFile(join(root, 'safe.txt'), 'hello😀world');
    await symlink(join(dir, 'secret'), join(root, 'symlink'));
    await symlink(dir, join(root, 'external-dir'));
    await link(join(dir, 'secret'), join(root, 'hardlink'));
    await mkdir(join(root, '.git'));
    await writeFile(join(root, '.git', 'config'), 'private');
    assert.equal(JSON.parse(run('read', join(root, 'safe.txt')).stdout).text, 'hello😀world');
    for (const path of [join(dir, 'secret'), root + '/../secret', join(root, 'symlink'), join(root, 'external-dir', 'secret'), join(root, 'hardlink'), join(root, '.git', 'config')]) {
      assert.notEqual(run('read', path).status, 0, path);
      assert.notEqual(run('write', path, { data: Buffer.from('overwrite').toString('base64') }).status, 0, path);
    }
    const ranged = run('range', join(root, 'safe.txt'), { offset: 5, limit: 2 });
    assert.equal(ranged.status, 0, ranged.stderr);
    assert.deepEqual(JSON.parse(ranged.stdout), { text: 'o😀w', start: 4, total: 12 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
