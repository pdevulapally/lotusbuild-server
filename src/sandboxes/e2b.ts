import { projectFilesScript } from './project-files.ts';
import { ALL_TRAFFIC, CommandExitError, Sandbox, SandboxNotFoundError, type CommandHandle } from 'e2b';

import { parseSandboxNetwork, type DesktopSettings, type SandboxNetworkPolicy, type SandboxProvider } from '../entitlements/schema.ts';
import type { CommandOutcome, DesktopEndpoint, RunningSandbox, SandboxAdapter, SandboxLifecycle } from './provider.ts';
import { outputLimiter, readBoundedBytes, readBoundedText, readTextWindow } from './bounded-output.ts';

/** The X display the desktop lives on, inside the sandbox. */
const desktopDisplay = ':0';

/** The noVNC proxy's port, and the only one the relay ever connects to. */
const desktopStreamPort = 6080;

function networkRules(policy: SandboxNetworkPolicy) {
  const checked = parseSandboxNetwork(policy, 'sandbox network');
  return checked.mode === 'restricted'
    ? { denyOut: [ALL_TRAFFIC], allowOut: [...checked.allowedDomains] }
    : { denyOut: [], allowOut: [ALL_TRAFFIC] };
}

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
      // SDK debug mode reports a successful kill without contacting the provider.
      debug: false,
    };
  }

  async start(
    provider: SandboxProvider,
    context: { readonly metadata: Readonly<Record<string, string>>; readonly publicPreviewEnabled?: boolean;
      readonly networkPolicy: SandboxNetworkPolicy; readonly lifecycle?: SandboxLifecycle },
  ): Promise<RunningSandbox> {
    const rules = networkRules(context.networkPolicy);
    await context.lifecycle?.beforeCreate();
    const desktop = provider.desktop !== undefined;
    const sandbox = await Sandbox.create(provider.template, {
      ...this.#connection(),
      // The provider's timeout is also what was reserved against the user's
      // allowance, so the machine must not outlive it.
      timeoutMs: provider.timeoutSeconds * 1000,
      metadata: { ...context.metadata },
      secure: true,
      // A desktop's stream has no password of its own: the only thing keeping it
      // private is that the sandbox is. So a desktop sandbox is never opened to
      // public traffic, whatever the project asked for.
      network: { ...rules, allowPublicTraffic: !desktop && context.publicPreviewEnabled === true },
      // Anything the agent launches on its own, a browser above all, needs to
      // know which screen to draw on.
      ...(desktop ? { envs: { DISPLAY: desktopDisplay } } : {}),
    });
    const running = new E2BSandbox(sandbox, this.#maxOutputBytes);

    // The template decides what exists on disk and the registry decides where we
    // work, and nothing guarantees the two agree — E2B's stock template has no
    // project directory at all. Without this the agent spends its first few
    // steps discovering that every command fails on a missing cwd, which is real
    // money and a user watching an empty screen.
    try {
      await context.lifecycle?.created(running);
      await sandbox.commands.run('mkdir -p -- "$LOTUSBUILD_WORKDIR"', {
        envs: { LOTUSBUILD_WORKDIR: provider.workdir },
      });
    } catch (cause) {
      // The accounting owner has the handle, even if its identity write failed.
      if (context.lifecycle !== undefined) throw cause;
      try { await sandbox.kill(); }
      catch (cleanup) { throw new AggregateError([cause, cleanup], 'Sandbox preparation and cleanup failed.'); }
      throw cause;
    }

    return running;
  }

  async terminate(externalId: string): Promise<boolean> {
    return Sandbox.kill(externalId, this.#connection());
  }

  async connect(externalId: string): Promise<RunningSandbox | undefined> {
    try {
      const before = await Sandbox.getInfo(externalId, this.#connection());
      // Do not auto-resume paused VMs or silently buy the SDK's default five
      // minutes. Request the minimum, then verify the original lifetime remained.
      if (before.state !== 'running' || before.endAt.getTime() <= Date.now() + 1000) {
        throw new Error('Preserved sandbox is not available for bounded reconnection.');
      }
      const sandbox = await Sandbox.connect(externalId, { ...this.#connection(), timeoutMs: 1000 });
      const after = await sandbox.getInfo();
      if (after.startedAt.getTime() !== before.startedAt.getTime() || after.endAt.getTime() !== before.endAt.getTime()) {
        throw new Error('Preserved sandbox lifetime changed during reconnection.');
      }
      return new E2BSandbox(sandbox, this.#maxOutputBytes, true);
    } catch (error) {
      if (error instanceof SandboxNotFoundError) return undefined;
      throw new Error('Preserved sandbox reconnection is unconfirmed; salvage remains required.');
    }
  }
}

class E2BSandbox implements RunningSandbox {
  readonly #sandbox: Sandbox;
  readonly #maxOutputBytes: number;
  readonly #commands = new Set<CommandHandle>();
  readonly #commandListeners = new Map<CommandHandle, () => void>();
  #unknownCommand = false;
  #recovered: boolean;

  constructor(sandbox: Sandbox, maxOutputBytes: number, recovered = false) {
    this.#sandbox = sandbox;
    this.#maxOutputBytes = maxOutputBytes;
    this.#recovered = recovered;
  }

  get externalId(): string {
    return this.#sandbox.sandboxId;
  }

  async runCommand(
    command: string,
    options: {
      readonly signal?: AbortSignal | undefined;
      readonly cwd: string;
      readonly timeoutMs: number;
      readonly background?: boolean;
      readonly envs?: Readonly<Record<string, string>>;
    },
  ): Promise<CommandOutcome> {
    options.signal?.throwIfAborted();
    if (options.signal !== undefined) return this.#runCancellable(command, options, options.signal);
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

  async #killCommand(handle: CommandHandle): Promise<void> {
    const killed = await handle.kill();
    if (typeof killed !== 'boolean') throw new Error('Command termination is unconfirmed.');
    this.#commands.delete(handle);
    this.#commandListeners.get(handle)?.();
    this.#commandListeners.delete(handle);
    await handle.disconnect();
  }

  async stopCommands(): Promise<void> {
    if (this.#recovered) {
      // The old process-local handles are gone. Enumerate only envd-managed
      // commands, not arbitrary guest/system processes, before taking a snapshot.
      try {
        const commands = await this.#sandbox.commands.list();
        const stopped = await Promise.allSettled(commands.map(async ({ pid }) => {
          if (typeof await this.#sandbox.commands.kill(pid) !== 'boolean') throw new Error('Unconfirmed command stop.');
        }));
        if (stopped.some((result) => result.status === 'rejected') || (await this.#sandbox.commands.list()).length !== 0) {
          throw new Error('Unconfirmed command quiescence.');
        }
        this.#recovered = false;
      } catch { throw new Error('Preserved workspace could not be quiesced; salvage remains required.'); }
    }
    const results = await Promise.allSettled([...this.#commands].map((handle) => this.#killCommand(handle)));
    if (this.#unknownCommand || results.some((result) => result.status === 'rejected')) {
      throw new Error('Sandbox command activity is uncertain; resource recovery is required.');
    }
  }

  async #runCancellable(command: string, options: { cwd: string; timeoutMs: number; background?: boolean; envs?: Readonly<Record<string, string>> }, signal: AbortSignal): Promise<CommandOutcome> {
    let handle: CommandHandle;
    try {
      // A handle is needed: aborting the SDK request alone does not kill the PID.
      handle = await this.#sandbox.commands.run(command, {
        cwd: options.cwd, timeoutMs: options.timeoutMs, background: true, signal,
        ...(options.envs === undefined ? {} : { envs: { ...options.envs } }),
        onStdout: outputLimiter(this.#maxOutputBytes), onStderr: outputLimiter(this.#maxOutputBytes),
      });
    } catch {
      this.#unknownCommand = true;
      throw new Error('Command dispatch outcome is uncertain; sandbox recovery is required.');
    }
    this.#commands.add(handle);
    let stopping: Promise<void> | undefined;
    const stop = () => {
      stopping ??= this.#killCommand(handle);
      // The awaited path below reports failure; never leave an event rejection detached.
      void stopping.catch(() => {});
    };
    signal.addEventListener('abort', stop, { once: true });
    this.#commandListeners.set(handle, () => signal.removeEventListener('abort', stop));
    if (signal.aborted) stop();
    try {
      if (options.background === true && !signal.aborted) {
        await handle.disconnect();
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      try {
        const result = await handle.wait();
        this.#commands.delete(handle);
        return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        if (!(error instanceof CommandExitError)) throw error;
        this.#commands.delete(handle);
        return { exitCode: error.exitCode, stdout: error.stdout, stderr: error.stderr };
      }
    } finally {
      if (options.background !== true || signal.aborted) {
        signal.removeEventListener('abort', stop);
        this.#commandListeners.delete(handle);
      }
      if (stopping !== undefined) {
        try { await stopping; }
        catch { throw new Error('Command cancellation was requested but termination is unconfirmed.'); }
      }
      signal.throwIfAborted();
    }
  }

  async projectFileOperation(root: string, request: Readonly<Record<string, unknown>>, timeoutMs: number, signal?: AbortSignal): Promise<CommandOutcome> {
    return this.runCommand('python3 -I -c "$LOTUSBUILD_FILE_HELPER"', {
      cwd: '/', timeoutMs, signal, envs: {
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

  async readBytes(path: string, maxBytes: number): Promise<Buffer> {
    return readBoundedBytes(await this.#sandbox.files.read(path, { format: 'stream' }), maxBytes);
  }

  previewUrl(port: number): string {
    return `https://${this.#sandbox.getHost(port)}`;
  }

  /**
   * Brings up a virtual screen, a desktop session, and a view-only VNC stream
   * that noVNC serves on a private port.
   *
   * View-only is decided here, at the VNC server, because it is the only place a
   * viewer cannot get around: the agent's own clicks and typing go through
   * `xdotool`, not through VNC, so they are unaffected. There is no VNC password
   * because the port is only reachable with the sandbox's traffic token, which
   * the browser never sees.
   */
  async startDesktop(settings: DesktopSettings, signal?: AbortSignal): Promise<DesktopEndpoint> {
    const { width, height } = settings;
    // These are interpolated into a shell command below. The registry is trusted,
    // but a value that is not a plain size must never reach a shell.
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
      throw new Error('The desktop size is not a valid integer size.');
    }
    const token = this.#sandbox.trafficAccessToken;
    if (token === undefined || token === '') {
      throw new Error('The sandbox has no traffic access token, so its desktop cannot be reached privately.');
    }
    const sandbox = this.#sandbox;
    const inBackground = async (command: string, envs?: Record<string, string>): Promise<void> => {
      const handle = await sandbox.commands.run(command, { background: true, timeoutMs: 0, ...(envs === undefined ? {} : { envs }) });
      await handle.disconnect();
    };
    // Polls a shell check until it succeeds. A non-zero exit means "not yet";
    // anything else, such as a dead sandbox, is a real failure.
    const waitUntil = async (check: string, attempts: number, what: string): Promise<void> => {
      for (let attempt = 0; attempt < attempts; attempt++) {
        signal?.throwIfAborted();
        try {
          await sandbox.commands.run(check, { timeoutMs: 10_000 });
          return;
        } catch (error) {
          if (!(error instanceof CommandExitError)) throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error(`${what} did not become ready.`);
    };

    signal?.throwIfAborted();
    await inBackground(`Xvfb ${desktopDisplay} -ac -screen 0 ${width}x${height}x24 -retro -dpi 96 -nolisten tcp -nolisten unix`);
    await waitUntil(`xdpyinfo -display ${desktopDisplay}`, 40, 'The virtual screen');
    await inBackground('startxfce4', { DISPLAY: desktopDisplay });
    await waitUntil('pgrep -x xfce4-session >/dev/null && pgrep -x xfwm4 >/dev/null && pgrep -x xfdesktop >/dev/null', 120, 'The desktop session');
    signal?.throwIfAborted();
    await sandbox.commands.run(
      `x11vnc -bg -display ${desktopDisplay} -forever -wait 50 -shared -viewonly -rfbport 5900 2>/tmp/x11vnc.log`,
      { timeoutMs: 30_000 },
    );
    await inBackground(`cd /opt/noVNC/utils && ./novnc_proxy --vnc localhost:5900 --listen ${desktopStreamPort} --web /opt/noVNC > /tmp/novnc.log 2>&1`);
    await waitUntil(`ss -ltn | grep -q ":${desktopStreamPort}"`, 40, 'The desktop stream');
    return { host: sandbox.getHost(desktopStreamPort), token };
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

  async forkForValidation(timeoutMs: number, networkPolicy: SandboxNetworkPolicy, lifecycle?: SandboxLifecycle): Promise<RunningSandbox> {
    const rules = networkRules(networkPolicy);
    // Apply current plan restrictions before copying running processes. The
    // provider must preserve network containment across the fork; verify this
    // with the deployed provider as well as setting the child's policy below.
    await this.#sandbox.updateNetwork(rules);
    await lifecycle?.beforeCreate();
    const results = await this.#sandbox.fork({ count: 1, timeoutMs });
    const fork = results[0];
    if (results.length !== 1 || fork === undefined) throw new Error('The provider returned no validation sandbox.');
    if (fork instanceof Error) throw fork;
    const running = new E2BSandbox(fork, this.#maxOutputBytes);
    try {
      await lifecycle?.created(running);
      await fork.updateNetwork(rules);
    }
    catch (cause) {
      if (lifecycle !== undefined) throw cause;
      try { await fork.kill(); }
      catch (cleanup) { throw new AggregateError([cause, cleanup], 'Validation network policy and cleanup failed.'); }
      throw cause;
    }
    return running;
  }
}
