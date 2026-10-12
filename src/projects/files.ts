import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { AppError } from '../http/errors.ts';
import type { PersistedSnapshot, SnapshotStorage } from '../storage/snapshots.ts';
import type { Project } from './repository.ts';

export interface ProjectFileEntry { readonly path: string; readonly size: number }
export interface ProjectTree {
  readonly head: string | null;
  readonly ref: string | null;
  readonly branches: readonly string[];
  readonly files: readonly ProjectFileEntry[];
  readonly truncated: boolean;
}
export interface ProjectFile {
  readonly path: string;
  readonly size: number;
  readonly binary: boolean;
  readonly content: string | null;
  readonly truncated: boolean;
}

export interface ProjectFilesOptions {
  readonly maxArchiveBytes: number;
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly cacheEntries: number;
  readonly cacheTtlMs: number;
}
const defaults: ProjectFilesOptions = {
  maxArchiveBytes: 512 * 1024 * 1024, maxFiles: 5000, maxFileBytes: 512 * 1024, cacheEntries: 8, cacheTtlMs: 5 * 60_000,
};

const empty: ProjectTree = { head: null, ref: null, branches: [], files: [], truncated: false };
const unavailable = () => new AppError({ code: 'project/files-unavailable', statusCode: 503, message: 'Project files could not be read. Try again shortly.' });
const notFound = () => new AppError({ code: 'project/file-not-found', statusCode: 404, message: 'No such file in this project.' });

/** Paths the API accepts: relative, printable, no traversal and nothing inside `.git`. */
export function isProjectPath(path: string): boolean {
  if (path.length === 0 || path.length > 1024 || path.startsWith('/') || /[\u0000-\u001F\u007F\\]/.test(path)) return false;
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
}

/**
 * Reads the last saved version of a project straight from its stored git
 * snapshot (a gzipped `.git`), never from a live sandbox. The archive is
 * untrusted: it is unpacked as data only, anything that is not a plain file or
 * directory rejects the whole snapshot, the repository config is replaced
 * before git runs, and git itself runs with no system/global config or hooks.
 */
export class ProjectFiles {
  readonly #snapshots: Pick<SnapshotStorage, 'readUrl'>;
  readonly #fetch: typeof fetch;
  readonly #options: ProjectFilesOptions;
  readonly #cache = new Map<string, { readonly dir: Promise<string>; readonly expires: number }>();

  constructor(snapshots: Pick<SnapshotStorage, 'readUrl'>, fetchImpl: typeof fetch = fetch, options: Partial<ProjectFilesOptions> = {}) {
    this.#snapshots = snapshots;
    this.#fetch = fetchImpl;
    this.#options = { ...defaults, ...options };
  }

  async tree(project: Project, ref?: string): Promise<ProjectTree> {
    if (project.snapshot.kind === 'none') return empty;
    const git = await this.#repository(project.id, project.snapshot);
    const branches = (await git(['for-each-ref', '--count=200', '--format=%(refname:short)', 'refs/heads'])).toString('utf8').split('\n').filter(Boolean);
    const head = await git(['symbolic-ref', '-q', '--short', 'HEAD']).then((out) => out.toString('utf8').trim() || null, () => null);
    if (ref !== undefined && !branches.includes(ref)) throw new AppError({ code: 'project/branch-not-found', statusCode: 404, message: 'No such branch in this project.' });
    const target = ref ?? head;
    const commit = await git(['rev-parse', '--verify', '-q', `${target === null ? 'HEAD' : `refs/heads/${target}`}^{commit}`]).then((out) => out.toString('utf8').trim(), () => null);
    if (commit === null) return { head, ref: target, branches, files: [], truncated: false };
    const files = await this.#list(git, commit);
    return { head, ref: target, branches, files: files.slice(0, this.#options.maxFiles).map(({ path, size }) => ({ path, size })), truncated: files.length > this.#options.maxFiles };
  }

  async read(project: Project, path: string, ref?: string): Promise<ProjectFile> {
    if (!isProjectPath(path)) throw notFound();
    const tree = await this.tree(project, ref);
    if (tree.files.length === 0) throw notFound();
    const git = await this.#repository(project.id, project.snapshot as PersistedSnapshot);
    const commit = (await git(['rev-parse', '--verify', '-q', `${tree.ref === null ? 'HEAD' : `refs/heads/${tree.ref}`}^{commit}`])).toString('utf8').trim();
    const entry = (await this.#list(git, commit)).find((item) => item.path === path);
    if (entry === undefined) throw notFound();
    const blob = await git(['cat-file', 'blob', entry.sha], entry.size + 1024);
    const binary = blob.subarray(0, 8000).includes(0);
    const truncated = !binary && blob.length > this.#options.maxFileBytes;
    return { path, size: entry.size, binary, truncated,
      content: binary ? null : blob.subarray(0, this.#options.maxFileBytes).toString('utf8') };
  }

  async #list(git: Git, commit: string): Promise<{ path: string; size: number; sha: string }[]> {
    const raw = (await git(['ls-tree', '-r', '-z', '--long', '--full-tree', commit], 64 * 1024 * 1024)).toString('utf8');
    const files: { path: string; size: number; sha: string }[] = [];
    for (const record of raw.split('\0')) {
      const match = /^(\d{6}) (\w+) ([0-9a-f]{40,64}) +(\d+|-)\t(.+)$/s.exec(record);
      if (match === null || match[2] !== 'blob' || match[1] === '120000' || !isProjectPath(match[5]!)) continue;
      files.push({ path: match[5]!, size: Number(match[4]), sha: match[3]! });
    }
    return files;
  }

  async #repository(projectId: string, snapshot: PersistedSnapshot): Promise<Git> {
    const key = `${projectId}:${JSON.stringify(snapshot)}`;
    const now = Date.now();
    for (const [name, entry] of this.#cache) {
      if (entry.expires <= now) { this.#cache.delete(name); void entry.dir.then((dir) => rm(dir, { recursive: true, force: true }), () => {}); }
    }
    let cached = this.#cache.get(key);
    if (cached === undefined) {
      cached = { dir: this.#unpack(projectId, snapshot), expires: now + this.#options.cacheTtlMs };
      this.#cache.set(key, cached);
      cached.dir.catch(() => this.#cache.delete(key));
      while (this.#cache.size > this.#options.cacheEntries) {
        const [oldest, entry] = this.#cache.entries().next().value!;
        this.#cache.delete(oldest);
        void entry.dir.then((dir) => rm(dir, { recursive: true, force: true }), () => {});
      }
    }
    const gitDir = join(await cached.dir, '.git');
    return (args, maxBuffer = 8 * 1024 * 1024) => run(gitDir, args, maxBuffer);
  }

  async #unpack(projectId: string, snapshot: PersistedSnapshot): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'lotusbuild-files-'));
    try {
      const response = await this.#fetch(await this.#snapshots.readUrl(projectId, snapshot));
      if (!response.ok || response.body === null) throw unavailable();
      const archive = join(dir, 'snapshot.tgz');
      let bytes = 0;
      const limit = this.#options.maxArchiveBytes;
      await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), new Transform({
        transform(chunk: Buffer, _encoding, done) {
          bytes += chunk.length;
          done(bytes > limit ? unavailable() : null, chunk);
        },
      }), createWriteStream(archive, { mode: 0o600 }));
      const names = (await tar(['-tzf', archive])).toString('utf8').split('\n').filter(Boolean);
      if (names.some((name) => name.startsWith('/') || name.split('/').includes('..') || !/^(\.\/)?\.git(\/|$)/.test(name))) throw unavailable();
      const repo = join(dir, 'repo');
      await mkdir(repo, { mode: 0o700 });
      await tar(['-xzf', archive, '-C', repo, '--no-same-owner', '--no-same-permissions', '--no-overwrite-dir']);
      await rm(archive, { force: true });
      await assertPlainTree(repo);
      await writeFile(join(repo, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = true\n', { mode: 0o600 });
      return repo;
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error instanceof AppError ? error : unavailable();
    }
  }
}

type Git = (args: string[], maxBuffer?: number) => Promise<Buffer>;

async function assertPlainTree(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const stat = await lstat(path);
    if (stat.isDirectory()) await assertPlainTree(path);
    else if (!stat.isFile()) throw unavailable();
  }
}

function tar(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => execFile('tar', args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 },
    (error, stdout) => (error ? reject(error) : resolve(stdout))));
}

function run(gitDir: string, args: string[], maxBuffer: number): Promise<Buffer> {
  return new Promise((resolve, reject) => execFile('git', ['--git-dir', gitDir, '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    encoding: 'buffer', maxBuffer, timeout: 30_000,
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: gitDir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  }, (error, stdout) => (error ? reject(error) : resolve(stdout))));
}
