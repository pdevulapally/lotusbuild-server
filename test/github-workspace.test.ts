import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RepositoryWorkspaces } from '../src/github/workspace.ts';
import { readOnlyTools, workspaceTools, runTool, type RepositoryContext, type ToolContext } from '../src/runner/tools.ts';
import type { CommandOutcome, RunningSandbox } from '../src/sandboxes/provider.ts';
import type { SandboxProvider } from '../src/entitlements/schema.ts';
import type { Project } from '../src/projects/repository.ts';

const TOKEN = 'ghs_installation_token_value';

class FakeSandbox implements RunningSandbox {
  readonly externalId = 'sandbox-1';
  readonly commands: { command: string; envs: Record<string, string> }[] = [];
  readonly files = new Map<string, string>();
  stdout = 'mode=cloned\nbranch=main\n';
  exitCode = 0;
  async runCommand(command: string, options: { envs?: Readonly<Record<string, string>> }): Promise<CommandOutcome> {
    this.commands.push({ command, envs: { ...(options.envs ?? {}) } });
    return { exitCode: this.exitCode, stdout: this.stdout, stderr: this.exitCode === 0 ? '' : 'fatal: repository not found' };
  }
  async writeFile(path: string, content: string): Promise<void> { this.files.set(path, content); }
  async readFile(): Promise<string> { return ''; }
  previewUrl(): string { return 'https://preview.invalid'; }
  async stop(): Promise<void> {}
}

const provider = { workdir: '/home/user/project' } as unknown as SandboxProvider;
const project = { id: 'proj-1', ownerUid: 'owner-1' } as unknown as Project;
const source = { kind: 'github' as const, connectionId: 'conn-1', fullName: 'octo/app', defaultBranch: 'main', boundAt: new Date() };

function workspaces(overrides: { user?: unknown; installationId?: string } = {}) {
  const calls: string[] = [];
  const recorded: string[] = [];
  const service = new RepositoryWorkspaces({
    app: { installationToken: async (id: number) => { calls.push(`token:${id}`); return { token: TOKEN, expiresAt: new Date(Date.now() + 3_600_000) }; } } as never,
    connections: { openCredential: async (input: { id: string; ownerUid: string; projectId: string }) => {
      calls.push(`credential:${input.id}:${input.ownerUid}:${input.projectId}`);
      return { connection: {}, secret: Buffer.from(overrides.installationId ?? '9001', 'utf8') };
    } } as never,
    projects: { setSourceBranch: async (_uid: string, _id: string, branch: string) => { recorded.push(branch); } } as never,
    users: { read: async () => { if (overrides.user instanceof Error) throw overrides.user; return overrides.user ?? { email: 'ana@example.com', displayName: 'Ana' }; } } as never,
    commandTimeoutMs: 1000,
  });
  return { service, calls, recorded };
}

describe('RepositoryWorkspaces.prepare', () => {
  it('clones through the project-granted credential and keeps the token out of the command and the remote', async () => {
    const { service, calls } = workspaces();
    const sandbox = new FakeSandbox();
    const checkout = await service.prepare({ sandbox, provider, project, source, gitEnv: { GIT_AUTHOR_NAME: 'LotusBuild' } });
    assert.deepEqual(calls, ['credential:conn-1:owner-1:proj-1', 'token:9001']);
    assert.equal(checkout.outcome, 'cloned');
    assert.equal(checkout.branch, 'main');
    assert.equal(checkout.taskBranch, undefined);
    assert.deepEqual(checkout.coauthor, { name: 'Ana', email: 'ana@example.com' });
    const [run] = sandbox.commands;
    assert.ok(run);
    assert.equal(run.command.includes(TOKEN), false, 'token never appears in the script');
    assert.equal(Object.values(run.envs).some((value) => value.includes(TOKEN)), false, 'token never appears in the environment');
    assert.equal(run.envs['LOTUSBUILD_REMOTE'], 'https://github.com/octo/app.git');
    assert.equal(run.envs['GIT_ASKPASS'], '/tmp/lotusbuild-askpass');
    assert.equal(run.envs['GIT_TERMINAL_PROMPT'], '0');
    assert.equal(run.envs['GIT_AUTHOR_NAME'], 'LotusBuild');
    assert.equal(sandbox.files.get('/tmp/lotusbuild-git-token'), TOKEN);
    assert.match(sandbox.files.get('/tmp/lotusbuild-askpass') ?? '', /x-access-token/);
    assert.match(run.command, /trap 'rm -f \/tmp\/lotusbuild-git-token \/tmp\/lotusbuild-askpass' EXIT/);
    assert.match(run.command, /git clone -q --branch "\$default" -- "\$remote" \./);
  });

  it('hands the recorded task branch to the script and reports it back', async () => {
    const { service } = workspaces();
    const sandbox = new FakeSandbox();
    sandbox.stdout = 'mode=synced\nbranch=lotusbuild/add-login\n';
    const checkout = await service.prepare({ sandbox, provider, project, source: { ...source, branch: 'lotusbuild/add-login' }, gitEnv: {} });
    assert.equal(sandbox.commands[0]?.envs['LOTUSBUILD_TASK_BRANCH'], 'lotusbuild/add-login');
    assert.equal(checkout.outcome, 'synced');
    assert.equal(checkout.branch, 'lotusbuild/add-login');
    assert.equal(checkout.taskBranch, 'lotusbuild/add-login');
  });

  it('turns a failed checkout into a repository/unavailable error with no secret in it', async () => {
    const { service } = workspaces();
    const sandbox = new FakeSandbox();
    sandbox.exitCode = 128;
    await assert.rejects(service.prepare({ sandbox, provider, project, source, gitEnv: {} }), (error: { code?: string; statusCode?: number; message: string }) => {
      assert.equal(error.code, 'repository/unavailable');
      assert.equal(error.statusCode, 502);
      assert.equal(JSON.stringify(error).includes(TOKEN), false);
      return true;
    });
  });

  it('refuses a connection whose credential is not an installation', async () => {
    const { service, calls } = workspaces({ installationId: 'not-a-number' });
    await assert.rejects(service.prepare({ sandbox: new FakeSandbox(), provider, project, source, gitEnv: {} }), /no installation/);
    assert.equal(calls.some((call) => call.startsWith('token:')), false);
  });

  it('commits without a co-author when the owner cannot be read', async () => {
    const { service } = workspaces({ user: new Error('unavailable') });
    const checkout = await service.prepare({ sandbox: new FakeSandbox(), provider, project, source, gitEnv: {} });
    assert.equal(checkout.coauthor, undefined);
  });

  it('records the task branch on the project', async () => {
    const { service, recorded } = workspaces();
    await service.recordBranch(project, 'lotusbuild/add-login');
    assert.deepEqual(recorded, ['lotusbuild/add-login']);
  });
});

function context(sandbox: FakeSandbox, repository?: RepositoryContext): ToolContext {
  return {
    sandbox, provider, commandTimeoutMs: 1000, previewReadyTimeoutSeconds: 1, toolOutputMaxChars: 10_000,
    onPreview: async () => {}, ...(repository === undefined ? {} : { repository }),
  };
}

function linked(branch?: string): { repository: RepositoryContext; named: string[] } {
  const named: string[] = [];
  const repository: RepositoryContext = {
    fullName: 'octo/app', defaultBranch: 'main', branch, coauthor: { name: 'Ana', email: 'ana@example.com' },
    onBranch: async (next) => { named.push(next); },
  };
  return { repository, named };
}

describe('git tools', () => {
  it('are granted to the agent, and the read-only ones to specialists', () => {
    for (const name of ['git_status', 'git_diff', 'git_log', 'git_commit']) assert.ok(workspaceTools.has(name), name);
    for (const name of ['git_status', 'git_diff', 'git_log']) assert.ok(readOnlyTools.has(name), name);
    assert.equal(readOnlyTools.has('git_commit'), false);
  });

  it('git_status quotes its arguments and reads an empty tree as nothing changed', async () => {
    const sandbox = new FakeSandbox();
    sandbox.stdout = '';
    const result = await runTool('git_status', {}, context(sandbox), workspaceTools);
    assert.equal(result.isError, false);
    assert.equal(result.text, 'Nothing has changed since the last commit.');
    assert.equal(sandbox.commands[0]?.command, "'git' 'status' '--porcelain=v1' '--branch'");
  });

  it('git_diff keeps paths inside the project and never lets one look like a flag', async () => {
    const sandbox = new FakeSandbox();
    const outside = await runTool('git_diff', { path: '../secrets' }, context(sandbox), workspaceTools);
    assert.equal(outside.isError, true);
    const flag = await runTool('git_diff', { path: '--output=/tmp/x' }, context(sandbox), workspaceTools);
    assert.equal(flag.isError, true);
    assert.equal(sandbox.commands.length, 0);
    sandbox.stdout = 'diff --git a/src/a.ts b/src/a.ts\n';
    const ok = await runTool('git_diff', { path: 'src/a.ts' }, context(sandbox), workspaceTools);
    assert.equal(ok.isError, false);
    assert.equal(sandbox.commands[0]?.command, "'git' 'diff' 'HEAD' '--no-color' '--no-ext-diff' '--' 'src/a.ts'");
  });

  it('git_commit in a linked project refuses to commit on the default branch until the task is named', async () => {
    const sandbox = new FakeSandbox();
    const { repository, named } = linked();
    const result = await runTool('git_commit', { message: 'Add login page' }, context(sandbox, repository), workspaceTools);
    assert.equal(result.isError, true);
    assert.match(result.text, /pass "task"/);
    assert.equal(sandbox.commands.length, 0);
    assert.deepEqual(named, []);
  });

  it('git_commit names the task branch, adds the co-author, and records the branch once the commit exists', async () => {
    const sandbox = new FakeSandbox();
    sandbox.stdout = 'commit=abc1234\nbranch=lotusbuild/add-login\nfiles=3\n';
    const { repository, named } = linked();
    const result = await runTool('git_commit', { message: 'Add login page', task: 'add-login' }, context(sandbox, repository), workspaceTools);
    assert.equal(result.isError, false, result.text);
    assert.equal(result.text, 'Committed abc1234 on lotusbuild/add-login (3 file(s)). Not pushed.');
    assert.equal(sandbox.files.get('/tmp/lotusbuild-commit-message'), 'Add login page\n\nCo-authored-by: Ana <ana@example.com>\n');
    const script = sandbox.commands[0]?.command ?? '';
    assert.match(script, /git checkout -q -b 'lotusbuild\/add-login' 'origin\/main'/);
    assert.match(script, /git commit -q -F \/tmp\/lotusbuild-commit-message/);
    assert.equal(script.includes('Add login page'), false, 'the message travels in a file, not the script');
    assert.deepEqual(named, ['lotusbuild/add-login']);
    assert.equal(repository.branch, 'lotusbuild/add-login');
  });

  it('git_commit keeps committing on the current task without renaming it', async () => {
    const sandbox = new FakeSandbox();
    sandbox.stdout = 'commit=def5678\nbranch=lotusbuild/add-login\nfiles=1\n';
    const { repository, named } = linked('lotusbuild/add-login');
    const result = await runTool('git_commit', { message: 'Wire the form' }, context(sandbox, repository), workspaceTools);
    assert.equal(result.isError, false);
    assert.equal((sandbox.commands[0]?.command ?? '').includes('checkout'), false);
    assert.deepEqual(named, []);
  });

  it('git_commit rejects a task slug that is not a safe branch name', async () => {
    const sandbox = new FakeSandbox();
    const { repository } = linked();
    const result = await runTool('git_commit', { message: 'x', task: 'Add Login; rm -rf /' }, context(sandbox, repository), workspaceTools);
    assert.equal(result.isError, true);
    assert.equal(sandbox.commands.length, 0);
  });

  it('git_commit does not record a branch when there was nothing to commit', async () => {
    const sandbox = new FakeSandbox();
    sandbox.stdout = 'nothing=yes\n';
    const { repository, named } = linked();
    const result = await runTool('git_commit', { message: 'x', task: 'add-login' }, context(sandbox, repository), workspaceTools);
    assert.equal(result.isError, false);
    assert.match(result.text, /nothing to commit/);
    assert.deepEqual(named, ['lotusbuild/add-login'], 'the branch now exists in the sandbox, so later sessions must continue it');
  });
});
