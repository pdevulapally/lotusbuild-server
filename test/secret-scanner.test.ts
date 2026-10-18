import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const section = workflow.split('      - name: Verify no secret is committed')[1]?.split('\n      - name:')[0];
assert.ok(section);
const script = section.slice(section.indexOf('        run: |') + '        run: |'.length)
  .split(/\r?\n/).map((line) => line.replace(/^          /, '')).join('\n');

function fixture(t: TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), 'lotus-secret-scanner-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', cwd]);
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd });
  mkdirSync(join(cwd, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(cwd, '.github', 'workflows', 'ci.yml'), workflow);
  const track = () => execFileSync('git', ['add', '--all'], { cwd });
  const run = (prefix = '') => spawnSync('bash', ['-c', prefix + script], { cwd, encoding: 'utf8', timeout: 15000 });
  return { cwd, track, run };
}

test('actual workflow scanner passes clean files including its own definition', (t) => {
  const h = fixture(t); h.track();
  const syntax = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
  assert.equal(syntax.status, 0);
  const result = h.run();
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes('No tracked secrets.'));
});

for (const path of ['credential.txt', '.github/settings.yml', '.github/workflows/extra.yml', '.github/workflows/ci.yml', '.env.example']) {
  test(`actual workflow scanner detects content safely in ${path}`, (t) => {
    const h = fixture(t);
    const fake = ['sk', 'live', 'SYNTHETIC_CREDENTIAL_ONLY'].join('_');
    writeFileSync(join(h.cwd, path), `credential: ${fake}\n`, { flag: 'a' }); h.track();
    const result = h.run();
    assert.equal(result.status, 1);
    assert.ok(result.stdout.includes('credential-shaped string'));
    assert.equal((result.stdout + result.stderr).includes(fake), false, 'Scanner exposed matching content');
  });
}

test('actual workflow scanner rejects credential-shaped filenames without printing file content', (t) => {
  const h = fixture(t);
  writeFileSync(join(h.cwd, '.env.production'), 'SYNTHETIC_PRIVATE_VALUE'); h.track();
  const result = h.run();
  assert.equal(result.status, 1);
  assert.ok(result.stdout.includes('credential-shaped file'));
  assert.equal((result.stdout + result.stderr).includes('SYNTHETIC_PRIVATE_VALUE'), false);
});

test('actual workflow scanner allows the root .env.example template', (t) => {
  const h = fixture(t);
  writeFileSync(join(h.cwd, '.env.example'), 'EMAIL_DAILY_SEND_LIMIT=300\n'); h.track();
  const result = h.run();
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes('No tracked secrets.'));
});

for (const stage of ['enumeration', 'filename', 'content']) {
  test(`actual workflow scanner fails closed on ${stage} execution failure without exposing stderr`, (t) => {
    const h = fixture(t); h.track();
    const prefix = stage === 'filename'
      ? "grep() { echo 'SYNTHETIC_ERROR_SECRET' >&2; return 2; };\n"
      : `git() { if [[ "$1" == "${stage === 'enumeration' ? 'ls-files' : 'grep'}" ]]; then echo 'SYNTHETIC_ERROR_SECRET' >&2; return 2; fi; command git "$@"; };\n`;
    const result = h.run(prefix);
    assert.equal(result.status, 2);
    assert.ok(result.stdout.includes('Secret scanner') && result.stdout.includes('failed'));
    assert.equal((result.stdout + result.stderr).includes('SYNTHETIC_ERROR_SECRET'), false);
  });
}
