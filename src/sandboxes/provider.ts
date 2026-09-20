import type { DesktopSettings, SandboxNetworkPolicy, SandboxProvider } from '../entitlements/schema.ts';
import { AppError } from '../http/errors.ts';

export interface CommandOutcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Acquisition accounting must run before dispatch and before post-create preparation. */
export interface SandboxLifecycle {
  beforeCreate(): Promise<void>;
  created(sandbox: RunningSandbox): Promise<void>;
}

/**
 * Where a running desktop can be reached and the credential for it: everything
 * the relay needs and nothing the browser is ever given.
 */
export interface DesktopEndpoint {
  readonly host: string;
  readonly token: string;
}

/**
 * A sandbox that is up, as the agent's tools need it.
 *
 * Narrow on purpose. Everything here is something a tool actually calls, so a
 * second provider has a short list to satisfy rather than a vendor's whole API
 * to imitate.
 */
export interface RunningSandbox {
  projectFileOperation?(root: string, request: Readonly<Record<string, unknown>>, timeoutMs: number, signal?: AbortSignal): Promise<CommandOutcome>;
  /** The provider's own id, recorded so an orphan can be found and killed. */
  readonly externalId: string;
  runCommand(
    command: string,
    options: {
      readonly signal?: AbortSignal | undefined;
      readonly cwd: string;
      readonly timeoutMs: number;
      readonly background?: boolean;
      /**
       * Values the command reads as environment variables. Anything that is not
       * ours to trust — a commit message, a signed URL, a configured identity —
       * travels this way rather than being pasted into the command string,
       * where quoting it correctly is the only thing between us and the shell
       * running it.
       */
      readonly envs?: Readonly<Record<string, string>>;
    },
  ): Promise<CommandOutcome>;
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
  /** A file's bytes, for one that is not text. Refuses a file over `maxBytes` rather than truncating it. */
  readBytes?(path: string, maxBytes: number): Promise<Buffer>;
  readFileRange?(path: string, offset: number, limit: number, timeoutMs: number): Promise<{ text: string; start: number; total: number }>;
  /** Public URL a port inside the sandbox is reachable on. */
  previewUrl(port: number): string;
  /**
   * Starts a screen, a desktop session and a view-only stream inside this
   * sandbox, and says where it can be reached privately. Absent on a provider
   * that has no desktop to offer. Throws if the desktop did not come up.
   */
  startDesktop?(settings: DesktopSettings, signal?: AbortSignal): Promise<DesktopEndpoint>;
  stop(): Promise<void>;
  /** Stops tracked command activity before a cleanup snapshot. Throws if uncertain. */
  stopCommands?(): Promise<void>;
  lifetime?(): Promise<{ startedAt: Date; endAt: Date }>;
  /** Provider VM copy. Never implemented as a second directory in the same VM. */
  forkForValidation?(timeoutMs: number, networkPolicy: SandboxNetworkPolicy, lifecycle?: SandboxLifecycle): Promise<RunningSandbox>;
}

export interface SandboxAdapter {
  /** True: killed; false: confirmed absent. Unknown outcomes must throw; never resume. */
  terminate?(externalId: string): Promise<boolean>;
  start(
    provider: SandboxProvider,
    context: { readonly metadata: Readonly<Record<string, string>>; readonly publicPreviewEnabled?: boolean;
      readonly networkPolicy: SandboxNetworkPolicy; readonly lifecycle?: SandboxLifecycle },
  ): Promise<RunningSandbox>;
  /** Reconnects to an existing sandbox, so a successor can shut an orphan down. */
  /** Undefined means provider-confirmed absence; other failures must throw. */
  connect(externalId: string): Promise<RunningSandbox | undefined>;
}

/**
 * Picks the adapter for a provider the registry named.
 *
 * The lookup is the whole selection rule: which provider serves which platform
 * is configuration, and adding one is a new entry in this map plus a row in the
 * registry. A provider with no adapter is reported as unimplemented rather than
 * quietly substituted — a mobile build must not silently become a web one.
 */
export function adapterFor(
  adapters: ReadonlyMap<string, SandboxAdapter>,
  provider: SandboxProvider,
): SandboxAdapter {
  const adapter = adapters.get(provider.provider);
  if (adapter === undefined) {
    throw new AppError({
      code: 'sandbox/provider-unavailable',
      statusCode: 501,
      message:
        `${provider.platform} builds are configured to run on the "${provider.provider}" ` +
        'provider, which this deployment cannot start.',
      details: {
        platform: provider.platform,
        provider: provider.provider,
        available: [...adapters.keys()],
      },
    });
  }
  return adapter;
}
