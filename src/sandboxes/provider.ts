import type { SandboxProvider } from '../entitlements/schema.ts';
import { AppError } from '../http/errors.ts';

export interface CommandOutcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * A sandbox that is up, as the agent's tools need it.
 *
 * Narrow on purpose. Everything here is something a tool actually calls, so a
 * second provider has a short list to satisfy rather than a vendor's whole API
 * to imitate.
 */
export interface RunningSandbox {
  /** The provider's own id, recorded so an orphan can be found and killed. */
  readonly externalId: string;
  runCommand(
    command: string,
    options: { readonly cwd: string; readonly timeoutMs: number; readonly background?: boolean },
  ): Promise<CommandOutcome>;
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
  /** Public URL a port inside the sandbox is reachable on. */
  previewUrl(port: number): string;
  stop(): Promise<void>;
}

export interface SandboxAdapter {
  start(
    provider: SandboxProvider,
    context: { readonly metadata: Readonly<Record<string, string>> },
  ): Promise<RunningSandbox>;
  /** Reconnects to an existing sandbox, so a successor can shut an orphan down. */
  connect(externalId: string): Promise<RunningSandbox>;
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
