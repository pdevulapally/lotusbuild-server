import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import type { SandboxProvider } from '../src/entitlements/schema.ts';
import type { CommandOutcome, RunningSandbox } from '../src/sandboxes/provider.ts';
import {
  type ToolContext,
  readOnlyTools,
  runTool,
  searchOverFilesScript,
  truncate,
  workspaceTools,
} from '../src/runner/tools.ts';

/**
 * Proves `list_files` and `search_files` against real `git`, `find` and
 * `grep` in a throwaway repository — the same reasoning as
 * validation-git-restore.test.ts: the correctness that matters here lives in
 * shell/Git behaviour a content-only fake cannot express.
 *
 * Path plumbing, test-only: `resolveInWorkdir` does pure POSIX string math
 * (`node:path`'s `posix`), so it only treats a path as absolute if it starts
 * with "/". A Windows temp directory does not. `toMsysPath` turns
 * `C:\Users\...\x` into `/c/Users/.../x`, which both `posix.resolve` accepts
 * as absolute AND Git Bash's own `cd` accepts natively (MSYS's own path
 * form) — confirmed empirically before writing this file. `execFileSync`'s
 * `cwd` option, by contrast, is a Windows API and does NOT accept that form,
 * so `RealSandbox` never passes one; every script instead starts with its own
 * `cd "<root>"`, exactly mirroring how the tools under test already `cd` via
 * `LOTUSBUILD_SCOPE_PATH`. None of this exists on the real runtime: E2B's
 * sandbox is Linux, where `provider.workdir` is already a real POSIX path
 * and this whole conversion is unnecessary.
 */
function toMsysPath(windowsPath: string): string {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(windowsPath);
  if (match === null) {
    throw new Error(`not an absolute Windows path: ${windowsPath}`);
  }
  const drive = match[1];
  const rest = match[2];
  if (drive === undefined || rest === undefined) {
    throw new Error(`unreachable: the regex above guarantees both groups`);
  }
  return `/${drive.toLowerCase()}/${rest.replace(/\\/g, '/')}`;
}

class RealSandbox implements RunningSandbox {
  readonly externalId = 'real-sandbox';

  async runCommand(
    command: string,
    options: { readonly cwd: string; readonly timeoutMs: number; readonly envs?: Readonly<Record<string, string>> },
  ): Promise<CommandOutcome> {
    const script = `cd "${options.cwd}"\n${command}`;
    try {
      const stdout = execFileSync('bash', ['-c', script], {
        encoding: 'utf8',
        timeout: options.timeoutMs,
        env: { ...process.env, ...options.envs },
        maxBuffer: 64 * 1024 * 1024,
      });
      return { exitCode: 0, stdout, stderr: '' };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return { exitCode: failure.status ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    writeFileSync(path, content, 'utf8');
  }

  async readFile(path: string): Promise<string> {
    return execFileSync('cat', [path], { encoding: 'utf8' });
  }

  previewUrl(): string {
    return 'https://preview.invalid';
  }

  async stop(): Promise<void> {}
}

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function sh(root: string, script: string): void {
  execFileSync('bash', ['-c', `cd "${root}"\n${script}`], { encoding: 'utf8' });
}

/** A fresh Git repository: one tracked file, node_modules and ignored.txt gitignored. */
function newGitRepo(): string {
  const root = toMsysPath(mkdtempSync(join(tmpdir(), 'lotus-nav-')));
  roots.push(root.replace(/^\/([a-z])\//, '$1:/'));
  sh(
    root,
    [
      'git init -q -b main',
      'git config user.email t@t.invalid',
      'git config user.name T',
      'git config commit.gpgsign false',
      'printf "node_modules/\\nignored.txt\\n" > .gitignore',
      'mkdir -p src node_modules',
      'printf "const tracked = 1;\\n" > src/tracked.ts',
      'git add -A',
      'git commit -q -m init',
    ].join('\n'),
  );
  return root;
}

/** A plain directory that is never `git init`'d. */
function newPlainDir(): string {
  const root = toMsysPath(mkdtempSync(join(tmpdir(), 'lotus-nav-plain-')));
  roots.push(root.replace(/^\/([a-z])\//, '$1:/'));
  mkdirSync(join(root.replace(/^\/([a-z])\//, '$1:/'), 'src'), { recursive: true });
  return root;
}

const provider = (root: string): SandboxProvider => ({
  platform: 'web',
  provider: 'e2b',
  template: 'test-template',
  timeoutSeconds: 60,
  memoryMb: 512,
  cpus: 1,
  concurrencyMeterKey: 'sandbox.concurrent.web',
  workdir: root,
  idleGraceSeconds: 5,
  agentInstructions: 'build the thing',
  validationProfiles: new Map(),
});

function contextOf(root: string, toolOutputMaxChars = 20000): ToolContext {
  return {
    sandbox: new RealSandbox(),
    provider: provider(root),
    commandTimeoutMs: 15000,
    previewReadyTimeoutSeconds: 5,
    toolOutputMaxChars,
    onPreview: async () => {},
  };
}

/** Splits a list_files/search_files page into its metadata line and its entries. */
function parsePage(text: string): {
  readonly start: number;
  readonly end: number;
  readonly total: number;
  readonly hasMore: boolean;
  readonly lines: readonly string[];
} {
  const lines = text.split('\n');
  const meta = lines[0];
  const separator = lines[1];
  assert.equal(separator, '---');
  const match = /(?:entries|matches) (\d+)-(\d+) of (\d+) \(has_more: (true|false)\)$/.exec(meta ?? '');
  assert.ok(match, `unexpected page metadata line: ${meta}`);
  const [, start, end, total, hasMore] = match;
  const rest = lines.slice(2);
  // A zero-entry page renders as just the header and separator, with nothing
  // after — split('\n') on that leaves one trailing empty string to drop.
  const body = rest.length === 1 && rest[0] === '' ? [] : rest;
  return {
    start: Number(start),
    end: Number(end),
    total: Number(total),
    hasMore: hasMore === 'true',
    lines: body,
  };
}

// ---------------------------------------------------------------------------
// list_files
// ---------------------------------------------------------------------------

test('list_files: tracked files are included', async () => {
  const root = newGitRepo();
  const result = await runTool('list_files', {}, contextOf(root), workspaceTools);
  assert.equal(result.isError, false);
  assert.ok(parsePage(result.text).lines.includes('src/tracked.ts'));
});

test('list_files: untracked non-ignored files are included', async () => {
  const root = newGitRepo();
  sh(root, 'printf "x\\n" > src/untracked.ts');
  const result = await runTool('list_files', {}, contextOf(root), workspaceTools);
  assert.ok(parsePage(result.text).lines.includes('src/untracked.ts'));
});

test('list_files: ignored files and node_modules are excluded', async () => {
  const root = newGitRepo();
  sh(root, 'printf "x\\n" > ignored.txt\nprintf "x\\n" > node_modules/pkg.js');
  const result = await runTool('list_files', {}, contextOf(root), workspaceTools);
  const lines = parsePage(result.text).lines;
  assert.equal(lines.includes('ignored.txt'), false);
  assert.equal(lines.includes('node_modules/pkg.js'), false);
});

test('list_files: path scopes the listing to a subdirectory', async () => {
  const root = newGitRepo();
  sh(root, 'mkdir -p other && printf "x\\n" > other/o.ts');
  const result = await runTool('list_files', { path: 'src' }, contextOf(root), workspaceTools);
  const lines = parsePage(result.text).lines;
  assert.deepEqual(lines, ['tracked.ts']);
});

test('list_files: glob restricts results to a Git pathspec', async () => {
  const root = newGitRepo();
  sh(root, 'printf "x\\n" > src/other.md');
  const result = await runTool('list_files', { glob: '*.ts' }, contextOf(root), workspaceTools);
  const lines = parsePage(result.text).lines;
  assert.deepEqual(lines, ['src/tracked.ts']);
});

test('list_files: glob is rejected explicitly outside a Git working tree', async () => {
  const root = newPlainDir();
  const result = await runTool('list_files', { glob: '*.ts' }, contextOf(root), workspaceTools);
  assert.equal(result.isError, true);
  assert.match(result.text, /requires the project to be a Git working tree/);
});

test('list_files: outside a Git working tree, every regular file is listed', async () => {
  const root = newPlainDir();
  sh(root, 'printf "x\\n" > src/plain.ts\nprintf "y\\n" > top.txt');
  const result = await runTool('list_files', {}, contextOf(root), workspaceTools);
  const lines = parsePage(result.text).lines;
  assert.deepEqual([...lines].sort(), ['src/plain.ts', 'top.txt']);
});

test('list_files: ordering is deterministic', async () => {
  const root = newGitRepo();
  sh(root, 'printf "x\\n" > src/z.ts\nprintf "x\\n" > src/a.ts\nprintf "x\\n" > src/m.ts');
  const first = parsePage((await runTool('list_files', {}, contextOf(root), workspaceTools)).text).lines;
  const second = parsePage((await runTool('list_files', {}, contextOf(root), workspaceTools)).text).lines;
  assert.deepEqual(first, second);
  const sorted = [...first].sort();
  assert.deepEqual(first, sorted);
});

test('list_files: first, middle and final pages are consistent', async () => {
  const root = newGitRepo();
  for (let i = 0; i < 9; i += 1) {
    sh(root, `printf "x\\n" > src/f${String(i).padStart(2, '0')}.ts`);
  }
  const ctx = contextOf(root);
  const first = parsePage((await runTool('list_files', { offset: 0, limit: 4 }, ctx, workspaceTools)).text);
  assert.equal(first.hasMore, true);
  assert.equal(first.lines.length, 4);
  const middle = parsePage(
    (await runTool('list_files', { offset: first.end, limit: 4 }, ctx, workspaceTools)).text,
  );
  assert.equal(middle.start, first.end);
  const last = parsePage(
    (await runTool('list_files', { offset: middle.end, limit: 4 }, ctx, workspaceTools)).text,
  );
  assert.equal(last.hasMore, false);
  assert.equal(last.end, last.total);
});

test('list_files: offset exactly at the end returns an empty page', async () => {
  const root = newGitRepo();
  const ctx = contextOf(root);
  const total = parsePage((await runTool('list_files', {}, ctx, workspaceTools)).text).total;
  const result = await runTool('list_files', { offset: total }, ctx, workspaceTools);
  assert.equal(result.isError, false);
  const page = parsePage(result.text);
  assert.deepEqual(page.lines, []);
  assert.equal(page.hasMore, false);
});

test('list_files: offset beyond the end fails explicitly', async () => {
  const root = newGitRepo();
  const ctx = contextOf(root);
  const total = parsePage((await runTool('list_files', {}, ctx, workspaceTools)).text).total;
  const result = await runTool('list_files', { offset: total + 1 }, ctx, workspaceTools);
  assert.equal(result.isError, true);
  assert.match(result.text, /beyond the end/);
});

test('list_files: sequential pages reconstruct the full listing with no gaps or duplicates', async () => {
  const root = newGitRepo();
  for (let i = 0; i < 11; i += 1) {
    sh(root, `printf "x\\n" > src/g${String(i).padStart(2, '0')}.ts`);
  }
  const ctx = contextOf(root);
  const whole = parsePage((await runTool('list_files', { limit: 1000 }, ctx, workspaceTools)).text).lines;

  let offset = 0;
  let reconstructed: string[] = [];
  for (let guard = 0; guard < 50; guard += 1) {
    const page = parsePage((await runTool('list_files', { offset, limit: 3 }, ctx, workspaceTools)).text);
    reconstructed = reconstructed.concat([...page.lines]);
    if (!page.hasMore) {
      break;
    }
    offset = page.end;
  }
  assert.deepEqual(reconstructed, whole);
});

test('list_files: a page shrinks truthfully to fit a tight output budget', async () => {
  const root = newGitRepo();
  for (let i = 0; i < 20; i += 1) {
    sh(root, `printf "x\\n" > src/budget-file-${String(i).padStart(3, '0')}.ts`);
  }
  const ctx = contextOf(root, 400);
  const result = await runTool('list_files', { offset: 0, limit: 1000 }, ctx, workspaceTools);
  assert.equal(result.isError, false);
  assert.ok(result.text.length <= 400);
  const page = parsePage(result.text);
  assert.equal(page.hasMore, true);
  assert.equal(page.lines.length, page.end - page.start);
  // The generic outer truncation must be a no-op on what we already fit.
  assert.equal(truncate(result.text, 400), result.text);
});

// ---------------------------------------------------------------------------
// search_files
// ---------------------------------------------------------------------------

test('search_files: a unique literal match is found with its line number', async () => {
  const root = newGitRepo();
  sh(root, 'printf "line one\\nNEEDLE here\\nline three\\n" > src/needle.ts');
  const result = await runTool('search_files', { query: 'NEEDLE' }, contextOf(root), workspaceTools);
  assert.equal(result.isError, false);
  const page = parsePage(result.text);
  assert.deepEqual(page.lines, ['src/needle.ts:2: NEEDLE here']);
});

test('search_files: multiple matches within one file are all reported, in line order', async () => {
  const root = newGitRepo();
  sh(root, 'printf "NEEDLE a\\nno\\nNEEDLE b\\nNEEDLE c\\n" > src/multi.ts');
  const result = await runTool('search_files', { query: 'NEEDLE' }, contextOf(root), workspaceTools);
  const lines = parsePage(result.text).lines;
  assert.deepEqual(lines, [
    'src/multi.ts:1: NEEDLE a',
    'src/multi.ts:3: NEEDLE b',
    'src/multi.ts:4: NEEDLE c',
  ]);
});

test('search_files: matches across multiple files are ordered by path', async () => {
  const root = newGitRepo();
  sh(root, 'printf "NEEDLE\\n" > src/zzz.ts\nprintf "NEEDLE\\n" > src/aaa.ts');
  const result = await runTool('search_files', { query: 'NEEDLE' }, contextOf(root), workspaceTools);
  const lines = parsePage(result.text).lines;
  assert.deepEqual(lines, ['src/aaa.ts:1: NEEDLE', 'src/zzz.ts:1: NEEDLE']);
});

test('search_files: reads the current, unstaged content of a modified tracked file', async () => {
  const root = newGitRepo();
  // src/tracked.ts is already committed; modify it without staging.
  sh(root, 'printf "NEEDLE_UNSTAGED\\n" >> src/tracked.ts');
  const result = await runTool('search_files', { query: 'NEEDLE_UNSTAGED' }, contextOf(root), workspaceTools);
  assert.equal(result.isError, false);
  assert.deepEqual(parsePage(result.text).lines, ['src/tracked.ts:2: NEEDLE_UNSTAGED']);
});

test('search_files: reads current untracked content', async () => {
  const root = newGitRepo();
  sh(root, 'printf "NEEDLE_UNTRACKED\\n" > src/fresh.ts');
  const result = await runTool('search_files', { query: 'NEEDLE_UNTRACKED' }, contextOf(root), workspaceTools);
  assert.deepEqual(parsePage(result.text).lines, ['src/fresh.ts:1: NEEDLE_UNTRACKED']);
});

test('search_files: ignored files are excluded from the search', async () => {
  const root = newGitRepo();
  sh(root, 'printf "NEEDLE_IGNORED\\n" > ignored.txt\nprintf "NEEDLE_MODULE\\n" > node_modules/pkg.js');
  const result = await runTool('search_files', { query: 'NEEDLE' }, contextOf(root), workspaceTools);
  assert.equal(parsePage(result.text).total, 0);
});

test('search_files: a binary file is skipped, not dumped as content', async () => {
  const root = newGitRepo();
  sh(root, 'printf "bin\\000NEEDLE_BIN\\000here" > src/data.bin');
  const result = await runTool('search_files', { query: 'NEEDLE_BIN' }, contextOf(root), workspaceTools);
  assert.equal(result.isError, false);
  assert.equal(parsePage(result.text).total, 0);
});

test('search_files: symlink content is not read (best-effort on this platform)', async (t) => {
  const root = newGitRepo();
  const outsideWin = mkdtempSync(join(tmpdir(), 'lotus-nav-outside-'));
  roots.push(outsideWin);
  writeFileSync(join(outsideWin, 'secret.txt'), 'NEEDLE_OUTSIDE\n', 'utf8');
  const rootWin = root.replace(/^\/([a-z])\//, '$1:/');
  let created = true;
  try {
    symlinkSync(join(outsideWin, 'secret.txt'), join(rootWin, 'src', 'link.ts'), 'file');
  } catch {
    created = false;
  }
  if (!created) {
    // This dev machine cannot create real symlinks without elevated
    // privilege (confirmed: both `ln -s` under Git Bash and
    // fs.symlinkSync fail to produce anything `[ -L ]` detects here). The
    // real E2B sandbox is Linux, where symlink creation and detection are
    // both unrestricted and standard — this assertion is written to run
    // there; it skips only on this restricted dev environment.
    t.skip('this environment cannot create real symlinks (no privilege) — see comment above');
    return;
  }
  const result = await runTool('search_files', { query: 'NEEDLE_OUTSIDE' }, contextOf(root), workspaceTools);
  assert.equal(parsePage(result.text).total, 0);
});

test('search_files: path scopes the search to a subdirectory', async () => {
  const root = newGitRepo();
  sh(root, 'mkdir -p other && printf "NEEDLE\\n" > other/o.ts && printf "NEEDLE\\n" > src/tracked2.ts');
  const result = await runTool('search_files', { query: 'NEEDLE', path: 'src' }, contextOf(root), workspaceTools);
  const lines = parsePage(result.text).lines;
  assert.deepEqual(lines, ['tracked2.ts:1: NEEDLE']);
});

test('search_files: glob scopes the search to a Git pathspec', async () => {
  const root = newGitRepo();
  sh(root, 'printf "NEEDLE\\n" > src/tracked.md');
  const result = await runTool('search_files', { query: 'NEEDLE', glob: '*.ts' }, contextOf(root), workspaceTools);
  assert.equal(parsePage(result.text).total, 0);
});

test('search_files: no matches is a valid empty result, not an error', async () => {
  const root = newGitRepo();
  const result = await runTool('search_files', { query: 'TOTALLY_ABSENT' }, contextOf(root), workspaceTools);
  assert.equal(result.isError, false);
  const page = parsePage(result.text);
  assert.deepEqual(page.lines, []);
  assert.equal(page.total, 0);
});

test('search_files: an empty query is rejected', async () => {
  const root = newGitRepo();
  const result = await runTool('search_files', { query: '' }, contextOf(root), workspaceTools);
  assert.equal(result.isError, true);
  assert.match(result.text, /non-empty string/);
});

for (const [label, query] of [
  ['\\n', 'foo\nbar'],
  ['\\r', 'foo\rbar'],
  ['\\r\\n', 'foo\r\nbar'],
] as const) {
  test(`search_files: a query containing ${label} is rejected explicitly`, async () => {
    const root = newGitRepo();
    sh(root, 'printf "foo\\nbar\\n" > src/two-lines.ts');
    const result = await runTool('search_files', { query }, contextOf(root), workspaceTools);
    assert.equal(result.isError, true);
    assert.match(result.text, /must be a single line/);
  });
}

test('search_files: a query containing a NUL character is rejected explicitly', async () => {
  const root = newGitRepo();
  const query = `foo${String.fromCharCode(0)}bar`;
  const result = await runTool('search_files', { query }, contextOf(root), workspaceTools);
  assert.equal(result.isError, true);
  assert.match(result.text, /NUL character/);
});

// ---------------------------------------------------------------------------
// search_files — failure semantics: distinguishing "successfully searched,
// zero matches" from "the search itself did not complete". These exercise
// `searchOverFilesScript` directly against a hand-built, NUL-delimited file
// list — the same script `search_files` runs — because the tool's own
// eligible-file discovery deliberately excludes anything that could trigger
// a real grep failure (a directory, a missing path), by design: it filters
// to regular, existing, non-symlink files before search ever runs. Proving
// the failure-propagation mechanism therefore means feeding it a file list
// it would never produce itself, exactly as the task requires — the
// mechanism is exercised directly and portably, not by hoping the dev
// machine happens to have a way to break `grep` (permission bits do not
// reliably restrict access on this platform; a directory or missing path
// does, on every platform, deterministically).
// ---------------------------------------------------------------------------

function nulJoin(paths: readonly string[]): string {
  return paths.map((path) => `${path}\0`).join('');
}

function runSearchOverFiles(
  fileListPath: string,
  query: string,
): { readonly status: number; readonly stdout: string; readonly stderr: string } {
  try {
    const stdout = execFileSync('bash', ['-c', searchOverFilesScript, '_', fileListPath], {
      encoding: 'utf8',
      env: { ...process.env, LOTUSBUILD_QUERY: query },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

test('searchOverFilesScript: a genuine zero-match search succeeds with empty output', () => {
  const root = newGitRepo();
  const rootWin = root.replace(/^\/([a-z])\//, '$1:/');
  const filePath = join(rootWin, 'src', 'tracked.ts');
  const listPath = join(rootWin, 'files.list');
  writeFileSync(listPath, nulJoin([filePath]), 'utf8');

  const result = runSearchOverFiles(listPath, 'TOTALLY_ABSENT_TEXT');

  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('searchOverFilesScript: a directory in the file list fails the whole search, not zero matches', () => {
  const root = newGitRepo();
  const rootWin = root.replace(/^\/([a-z])\//, '$1:/');
  const badDir = join(rootWin, 'a-directory');
  mkdirSync(badDir);
  const listPath = join(rootWin, 'files.list');
  writeFileSync(listPath, nulJoin([badDir]), 'utf8');

  const result = runSearchOverFiles(listPath, 'ANYTHING');

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Is a directory/);
});

test('searchOverFilesScript: a missing file in the file list fails the whole search', () => {
  const root = newGitRepo();
  const rootWin = root.replace(/^\/([a-z])\//, '$1:/');
  const missing = join(rootWin, 'does-not-exist.ts');
  const listPath = join(rootWin, 'files.list');
  writeFileSync(listPath, nulJoin([missing]), 'utf8');

  const result = runSearchOverFiles(listPath, 'ANYTHING');

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No such file or directory/);
});

test('searchOverFilesScript: an earlier match does not survive a later failure — the whole search fails', () => {
  const root = newGitRepo();
  const rootWin = root.replace(/^\/([a-z])\//, '$1:/');
  const goodFile = join(rootWin, 'src', 'tracked.ts'); // contains "const tracked = 1;"
  const badDir = join(rootWin, 'a-directory');
  mkdirSync(badDir);
  const listPath = join(rootWin, 'files.list');
  writeFileSync(listPath, nulJoin([goodFile, badDir]), 'utf8');

  const result = runSearchOverFiles(listPath, 'tracked');

  // The underlying grep call did emit the match before hitting the
  // directory — proving the failure is detected regardless — but the tool
  // layer (searchFilesScript) never surfaces stdout except on success,
  // which is exactly why the match must not be trusted here.
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Is a directory/);
});

test('search_files: the tool layer reports an explicit failure, never zero matches, when the search itself did not complete', async () => {
  // lotusbuild_eligible_files filters to existing, regular, non-symlink
  // files before search ever runs, so a directory or missing path — the
  // deterministic failure triggers used above — can never actually reach
  // search_files through its own discovery; that filtering is a real
  // property of the architecture, not a testing inconvenience. What is
  // still directly testable, and specific to this task's change, is the
  // JS-side interpretation of the two markers: this fakes the sandbox to
  // return exactly the shape a genuine search failure produces —
  // LOTUSBUILD_SEARCH_FAILED, a diagnostic, and a non-zero exit — and
  // proves the tool reports it as an explicit failure with that diagnostic,
  // never as an empty, successful result.
  class FakeFailingSandbox implements RunningSandbox {
    readonly externalId = 'fake-failing-sandbox';
    async runCommand(command: string): Promise<CommandOutcome> {
      if (command.includes('lotusbuild_eligible_files')) {
        return {
          exitCode: 1,
          stdout: 'LOTUSBUILD_SEARCH_FAILED\ngrep: some/file: Permission denied\n',
          stderr: '',
        };
      }
      throw new Error(`unexpected command for this fake: ${command}`);
    }
    async writeFile(): Promise<void> {}
    async readFile(): Promise<string> {
      return '';
    }
    previewUrl(): string {
      return 'https://preview.invalid';
    }
    async stop(): Promise<void> {}
  }

  const ctx: ToolContext = {
    sandbox: new FakeFailingSandbox(),
    provider: provider('/c/fake/root'),
    commandTimeoutMs: 1000,
    previewReadyTimeoutSeconds: 5,
    toolOutputMaxChars: 20000,
    onPreview: async () => {},
  };

  const result = await runTool('search_files', { query: 'anything' }, ctx, workspaceTools);

  assert.equal(result.isError, true);
  assert.match(result.text, /the search itself failed/);
  assert.match(result.text, /Permission denied/);
  // Never claims a count: the previous behaviour this task fixes is exactly
  // this shape reported as "0 matches" instead.
  assert.equal(result.text.includes('matches 0-0 of 0'), false);
});

test('search_files: first, middle and final pages of matches are consistent', async () => {
  const root = newGitRepo();
  for (let i = 0; i < 9; i += 1) {
    sh(root, `printf "NEEDLE line ${i}\\n" > src/m${String(i).padStart(2, '0')}.ts`);
  }
  const ctx = contextOf(root);
  const first = parsePage((await runTool('search_files', { query: 'NEEDLE', offset: 0, limit: 4 }, ctx, workspaceTools)).text);
  assert.equal(first.hasMore, true);
  const middle = parsePage(
    (await runTool('search_files', { query: 'NEEDLE', offset: first.end, limit: 4 }, ctx, workspaceTools)).text,
  );
  assert.equal(middle.start, first.end);
  const last = parsePage(
    (await runTool('search_files', { query: 'NEEDLE', offset: middle.end, limit: 4 }, ctx, workspaceTools)).text,
  );
  assert.equal(last.hasMore, false);
  assert.equal(last.end, last.total);
});

test('search_files: sequential pages reconstruct the full match list with no gaps or duplicates', async () => {
  const root = newGitRepo();
  for (let i = 0; i < 13; i += 1) {
    sh(root, `printf "NEEDLE ${i}\\n" > src/r${String(i).padStart(2, '0')}.ts`);
  }
  const ctx = contextOf(root);
  const whole = parsePage(
    (await runTool('search_files', { query: 'NEEDLE', limit: 1000 }, ctx, workspaceTools)).text,
  ).lines;

  let offset = 0;
  let reconstructed: string[] = [];
  for (let guard = 0; guard < 50; guard += 1) {
    const page = parsePage(
      (await runTool('search_files', { query: 'NEEDLE', offset, limit: 3 }, ctx, workspaceTools)).text,
    );
    reconstructed = reconstructed.concat([...page.lines]);
    if (!page.hasMore) {
      break;
    }
    offset = page.end;
  }
  assert.deepEqual(reconstructed, whole);
});

test('search_files: ordering is deterministic across repeated calls', async () => {
  const root = newGitRepo();
  sh(root, 'printf "NEEDLE\\n" > src/z.ts\nprintf "NEEDLE\\n" > src/a.ts\nprintf "NEEDLE\\n" > src/m.ts');
  const ctx = contextOf(root);
  const first = parsePage((await runTool('search_files', { query: 'NEEDLE' }, ctx, workspaceTools)).text).lines;
  const second = parsePage((await runTool('search_files', { query: 'NEEDLE' }, ctx, workspaceTools)).text).lines;
  assert.deepEqual(first, second);
});

test('search_files: a page shrinks truthfully to fit a tight output budget', async () => {
  const root = newGitRepo();
  for (let i = 0; i < 20; i += 1) {
    sh(root, `printf "NEEDLE with some extra surrounding words on the line ${i}\\n" > src/b${String(i).padStart(3, '0')}.ts`);
  }
  const ctx = contextOf(root, 400);
  const result = await runTool('search_files', { query: 'NEEDLE', offset: 0, limit: 1000 }, ctx, workspaceTools);
  assert.equal(result.isError, false);
  assert.ok(result.text.length <= 400);
  const page = parsePage(result.text);
  assert.equal(page.hasMore, true);
  assert.equal(truncate(result.text, 400), result.text);
});

test('search_files: matches non-BMP Unicode content correctly', async () => {
  const root = newGitRepo();
  writeFileSync(join(root.replace(/^\/([a-z])\//, '$1:/'), 'src', 'emoji.ts'), 'const s = "NEEDLE \u{1F600}";\n', 'utf8');
  const result = await runTool('search_files', { query: 'NEEDLE \u{1F600}' }, contextOf(root), workspaceTools);
  assert.equal(result.isError, false);
  const page = parsePage(result.text);
  assert.deepEqual(page.lines, ['src/emoji.ts:1: const s = "NEEDLE \u{1F600}";']);
});

// ---------------------------------------------------------------------------
// Security: shell metacharacters, path escape, tool wiring
// ---------------------------------------------------------------------------

const shellMetacharacterQueries = [
  '; touch pwned',
  '$(touch pwned)',
  '`touch pwned`',
  '*',
  '?',
  '"quoted"',
  "it's",
  'newline\nin\nquery',
];

for (const query of shellMetacharacterQueries) {
  test(`search_files: query "${JSON.stringify(query)}" is inert data, never executed`, async () => {
    const root = newGitRepo();
    const result = await runTool('search_files', { query }, contextOf(root), workspaceTools);
    // Whatever the result, nothing it names must exist as a real file: the
    // query was never interpreted as shell syntax.
    assert.equal(result.isError === true || result.isError === false, true);
    let pwnedExists = true;
    try {
      execFileSync('bash', ['-c', `cd "${root}"\ntest -e pwned`]);
    } catch {
      pwnedExists = false;
    }
    assert.equal(pwnedExists, false, `a shell side effect ran for query ${JSON.stringify(query)}`);
  });
}

test('list_files: a path escaping the workspace is rejected', async () => {
  const root = newGitRepo();
  const result = await runTool('list_files', { path: '../../etc' }, contextOf(root), workspaceTools);
  assert.equal(result.isError, true);
  assert.match(result.text, /resolves outside the project directory/);
});

test('search_files: a path escaping the workspace is rejected', async () => {
  const root = newGitRepo();
  const result = await runTool('search_files', { query: 'x', path: '../outside' }, contextOf(root), workspaceTools);
  assert.equal(result.isError, true);
  assert.match(result.text, /resolves outside the project directory/);
});

test('search_files: an absolute path outside the workspace is rejected', async () => {
  const root = newGitRepo();
  const result = await runTool(
    'search_files',
    { query: 'x', path: '/etc' },
    contextOf(root),
    workspaceTools,
  );
  assert.equal(result.isError, true);
  assert.match(result.text, /resolves outside the project directory/);
});

test('list_files and search_files are granted to the primary agent and to read-only specialists', () => {
  assert.ok(workspaceTools.has('list_files'));
  assert.ok(workspaceTools.has('search_files'));
  assert.ok(readOnlyTools.has('list_files'));
  assert.ok(readOnlyTools.has('search_files'));
});

test('list_files and search_files are parallel-safe', () => {
  assert.equal(workspaceTools.get('list_files')?.parallelSafe, true);
  assert.equal(workspaceTools.get('search_files')?.parallelSafe, true);
});
