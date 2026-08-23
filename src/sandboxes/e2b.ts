import { CommandExitError, Sandbox } from 'e2b';

import type { SandboxProvider } from '../entitlements/schema.ts';
import type { CommandOutcome, RunningSandbox, SandboxAdapter } from './provider.ts';

/**
 * E2B's microVMs.
 *
 * Everything about the machine — template, lifetime, working directory — comes
 * from the registry's provider row, so changing what a web build runs on is a
 * configuration edit. Memory and CPU are the exception: E2B fixes those in the
 * template itself, so the registry's `memoryMb` and `cpus` describe the template
 * rather than instruct it, and are not passed here.
 */
export class E2BAdapter implements SandboxAdapter {
  readonly #apiKey: string;
  readonly #domain: string;

  constructor(apiKey: string, domain: string) {
    this.#apiKey = apiKey;
    this.#domain = domain;
  }

  #connection() {
    return { apiKey: this.#apiKey, domain: this.#domain };
  }

  async start(
    provider: SandboxProvider,
    context: { readonly metadata: Readonly<Record<string, string>> },
  ): Promise<RunningSandbox> {
    const sandbox = await Sandbox.create(provider.template, {
      ...this.#connection(),
      // The provider's timeout is also what was reserved against the user's
      // allowance, so the machine must not outlive it.
      timeoutMs: provider.timeoutSeconds * 1000,
      metadata: { ...context.metadata },
    });

    // The template decides what exists on disk and the registry decides where we
    // work, and nothing guarantees the two agree — E2B's stock template has no
    // project directory at all. Without this the agent spends its first few
    // steps discovering that every command fails on a missing cwd, which is real
    // money and a user watching an empty screen.
    await sandbox.commands.run(`mkdir -p ${JSON.stringify(provider.workdir)}`);

    return new E2BSandbox(sandbox);
  }

  async connect(externalId: string): Promise<RunningSandbox> {
    return new E2BSandbox(await Sandbox.connect(externalId, this.#connection()));
  }
}

class E2BSandbox implements RunningSandbox {
  readonly #sandbox: Sandbox;

  constructor(sandbox: Sandbox) {
    this.#sandbox = sandbox;
  }

  get externalId(): string {
    return this.#sandbox.sandboxId;
  }

  async runCommand(
    command: string,
    options: {
      readonly cwd: string;
      readonly timeoutMs: number;
      readonly background?: boolean;
      readonly envs?: Readonly<Record<string, string>>;
    },
  ): Promise<CommandOutcome> {
    if (options.background === true) {
      // A dev server never exits, so waiting for it would hang the build. The
      // handle is dropped deliberately: the sandbox owns the process, and it
      // dies when the sandbox does.
      await this.#sandbox.commands.run(command, {
        cwd: options.cwd,
        ...(options.envs === undefined ? {} : { envs: { ...options.envs } }),
        background: true,
      });
      return { exitCode: 0, stdout: '', stderr: '' };
    }

    try {
      const result = await this.#sandbox.commands.run(command, {
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        ...(options.envs === undefined ? {} : { envs: { ...options.envs } }),
        background: false,
      });
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      // The SDK throws on a non-zero exit. For an agent that is not an
      // exception, it is the answer: a failing build step is most of what it
      // reads. Anything that is not an exit code — a dead sandbox, a timeout —
      // still propagates.
      if (!(error instanceof CommandExitError)) {
        throw error;
      }
      return { exitCode: error.exitCode, stdout: error.stdout, stderr: error.stderr };
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.#sandbox.files.write(path, content);
  }

  async readFile(path: string): Promise<string> {
    return this.#sandbox.files.read(path);
  }

  previewUrl(port: number): string {
    return `https://${this.#sandbox.getHost(port)}`;
  }

  async stop(): Promise<void> {
    await this.#sandbox.kill();
  }
}
