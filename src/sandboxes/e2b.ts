import { projectFilesScript } from './project-files.ts';
import { CommandExitError, Sandbox } from 'e2b';

import type { SandboxProvider } from '../entitlements/schema.ts';
import type { CommandOutcome, RunningSandbox, SandboxAdapter } from './provider.ts';
import { outputLimiter, readBoundedText, readTextWindow } from './bounded-output.ts';

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
  readonly #validateApiKey: boolean;
  readonly #maxOutputBytes: number;

  constructor(apiKey: string, domain: string, validateApiKey: boolean, maxOutputBytes: number) {
    this.#apiKey = apiKey;
    this.#domain = domain;
    this.#validateApiKey = validateApiKey;
    outputLimiter(maxOutputBytes);
    this.#maxOutputBytes = maxOutputBytes;
  }

  /**
   * The domain is the whole difference between E2B's cloud and our own: the SDK
   * derives its control plane from it as `https://api.${domain}`, and sandbox
   * hostnames come back per sandbox from that API. Nothing else here knows or
   * cares which one it is talking to.
   *
   * The key format check is separate because it happens *before* any request.
   * E2B's cloud issues `e2b_<hex>`; a self-hosted deployment issues whatever it
   * likes, and the check would reject a perfectly good key without ever leaving
   * the process.
   */
  #connection() {
    return {
      apiKey: this.#apiKey,
      domain: this.#domain,
      validateApiKey: this.#validateApiKey,
    };
  }

  async start(
    provider: SandboxProvider,
    context: { readonly metadata: Readonly<Record<string, string>>; readonly publicPreviewEnabled?: boolean },
  ): Promise<RunningSandbox> {
    const sandbox = await Sandbox.create(provider.template, {
      ...this.#connection(),
      // The provider's timeout is also what was reserved against the user's
      // allowance, so the machine must not outlive it.
      timeoutMs: provider.timeoutSeconds * 1000,
      metadata: { ...context.metadata },
      secure: true,
      network: { allowPublicTraffic: context.publicPreviewEnabled === true },
    });

    // The template decides what exists on disk and the registry decides where we
    // work, and nothing guarantees the two agree — E2B's stock template has no
    // project directory at all. Without this the agent spends its first few
    // steps discovering that every command fails on a missing cwd, which is real
    // money and a user watching an empty screen.
    try {
      await sandbox.commands.run('mkdir -p -- "$LOTUSBUILD_WORKDIR"', {
        envs: { LOTUSBUILD_WORKDIR: provider.workdir },
      });
    } catch (cause) {
      try { await sandbox.kill(); }
      catch (cleanup) { throw new AggregateError([cause, cleanup], 'Sandbox preparation and cleanup failed.'); }
      throw cause;
    }

    return new E2BSandbox(sandbox, this.#maxOutputBytes);
  }

  async terminate(externalId: string): Promise<boolean> {
    return Sandbox.kill(externalId, this.#connection());
  }

  async connect(externalId: string): Promise<RunningSandbox> {
    return new E2BSandbox(await Sandbox.connect(externalId, this.#connection()), this.#maxOutputBytes);
  }
}

class E2BSandbox implements RunningSandbox {
  readonly #sandbox: Sandbox;
  readonly #maxOutputBytes: number;

  constructor(sandbox: Sandbox, maxOutputBytes: number) {
    this.#sandbox = sandbox;
    this.#maxOutputBytes = maxOutputBytes;
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
      const handle = await this.#sandbox.commands.run(command, {
        cwd: options.cwd,
        ...(options.envs === undefined ? {} : { envs: { ...options.envs } }),
        background: true,
        onStdout: outputLimiter(this.#maxOutputBytes),
        onStderr: outputLimiter(this.#maxOutputBytes),
      });
      await handle.disconnect();
      return { exitCode: 0, stdout: '', stderr: '' };
    }

    try {
      // The installed SDK awaits these callbacks after each RPC chunk. Throwing
      // stops its event iterator instead of letting its internal buffers grow.
      const limit = outputLimiter(this.#maxOutputBytes);
      const result = await this.#sandbox.commands.run(command, {
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        ...(options.envs === undefined ? {} : { envs: { ...options.envs } }),
        background: false,
        onStdout: limit,
        onStderr: limit,
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

  async projectFileOperation(root: string, request: Readonly<Record<string, unknown>>, timeoutMs: number): Promise<CommandOutcome> {
    return this.runCommand('python3 -I -c "$LOTUSBUILD_FILE_HELPER"', {
      cwd: '/', timeoutMs, envs: {
        LOTUSBUILD_FILE_HELPER: projectFilesScript,
        LOTUSBUILD_FILE_REQUEST: JSON.stringify({ ...request, root, budget: this.#maxOutputBytes }),
      },
    });
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.#sandbox.files.write(path, content);
  }

  async readFile(path: string): Promise<string> {
    return readBoundedText(await this.#sandbox.files.read(path, { format: 'stream' }), this.#maxOutputBytes);
  }

  previewUrl(port: number): string {
    return `https://${this.#sandbox.getHost(port)}`;
  }

  async lifetime() {
    const info = await this.#sandbox.getInfo();
    return { startedAt: info.startedAt, endAt: info.endAt };
  }

  async stop(): Promise<void> {
    await this.#sandbox.kill();
  }

  async readFileRange(path: string, offset: number, limit: number, timeoutMs: number) {
    const stream = await this.#sandbox.files.read(path, {
      format: 'stream', signal: AbortSignal.timeout(timeoutMs),
    });
    return readTextWindow(stream, offset, limit);
  }

  async forkForValidation(timeoutMs: number): Promise<RunningSandbox> {
    const results = await this.#sandbox.fork({ count: 1, timeoutMs });
    const fork = results[0];
    if (results.length !== 1 || fork === undefined) throw new Error('The provider returned no validation sandbox.');
    if (fork instanceof Error) throw fork;
    return new E2BSandbox(fork, this.#maxOutputBytes);
  }
}
