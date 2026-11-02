import { AppError } from '../http/errors.ts';
import type { ConnectionRepository } from '../connections/service.ts';
import type { Project, ProjectRepository, ProjectSource } from '../projects/repository.ts';
import type { RunningSandbox } from '../sandboxes/provider.ts';
import type { SandboxProvider } from '../entitlements/schema.ts';
import type { UserRepository } from '../users/repository.ts';
import type { GitHubApp } from './app.ts';

/** How the repository ended up in the sandbox. */
export type CheckoutOutcome = 'cloned' | 'synced' | 'rebound';

export interface RepositoryCheckout {
  readonly fullName: string;
  readonly defaultBranch: string;
  /** The task branch checked out, or the default branch when no task has been named yet. */
  readonly branch: string;
  readonly taskBranch: string | undefined;
  readonly outcome: CheckoutOutcome;
  readonly coauthor: { readonly name: string; readonly email: string } | undefined;
}

const tokenPath = '/tmp/lotusbuild-git-token';
const askpassPath = '/tmp/lotusbuild-askpass';
/** The slug the agent names a task with; also what `lotusbuild/` is prefixed to. */
export const taskBranchPattern = /^[a-z0-9][a-z0-9._-]{1,62}$/;
export const taskBranchPrefix = 'lotusbuild/';

/**
 * Puts a project's GitHub repository into its sandbox and keeps it there.
 *
 * The remote is the project's source of truth. A sandbox that has never seen
 * the repository clones it; one restored from a snapshot keeps its local
 * history and fetches; one whose remote no longer matches the binding (the
 * owner re-bound the project) is pointed at the new repository and moved onto
 * its default branch — nothing in the working tree is deleted on the way.
 *
 * Credentials never reach the repository: the installation token lives in a
 * file that only `GIT_ASKPASS` reads for the duration of one script and is
 * removed on exit, so `.git/config`, argv, and the shell history hold nothing
 * worth stealing. The token expires within the hour regardless.
 */
export class RepositoryWorkspaces {
  readonly #app: GitHubApp;
  readonly #connections: ConnectionRepository;
  readonly #projects: ProjectRepository;
  readonly #users: UserRepository;
  readonly #commandTimeoutMs: number;

  constructor(args: {
    readonly app: GitHubApp;
    readonly connections: ConnectionRepository;
    readonly projects: ProjectRepository;
    readonly users: UserRepository;
    readonly commandTimeoutMs: number;
  }) {
    this.#app = args.app;
    this.#connections = args.connections;
    this.#projects = args.projects;
    this.#users = args.users;
    this.#commandTimeoutMs = args.commandTimeoutMs;
  }

  async prepare(input: {
    readonly sandbox: RunningSandbox;
    readonly provider: SandboxProvider;
    readonly project: Project;
    readonly source: ProjectSource;
    readonly gitEnv: Readonly<Record<string, string>>;
  }): Promise<RepositoryCheckout> {
    const { source, project } = input;
    const { secret } = await this.#connections.openCredential({ id: source.connectionId, ownerUid: project.ownerUid, projectId: project.id });
    const installationId = Number(secret.toString('utf8'));
    secret.fill(0);
    if (!Number.isInteger(installationId) || installationId <= 0) throw new Error('The GitHub connection holds no installation.');
    const token = await this.#app.installationToken(installationId);

    await input.sandbox.writeFile(askpassPath, [
      '#!/bin/sh',
      'case "$1" in',
      '  Username*) echo x-access-token ;;',
      `  *) cat ${tokenPath} ;;`,
      'esac',
      '',
    ].join('\n'));
    await input.sandbox.writeFile(tokenPath, token.token);

    const outcome = await input.sandbox.runCommand(checkoutScript, {
      cwd: input.provider.workdir,
      timeoutMs: this.#commandTimeoutMs,
      envs: {
        ...input.gitEnv,
        GIT_ASKPASS: askpassPath,
        GIT_TERMINAL_PROMPT: '0',
        LOTUSBUILD_REMOTE: `https://github.com/${source.fullName}.git`,
        LOTUSBUILD_DEFAULT_BRANCH: source.defaultBranch,
        LOTUSBUILD_TASK_BRANCH: source.branch ?? '',
      },
    });
    if (outcome.exitCode !== 0) {
      throw new AppError({
        code: 'repository/unavailable', statusCode: 502,
        message: `${source.fullName} could not be checked out. Check that the LotusBuild GitHub app still has access to it.`,
        details: { exitCode: outcome.exitCode, stderr: outcome.stderr.slice(0, 500) },
      });
    }
    const fields = new Map(outcome.stdout.split('\n').filter((line) => line.includes('=')).map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at), line.slice(at + 1).trim()] as const;
    }));
    const mode = fields.get('mode');
    const branch = fields.get('branch');
    if ((mode !== 'cloned' && mode !== 'synced' && mode !== 'rebound') || branch === undefined || branch === '') {
      throw new Error('The repository checkout reported an unreadable state.');
    }
    return {
      fullName: source.fullName, defaultBranch: source.defaultBranch, branch, taskBranch: source.branch, outcome: mode,
      coauthor: await this.#coauthor(project.ownerUid),
    };
  }

  /** Records the task branch the agent named, so later sessions continue it. */
  async recordBranch(project: Project, branch: string): Promise<void> {
    await this.#projects.setSourceBranch(project.ownerUid, project.id, branch);
  }

  async #coauthor(uid: string): Promise<RepositoryCheckout['coauthor']> {
    try {
      const user = await this.#users.read(uid);
      if (!user.email) return undefined;
      return { name: user.displayName ?? user.email.split('@')[0] ?? 'LotusBuild user', email: user.email };
    } catch {
      return undefined;
    }
  }
}

/**
 * One script, so the token file is removed by the same process that needed
 * it. Every value arrives through the environment; nothing is spliced in.
 */
const checkoutScript = [
  'set -eu',
  `trap 'rm -f ${tokenPath} ${askpassPath}' EXIT`,
  `chmod 700 ${askpassPath}`,
  'remote="$LOTUSBUILD_REMOTE"',
  'default="$LOTUSBUILD_DEFAULT_BRANCH"',
  'task="$LOTUSBUILD_TASK_BRANCH"',
  'mode=',
  'if git rev-parse --git-dir >/dev/null 2>&1 && git rev-parse --verify HEAD >/dev/null 2>&1; then',
  '  current="$(git remote get-url origin 2>/dev/null || true)"',
  '  if [ "$current" = "$remote" ]; then mode=synced',
  '  elif [ -z "$current" ]; then git remote add origin "$remote"; mode=synced',
  '  else git remote set-url origin "$remote"; mode=rebound; fi',
  '  git fetch -q origin',
  'else',
  // A fresh `git init` with no commits, or no repository at all: the clone
  // needs an empty directory, and an empty history is nothing to keep.
  '  if [ -n "$(find . -mindepth 1 -maxdepth 1 -not -name .git -print -quit)" ]; then',
  '    echo "The project directory already has files; a repository cannot be cloned over them." >&2; exit 3',
  '  fi',
  '  rm -rf .git',
  '  git clone -q --branch "$default" -- "$remote" .',
  '  mode=cloned',
  'fi',
  'if [ -n "$task" ]; then',
  '  if git show-ref --verify --quiet "refs/heads/$task"; then git checkout -q "$task"',
  '  elif git show-ref --verify --quiet "refs/remotes/origin/$task"; then git checkout -q -b "$task" --track "origin/$task"',
  '  else git checkout -q -b "$task" "origin/$default"; fi',
  'elif [ "$mode" = rebound ]; then',
  '  git checkout -q -B "$default" "origin/$default"',
  'elif [ "$mode" = synced ] && [ "$(git rev-parse --abbrev-ref HEAD)" = "$default" ]; then',
  '  git merge -q --ff-only "origin/$default" >/dev/null 2>&1 || true',
  'fi',
  'echo "mode=$mode"',
  'echo "branch=$(git rev-parse --abbrev-ref HEAD)"',
  '',
].join('\n');
