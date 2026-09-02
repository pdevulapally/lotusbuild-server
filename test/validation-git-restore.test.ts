import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  validationCheckpointScript,
  validationRestoreScript,
} from '../src/runner/tools.ts';

/**
 * Proves the real checkpoint/restore scripts against the system git binary in a
 * throwaway repository. The content-only fake in agent-specialists.test.ts
 * cannot express an index or HEAD, so git semantics — staged/unstaged state,
 * deletions, HEAD identity — are proven here and nowhere else.
 */

const repos: string[] = [];
after(() => {
  for (const repo of repos) {
    rmSync(repo, { recursive: true, force: true });
  }
});

/** Runs a shell script in the repo and returns stdout, throwing on failure. */
function sh(cwd: string, script: string, envs: Record<string, string> = {}): string {
  return execFileSync('bash', ['-c', script], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...envs },
  });
}

function git(cwd: string, args: string): string {
  return sh(cwd, `git ${args}`);
}

/** A fresh repo with one committed file, on a known branch, git identity set. */
function newRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'lotus-git-'));
  repos.push(repo);
  git(repo, 'init -q -b main');
  git(repo, 'config user.email test@lotusbuild.invalid');
  git(repo, 'config user.name Test');
  git(repo, 'config commit.gpgsign false');
  writeFileSync(join(repo, 'tracked.txt'), 'original\n');
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\ncoverage/\n');
  git(repo, 'add -A');
  git(repo, 'commit -q -m initial');
  return repo;
}

function status(repo: string): string {
  return git(repo, 'status --porcelain').replace(/\n$/, '');
}

/** Runs checkpoint, a validation body, then restore. Returns the restore output. */
function checkpointValidateRestore(repo: string, validate: () => void): string {
  const checkpoint = sh(repo, validationCheckpointScript);
  const fields = new Map<string, string>();
  for (const line of checkpoint.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) {
      fields.set(line.slice(0, eq), line.slice(eq + 1).trim());
    }
  }
  validate();
  return sh(repo, validationRestoreScript, {
    LOTUSBUILD_INDEX_TREE: fields.get('index_tree') ?? '',
    LOTUSBUILD_WORKING_TREE: fields.get('working_tree') ?? '',
    LOTUSBUILD_HEAD_REF: fields.get('head_ref') ?? '',
    LOTUSBUILD_HEAD_COMMIT: fields.get('head_commit') ?? '',
  });
}

function assertVerified(restoreOutput: string): void {
  assert.match(restoreOutput, /verified=1/, `expected verified=1, got:\n${restoreOutput}`);
}

test('a staged tracked modification stays staged', async () => {
  const repo = newRepo();
  writeFileSync(join(repo, 'tracked.txt'), 'staged change\n');
  git(repo, 'add tracked.txt');
  const before = status(repo);
  assert.equal(before, 'M  tracked.txt');

  const out = checkpointValidateRestore(repo, () => {
    writeFileSync(join(repo, 'tracked.txt'), 'validation stomped it\n');
  });

  assertVerified(out);
  assert.equal(status(repo), before);
  assert.equal(git(repo, 'diff --cached --name-only').trim(), 'tracked.txt');
});

test('an unstaged tracked modification stays unstaged', async () => {
  const repo = newRepo();
  writeFileSync(join(repo, 'tracked.txt'), 'unstaged change\n');
  const before = status(repo);
  assert.equal(before, ' M tracked.txt');

  const out = checkpointValidateRestore(repo, () => {
    git(repo, 'add -A'); // validation stages it — the exact forbidden transform
  });

  assertVerified(out);
  assert.equal(status(repo), before);
  // Still unstaged, not promoted to staged.
  assert.equal(git(repo, 'diff --cached --name-only').trim(), '');
});

test('an untracked file stays untracked', async () => {
  const repo = newRepo();
  writeFileSync(join(repo, 'untracked.txt'), 'new work\n');
  const before = status(repo);
  assert.equal(before, '?? untracked.txt');

  const out = checkpointValidateRestore(repo, () => {
    git(repo, 'add -A'); // validation stages the untracked file
  });

  assertVerified(out);
  assert.equal(status(repo), before);
});

test('an unstaged deletion stays an unstaged deletion', async () => {
  const repo = newRepo();
  rmSync(join(repo, 'tracked.txt'));
  const before = status(repo);
  assert.equal(before, ' D tracked.txt');

  const out = checkpointValidateRestore(repo, () => {
    git(repo, 'checkout -- tracked.txt'); // validation "restores" it
  });

  assertVerified(out);
  assert.equal(status(repo), before);
});

test('a staged deletion stays a staged deletion', async () => {
  const repo = newRepo();
  git(repo, 'rm -q tracked.txt');
  const before = status(repo);
  assert.equal(before, 'D  tracked.txt');

  const out = checkpointValidateRestore(repo, () => {
    writeFileSync(join(repo, 'tracked.txt'), 'validation recreated it\n');
    git(repo, 'add -A');
  });

  assertVerified(out);
  assert.equal(status(repo), before);
});

test('a mixed staged/unstaged/untracked/deletion state is reproduced exactly', async () => {
  const repo = newRepo();
  writeFileSync(join(repo, 'staged.txt'), 'a\n');
  writeFileSync(join(repo, 'unstaged.txt'), 'b\n');
  writeFileSync(join(repo, 'todelete.txt'), 'c\n');
  git(repo, 'add -A');
  git(repo, 'commit -q -m setup');
  // staged modification
  writeFileSync(join(repo, 'staged.txt'), 'a-staged\n');
  git(repo, 'add staged.txt');
  // unstaged modification
  writeFileSync(join(repo, 'unstaged.txt'), 'b-unstaged\n');
  // untracked
  writeFileSync(join(repo, 'new.txt'), 'd\n');
  // unstaged deletion
  rmSync(join(repo, 'todelete.txt'));
  const before = status(repo);

  const out = checkpointValidateRestore(repo, () => {
    // Validation runs riot across the index and files.
    git(repo, 'add -A');
    writeFileSync(join(repo, 'staged.txt'), 'trashed\n');
    writeFileSync(join(repo, 'extra.txt'), 'garbage\n');
  });

  assertVerified(out);
  assert.equal(status(repo), before);
});

test('validation running git add -A leaves the original staging fully restored', async () => {
  const repo = newRepo();
  writeFileSync(join(repo, 'tracked.txt'), 'unstaged\n');
  writeFileSync(join(repo, 'fresh.txt'), 'untracked\n');
  const before = status(repo);

  const out = checkpointValidateRestore(repo, () => git(repo, 'add -A'));

  assertVerified(out);
  assert.equal(status(repo), before);
});

test('validation running git reset leaves the original staging restored', async () => {
  const repo = newRepo();
  writeFileSync(join(repo, 'tracked.txt'), 'staged\n');
  git(repo, 'add tracked.txt');
  const before = status(repo);

  const out = checkpointValidateRestore(repo, () => git(repo, 'reset -q'));

  assertVerified(out);
  assert.equal(status(repo), before);
});

test('validation creating a commit does not move the original HEAD', async () => {
  const repo = newRepo();
  const before = git(repo, 'rev-parse HEAD').trim();

  const out = checkpointValidateRestore(repo, () => {
    writeFileSync(join(repo, 'rogue.txt'), 'from validation\n');
    git(repo, 'add -A');
    git(repo, 'commit -q -m "rogue validation commit"');
  });

  assertVerified(out);
  assert.equal(git(repo, 'rev-parse HEAD').trim(), before);
  assert.equal(git(repo, 'symbolic-ref HEAD').trim(), 'refs/heads/main');
  // The rogue commit's file is gone and the branch is back where it was.
  assert.equal(status(repo), '');
});

test('validation checking out another branch restores the original branch and HEAD', async () => {
  const repo = newRepo();
  git(repo, 'branch other');
  const beforeRef = git(repo, 'symbolic-ref HEAD').trim();
  const beforeCommit = git(repo, 'rev-parse HEAD').trim();

  const out = checkpointValidateRestore(repo, () => {
    git(repo, 'checkout -q other');
    writeFileSync(join(repo, 'tracked.txt'), 'changed on other\n');
    git(repo, 'add -A');
    git(repo, 'commit -q -m "on other branch"');
  });

  assertVerified(out);
  assert.equal(git(repo, 'symbolic-ref HEAD').trim(), beforeRef);
  assert.equal(git(repo, 'rev-parse HEAD').trim(), beforeCommit);
});

test('a detached HEAD stays detached at the exact original commit', async () => {
  const repo = newRepo();
  writeFileSync(join(repo, 'tracked.txt'), 'second\n');
  git(repo, 'add -A');
  git(repo, 'commit -q -m second');
  const first = git(repo, 'rev-parse HEAD~1').trim();
  git(repo, `checkout -q ${first}`); // detach
  assert.equal(sh(repo, 'git symbolic-ref -q HEAD || echo DETACHED').trim(), 'DETACHED');

  const out = checkpointValidateRestore(repo, () => {
    git(repo, 'checkout -q main'); // validation attaches to a branch
  });

  assertVerified(out);
  assert.equal(sh(repo, 'git symbolic-ref -q HEAD || echo DETACHED').trim(), 'DETACHED');
  assert.equal(git(repo, 'rev-parse HEAD').trim(), first);
});

test('validation mutating HEAD, index and files together is fully restored', async () => {
  const repo = newRepo();
  writeFileSync(join(repo, 'tracked.txt'), 'staged edit\n');
  git(repo, 'add tracked.txt');
  writeFileSync(join(repo, 'untracked.txt'), 'mine\n');
  const beforeStatus = status(repo);
  const beforeHead = git(repo, 'rev-parse HEAD').trim();

  const out = checkpointValidateRestore(repo, () => {
    git(repo, 'add -A');
    git(repo, 'commit -q -m "everything at once"');
    writeFileSync(join(repo, 'tracked.txt'), 'and more\n');
    writeFileSync(join(repo, 'extra.txt'), 'junk\n');
  });

  assertVerified(out);
  assert.equal(status(repo), beforeStatus);
  assert.equal(git(repo, 'rev-parse HEAD').trim(), beforeHead);
});

test('validation-created non-ignored files are removed by restoration', async () => {
  const repo = newRepo();
  const before = status(repo);

  const out = checkpointValidateRestore(repo, () => {
    writeFileSync(join(repo, 'snapshot.snap'), 'created\n');
    mkdirSync(join(repo, 'out'));
    writeFileSync(join(repo, 'out', 'built.js'), 'compiled\n');
  });

  assertVerified(out);
  assert.match(out, /mutated=1/);
  assert.equal(status(repo), before);
});

test('pre-existing ignored dependency files survive restoration', async () => {
  const repo = newRepo();
  mkdirSync(join(repo, 'node_modules'));
  writeFileSync(join(repo, 'node_modules', 'dep.js'), 'installed\n');
  const before = status(repo); // ignored, so status is clean

  const out = checkpointValidateRestore(repo, () => {
    // validation writes more into the ignored tree
    writeFileSync(join(repo, 'node_modules', 'more.js'), 'from validation\n');
  });

  assertVerified(out);
  assert.equal(status(repo), before);
  // clean -fd (no -x) must not have deleted the dependency directory.
  assert.equal(sh(repo, 'cat node_modules/dep.js').trim(), 'installed');
});

/** Parses a checkpoint into an env object, letting a test corrupt one field. */
function checkpointEnv(repo: string, overrides: Record<string, string> = {}): Record<string, string> {
  const checkpoint = sh(repo, validationCheckpointScript);
  const fields = new Map<string, string>();
  for (const line of checkpoint.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) {
      fields.set(line.slice(0, eq), line.slice(eq + 1).trim());
    }
  }
  return {
    LOTUSBUILD_INDEX_TREE: fields.get('index_tree') ?? '',
    LOTUSBUILD_WORKING_TREE: fields.get('working_tree') ?? '',
    LOTUSBUILD_HEAD_REF: fields.get('head_ref') ?? '',
    LOTUSBUILD_HEAD_COMMIT: fields.get('head_commit') ?? '',
    ...overrides,
  };
}

// The verification is a mirror of the restore against the same checkpoint
// values, so a self-consistent but "wrong" set still verifies — the axis that
// verification genuinely guards is a checkpoint that cannot be applied at all.
// Each of these feeds an unusable object and asserts restoration fails closed
// (a non-zero exit, which the tool turns into an explicit restore failure)
// rather than silently reporting the workspace as safe. The verified=0 path
// itself — a restore that ran but did not match — is exercised at the tool
// level in agent-specialists.test.ts via the fake's breakVerify.
const bogusOid = '0000000000000000000000000000000000000001';

test('an unusable checkpoint index tree makes restoration fail closed, not silently proceed', () => {
  const repo = newRepo();
  writeFileSync(join(repo, 'tracked.txt'), 'staged\n');
  git(repo, 'add tracked.txt');
  assert.throws(() =>
    sh(repo, validationRestoreScript, checkpointEnv(repo, { LOTUSBUILD_INDEX_TREE: bogusOid })),
  );
});

test('an unusable checkpoint HEAD commit makes restoration fail closed', () => {
  const repo = newRepo();
  assert.throws(() =>
    sh(repo, validationRestoreScript, checkpointEnv(repo, { LOTUSBUILD_HEAD_COMMIT: bogusOid })),
  );
});

test('an unusable checkpoint working tree makes restoration fail closed', () => {
  const repo = newRepo();
  assert.throws(() =>
    sh(repo, validationRestoreScript, checkpointEnv(repo, { LOTUSBUILD_WORKING_TREE: bogusOid })),
  );
});
