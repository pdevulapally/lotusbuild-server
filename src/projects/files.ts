import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { crc32, deflateRaw } from 'node:zlib';

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

export interface ProjectCommit {
  readonly sha: string;
  readonly parent: string | null;
  readonly committedAt: string;
  readonly sessionId: string | null;
  readonly message: string;
}
export interface ProjectChangedFile {
  readonly path: string;
  readonly previousPath: string | null;
  /** null for binary files. */
  readonly additions: number | null;
  readonly deletions: number | null;
}
export interface ProjectChanges {
  readonly sha: string;
  readonly files: readonly ProjectChangedFile[];
  readonly patch: string;
  readonly truncated: boolean;
}
export interface ProjectFilesOptions {
  readonly maxArchiveBytes: number;
  /** Cap on the summed size of every member of a snapshot, checked from its listing before anything is extracted. */
  readonly maxUnpackedBytes: number;
  readonly maxArchiveMembers: number;
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly cacheEntries: number;
  readonly cacheTtlMs: number;
}
const defaults: ProjectFilesOptions = {
  maxArchiveBytes: 512 * 1024 * 1024, maxUnpackedBytes: 1024 * 1024 * 1024, maxArchiveMembers: 100_000, maxFiles: 5000, maxFileBytes: 512 * 1024, cacheEntries: 8, cacheTtlMs: 5 * 60_000,
};

const empty: ProjectTree = { head: null, ref: null, branches: [], files: [], truncated: false };
const unavailable = () => new AppError({ code: 'project/files-unavailable', statusCode: 503, message: 'Project files could not be read. Try again shortly.' });
const commitNotFound = () => new AppError({ code: 'project/commit-not-found', statusCode: 404, message: 'No such saved change in this project.' });
const commitSha = /^[0-9a-f]{40,64}$/;
const maxHistory = 100;
const maxPatchBytes = 1024 * 1024;
const maxChangedFiles = 1000;
const notFound = () => new AppError({ code: 'project/file-not-found', statusCode: 404, message: 'No such file in this project.' });

/** Paths the API accepts: relative, printable, no traversal and nothing inside `.git`. */
export function isProjectPath(path: string): boolean {
  if (path.length === 0 || path.length > 1024 || path.startsWith('/') || /[\u0000-\u001F\u007F\\]/.test(path)) return false;
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
}

/**
 * Reads the last saved version of a project straight from its stored git
 * snapshot (a gzipped `.git`), never from a live sandbox. The archive is
 * untrusted (the agent can write anything into `.git`): its listing is checked
 * before extraction, anything that is not a plain file or directory, or that
 * could redirect git (commondir, alternates, attributes...), rejects the whole
 * snapshot, only refs and objects are extracted, the repository config is
 * written by us, and git runs with no system/global config, attributes or hooks.
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

  /**
   * The saved version of a branch as a zip of its raw blobs (never from a live
   * sandbox). The zip is built here rather than by `git archive`, so no
   * filter, attribute or export-subst from the snapshot can ever run.
   */
  async archive(project: Project, ref?: string): Promise<Buffer> {
    const tree = await this.tree(project, ref);
    if (tree.files.length === 0) throw notFound();
    const git = await this.#repository(project.id, project.snapshot as PersistedSnapshot);
    const target = tree.ref === null ? 'HEAD' : `refs/heads/${tree.ref}`;
    try {
      const commit = (await git(['rev-parse', '--verify', '-q', `${target}^{commit}`])).toString('utf8').trim();
      const files = await this.#list(git, commit);
      const budget = Math.min(this.#options.maxArchiveBytes, 128 * 1024 * 1024);
      const total = files.reduce((sum, file) => sum + file.size, 0);
      if (files.length > 65_535 || total > budget) throw unavailable();
      const committedAt = Number((await git(['log', '-1', '--no-walk', '--format=%ct', commit])).toString('utf8').trim());
      const blobs = await readBlobs(git, files.map((file) => file.sha), total);
      return await zip(files.map((file, index) => ({ path: file.path, executable: file.mode === '100755', data: blobs[index]! })),
        new Date(Number.isFinite(committedAt) ? committedAt * 1000 : 0));
    } catch {
      throw unavailable();
    }
  }

  /** Saved versions on the current branch, newest first. Each agent save is one commit tagged with its session. */
  async history(project: Project, limit = 50): Promise<{ commits: ProjectCommit[] }> {
    if (project.snapshot.kind === 'none') return { commits: [] };
    const git = await this.#repository(project.id, project.snapshot);
    const count = Math.min(Math.max(Math.trunc(limit), 1), maxHistory);
    const raw = await git(['log', '-z', `--max-count=${count}`, '--no-color', '--format=%H%x1f%P%x1f%cI%x1f%s', 'HEAD'])
      .then((out) => out.toString('utf8'), () => '');
    const commits = raw.split('\0').filter(Boolean).flatMap((record): ProjectCommit[] => {
      const [sha = '', parents = '', committedAt = '', subject = ''] = record.split('\x1f');
      const when = new Date(committedAt);
      if (!commitSha.test(sha) || Number.isNaN(when.getTime())) return [];
      const parent = parents.split(' ')[0] ?? '';
      const session = /^LotusBuild (?:session|recovery) ([A-Za-z0-9_-]{1,128})$/.exec(subject);
      return [{ sha, parent: commitSha.test(parent) ? parent : null, committedAt: when.toISOString(), sessionId: session?.[1] ?? null, message: subject.slice(0, 200) }];
    });
    return { commits };
  }

  /** What one saved version changed compared with its parent, as stats plus a capped unified diff. */
  async changes(project: Project, sha: string): Promise<ProjectChanges> {
    if (!commitSha.test(sha) || project.snapshot.kind === 'none') throw commitNotFound();
    const git = await this.#repository(project.id, project.snapshot);
    const type = await git(['cat-file', '-t', sha]).then((out) => out.toString('utf8').trim(), () => null);
    if (type !== 'commit') throw commitNotFound();
    const base = ['diff-tree', '-r', '--root', '--no-commit-id', '-M', '--no-color', '--no-ext-diff', '--no-textconv'];
    const tokens = (await git([...base, '--numstat', '-z', sha], 16 * 1024 * 1024)).toString('utf8').split('\0');
    const files: ProjectChangedFile[] = [];
    for (let index = 0; index < tokens.length && files.length < maxChangedFiles;) {
      const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(tokens[index] ?? '');
      if (match === null) { index++; continue; }
      let path = match[3]!;
      let previousPath: string | null = null;
      if (path === '') { previousPath = tokens[index + 1] ?? ''; path = tokens[index + 2] ?? ''; index += 3; } else index++;
      if (!isProjectPath(path) || (previousPath !== null && !isProjectPath(previousPath))) continue;
      files.push({ path, previousPath, additions: match[1] === '-' ? null : Number(match[1]), deletions: match[2] === '-' ? null : Number(match[2]) });
    }
    const patch = await git([...base, '-p', '--unified=3', sha], 64 * 1024 * 1024);
    return { sha, files, patch: patch.subarray(0, maxPatchBytes).toString('utf8'), truncated: patch.length > maxPatchBytes || tokens.length > maxChangedFiles * 3 };
  }

  async #list(git: Git, commit: string): Promise<{ path: string; size: number; sha: string; mode: string }[]> {
    const raw = (await git(['ls-tree', '-r', '-z', '--long', '--full-tree', commit], 64 * 1024 * 1024)).toString('utf8');
    const files: { path: string; size: number; sha: string; mode: string }[] = [];
    for (const record of raw.split('\0')) {
      const match = /^(\d{6}) (\w+) ([0-9a-f]{40,64}) +(\d+|-)\t(.+)$/s.exec(record);
      if (match === null || match[2] !== 'blob' || match[1] === '120000' || !isProjectPath(match[5]!)) continue;
      files.push({ path: match[5]!, size: Number(match[4]), sha: match[3]!, mode: match[1]! });
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
    return (args, maxBuffer = 8 * 1024 * 1024, input) => run(gitDir, args, maxBuffer, input);
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
      const listing = (await tar(['-tvzf', archive, ...listingFlags])).toString('utf8');
      const members = snapshotMembers(listing, { maxBytes: this.#options.maxUnpackedBytes, maxMembers: this.#options.maxArchiveMembers });
      const repo = join(dir, 'repo');
      await mkdir(join(repo, '.git', 'refs'), { recursive: true, mode: 0o700 });
      await mkdir(join(repo, '.git', 'objects'), { recursive: true, mode: 0o700 });
      const memberList = join(dir, 'members');
      await writeFile(memberList, members.map((name) => `${name}\0`).join(''), { mode: 0o600 });
      await tar(['-xzf', archive, '-C', repo, '--no-same-owner', '--no-same-permissions', '--no-overwrite-dir',
        '--no-recursion', '--no-wildcards', '--null', '--verbatim-files-from', '-T', memberList]);
      await rm(archive, { force: true });
      await rm(memberList, { force: true });
      await assertPlainTree(repo);
      await writeFile(join(repo, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = true\n', { mode: 0o600 });
      return repo;
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error instanceof AppError ? error : unavailable();
    }
  }
}

type Git = (args: string[], maxBuffer?: number, input?: string) => Promise<Buffer>;

const listingFlags = ['--numeric-owner', '--full-time', '--utc', '--quoting-style=escape'];
const memberLine = /^([^\s])\S{9}\S*\s+\d+\/\d+\s+(\d+)\s+-?\d{4,}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)? (.+)$/;
const refSegment = '[A-Za-z0-9_][A-Za-z0-9._+@-]*';
/** The only parts of `.git` ever extracted: what git needs to read refs and objects, and nothing that configures it. */
const extractable = new RegExp(`^(?:HEAD|packed-refs|refs/(?:${refSegment}/)*${refSegment}|objects/(?:[0-9a-f]{2}/(?:[0-9a-f]{38}|[0-9a-f]{62})|pack/pack-(?:[0-9a-f]{40}|[0-9a-f]{64})\\.(?:pack|idx|rev)))$`);
/** Files git would follow to load config, attributes or objects from elsewhere; normal sandbox repositories never have them. */
const redirecting = /^(?:commondir|gitdir|config\.worktree|info\/(?:attributes|grafts)|objects\/info\/(?:alternates|http-alternates))$|^worktrees(?:\/|$)/;

/**
 * Validates a `tar -tv` listing of a snapshot and returns the member names to
 * extract. Rejects the whole snapshot for anything but regular files and
 * directories under `.git`, any path that could redirect git, and listings
 * whose member count or summed size exceeds the caps, all before extraction.
 */
export function snapshotMembers(listing: string, limits: { readonly maxBytes: number; readonly maxMembers: number }): string[] {
  const lines = listing.split('\n').filter(Boolean);
  if (lines.length > limits.maxMembers) throw unavailable();
  let bytes = 0;
  const members = new Set<string>();
  let head = false;
  for (const line of lines) {
    const match = memberLine.exec(line);
    if (match === null) throw unavailable();
    const [, type, size, name] = match as unknown as [string, string, string, string];
    if (type !== '-' && type !== 'd') throw unavailable();
    bytes += Number(size);
    if (bytes > limits.maxBytes) throw unavailable();
    const path = name.replace(/^\.\//, '').replace(/\/$/, '');
    if (path === '.git') continue;
    if (!path.startsWith('.git/')) throw unavailable();
    const inner = path.slice('.git/'.length);
    if (inner.split('/').some((part) => part === '' || part === '.' || part === '..')) throw unavailable();
    if (redirecting.test(inner)) throw unavailable();
    if (type !== '-' || !extractable.test(inner) || inner.endsWith('.lock')) continue;
    if (inner === 'HEAD') head = true;
    members.add(name);
  }
  if (!head) throw unavailable();
  return [...members];
}

/** Reads blobs by id with `cat-file --batch`, which never applies filters or textconv. */
async function readBlobs(git: Git, shas: readonly string[], totalBytes: number): Promise<Buffer[]> {
  if (shas.length === 0) return [];
  const out = await git(['cat-file', '--batch'], totalBytes + shas.length * 160 + 1024, `${shas.join('\n')}\n`);
  const blobs: Buffer[] = [];
  let offset = 0;
  for (const sha of shas) {
    const end = out.indexOf(0x0a, offset);
    if (end === -1) throw unavailable();
    const header = /^([0-9a-f]{40,64}) blob (\d+)$/.exec(out.subarray(offset, end).toString('utf8'));
    if (header === null || header[1] !== sha) throw unavailable();
    const size = Number(header[2]);
    blobs.push(out.subarray(end + 1, end + 1 + size));
    offset = end + 1 + size + 1;
  }
  return blobs;
}

const deflate = promisify(deflateRaw);

async function zip(entries: readonly { path: string; executable: boolean; data: Buffer }[], modified: Date): Promise<Buffer> {
  const year = Math.min(Math.max(modified.getUTCFullYear(), 1980), 2107);
  const dosTime = (modified.getUTCHours() << 11) | (modified.getUTCMinutes() << 5) | (modified.getUTCSeconds() >> 1);
  const dosDate = ((year - 1980) << 9) | ((modified.getUTCMonth() + 1) << 5) | modified.getUTCDate();
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8');
    const compressed = await deflate(entry.data);
    const stored = compressed.length >= entry.data.length;
    const body = stored ? entry.data : compressed;
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(stored ? 0 : 8, 8); local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(0x0314, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(stored ? 0 : 8, 10); header.writeUInt16LE(dosTime, 12); header.writeUInt16LE(dosDate, 14);
    header.writeUInt32LE(crc, 16); header.writeUInt32LE(body.length, 20); header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(name.length, 28); header.writeUInt32LE((entry.executable ? 0o100755 : 0o100644) * 0x10000, 38);
    header.writeUInt32LE(offset, 42);
    parts.push(local, name, body);
    central.push(header, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

async function assertPlainTree(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const stat = await lstat(path);
    if (stat.isDirectory()) await assertPlainTree(path);
    else if (!stat.isFile()) throw unavailable();
  }
}

function tar(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => execFile('tar', args, {
    encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 60_000, env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC' },
  }, (error, stdout) => (error ? reject(error) : resolve(stdout))));
}

function run(gitDir: string, args: string[], maxBuffer: number, input?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['--git-dir', gitDir, '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.attributesFile=/dev/null', ...args], {
      encoding: 'buffer', maxBuffer, timeout: 30_000,
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: gitDir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}
