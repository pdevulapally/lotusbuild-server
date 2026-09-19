import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { releaseRevision } from '../src/release.ts';

function releaseWith(contents: string | undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'release-'));
  if (contents !== undefined) writeFileSync(join(dir, 'release.json'), contents);
  return { root: pathToFileURL(dir + '/'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the revision is read from release.json', (t) => {
  const revision = 'b'.repeat(40);
  const release = releaseWith(JSON.stringify({ revision, platform: 'linux' }));
  t.after(release.cleanup);
  assert.equal(releaseRevision(release.root), revision);
});

test('no release.json means nothing packaged this tree', (t) => {
  const release = releaseWith(undefined);
  t.after(release.cleanup);
  assert.equal(releaseRevision(release.root), undefined);
});

test('a release.json that is present but unusable throws rather than reporting a revision', (t) => {
  for (const contents of ['not json', '[]', '{}', JSON.stringify({ revision: 'main' }), JSON.stringify({ revision: 'A'.repeat(40) }),
    JSON.stringify({ revision: 'a'.repeat(40), pad: 'x'.repeat(5000) })]) {
    const release = releaseWith(contents);
    t.after(release.cleanup);
    assert.throws(() => releaseRevision(release.root), Error, contents.slice(0, 30));
  }
});
