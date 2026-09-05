import type { Platform, SandboxProvider } from '../entitlements/schema.ts';
import type { UserEntitlements } from '../entitlements/service.ts';
import type { ConfigurationStore } from '../entitlements/store.ts';
import { AppError } from '../http/errors.ts';
import type { MeteringService, Reservation } from '../metering/service.ts';
import { type RunningSandbox, type SandboxAdapter, adapterFor } from './provider.ts';

export interface AcquiredSandbox {
  readonly running: RunningSandbox;
  readonly provider: SandboxProvider;
  readonly reservations: readonly Reservation[];
  readonly startedAt: Date;
}

/**
 * Starts and stops sandboxes with their cost accounted for.
 *
 * Two meters are held for the life of one sandbox: the concurrency gauge for
 * the platform, and the whole of the provider's timeout against sandbox time.
 * Reserving the full timeout up front is the point — it is the most the machine
 * could possibly cost, so a user can never start something they cannot pay for,
 * and the settle at the end gives back whatever it did not use.
 */
export class SandboxService {
  readonly #configuration: ConfigurationStore;
  readonly #metering: MeteringService;
  readonly #adapters: ReadonlyMap<string, SandboxAdapter>;

  constructor(
    configuration: ConfigurationStore,
    metering: MeteringService,
    adapters: ReadonlyMap<string, SandboxAdapter>,
  ) {
    this.#configuration = configuration;
    this.#metering = metering;
    this.#adapters = adapters;
  }

  async providerFor(platform: Platform): Promise<SandboxProvider> {
    const { registry } = await this.#configuration.get();
    const provider = registry.sandboxProviders.get(platform);
    if (provider === undefined) {
      throw new AppError({
        code: 'sandbox/platform-unconfigured',
        statusCode: 501,
        message: `No sandbox provider is configured for ${platform} projects.`,
        details: { platform, configured: [...registry.sandboxProviders.keys()] },
      });
    }
    return provider;
  }

  /**
   * Holds the capacity, then starts the machine.
   *
   * In that order, and never the other way: a sandbox started before its cost is
   * approved is already burning money by the time the plan refuses it. If
   * anything after the first hold fails, every hold taken here is given back
   * before the error leaves — a half-reserved failure would cost the user
   * capacity for a sandbox that never ran.
   */
  async acquire(input: {
    readonly uid: string;
    readonly entitlements: UserEntitlements;
    readonly platform: Platform;
    readonly sessionId: string;
    readonly now: Date;
    readonly reservations: {
      take(input: { meterKey: string; quantity: number; operationId: string }): Promise<Reservation>;
    };
    readonly source?: RunningSandbox;
    readonly publicPreviewEnabled?: boolean;
  }): Promise<AcquiredSandbox> {
    const { registry } = await this.#configuration.get();
    const provider = await this.providerFor(input.platform);
    // Resolved before anything is reserved: a provider with no adapter must fail
    // before it costs the user a hold.
    const adapter = adapterFor(this.#adapters, provider);
    if (input.source !== undefined && input.source.forkForValidation === undefined) {
      throw new Error('This sandbox provider cannot create an isolated validation copy.');
    }

    const held: Reservation[] = [];
    let dispatched = false;
    try {
      for (const [meterKey, quantity] of [
        [provider.concurrencyMeterKey, 1],
        [registry.sandboxTimeMeterKey, provider.timeoutSeconds],
      ] as const) {
        held.push(
          await input.reservations.take({
            meterKey,
            quantity,
            operationId: input.sessionId,
          }),
        );
      }

      dispatched = true;
      await this.#metering.markInFlight(input.uid, held.map((hold) => hold.id));
      const running = input.source === undefined ? await adapter.start(provider, {
        // Enough to find the machine from the provider's own console when
        // something is stuck, without putting anything private on it.
        metadata: { sessionId: input.sessionId, platform: provider.platform },
        publicPreviewEnabled: input.publicPreviewEnabled === true,
      }) : await input.source.forkForValidation!(provider.timeoutSeconds * 1000);

      try {
        if (running.lifetime === undefined) throw new Error('The provider does not expose authoritative sandbox lifetime metadata.');
        const lifetime = await running.lifetime();
        await this.#metering.recordSandbox(input.uid, held.map((hold) => hold.id), {
          externalId: running.externalId, platform: provider.platform, ...lifetime,
        });
        return { running, provider, reservations: held, startedAt: lifetime.startedAt };
      } catch (cause) {
        try { await running.stop(); }
        catch (cleanup) { throw new AggregateError([cause, cleanup], 'Sandbox registration and termination failed.'); }
        throw cause;
      }
    } catch (error) {
      if (!dispatched) for (const reservation of held) {
        await this.#metering.release(input.uid, reservation.id, input.now);
      }
      throw error;
    }
  }

  /**
   * Stops the machine and closes its holds at what it actually cost.
   *
   * Termination must succeed before capacity is released. A failed or ambiguous
   * stop preserves holds until provider evidence can resolve the lifetime.
   */
  async release(input: {
    readonly uid: string;
    readonly acquired: Pick<AcquiredSandbox, 'reservations' | 'startedAt'> & {
      readonly running?: RunningSandbox;
    };
    readonly now: Date;
    readonly onStopFailure: (error: Error) => void;
  }): Promise<void> {
    if (input.acquired.running !== undefined) {
      try {
        await input.acquired.running.stop();
      } catch (cause) {
        input.onStopFailure(cause instanceof Error ? cause : new Error(String(cause)));
        throw cause;
      }
    } else {
      throw new Error('Sandbox termination is unconfirmed; reservations remain held.');
    }
    const ids = input.acquired.reservations.map((hold) => hold.id);
    await this.#metering.confirmSandboxStopped(input.uid, ids, new Date());
    for (const id of ids) await this.#metering.reconcile(input.uid, id, new Date());
  }

  /**
   * Cleans up after a runner that died holding a session.
   *
   * Called by whoever inherits the expired lease. Unresolved usage preserves
   * the ledger and prevents new work until reconciliation succeeds.
   */
  async recover(input: {
    readonly uid: string;
    readonly platform: Platform;
    readonly externalSandboxId: string | undefined;
    readonly reservationIds: readonly string[];
    readonly now: Date;
    readonly onProblem: (error: Error, what: string) => void;
  }): Promise<void> {
    const provider = await this.providerFor(input.platform);
    const adapter = adapterFor(this.#adapters, provider);
    if (adapter.terminate === undefined) throw new Error('Provider termination without resuming is unavailable.');
    const groups = new Map<string, string[]>();
    for (const id of input.reservationIds) {
      const fields = await this.#metering.reservationRecord(input.uid, id);
      if (fields['status'] !== 'OPEN') continue;
      const externalId = fields['sandboxExternalId'];
      if (typeof externalId === 'string') {
        const group = groups.get(externalId) ?? [];
        group.push(id);
        groups.set(externalId, group);
      }
    }
    if (input.externalSandboxId !== undefined && !groups.has(input.externalSandboxId)) {
      groups.set(input.externalSandboxId, []);
    }
    const failures: unknown[] = [];
    for (const [id, holds] of groups) {
      try {
        const terminated = await adapter.terminate(id);
        // Already absent proves no concurrency, but not when billing stopped.
        await this.#metering.confirmSandboxStopped(input.uid, holds, terminated ? new Date() : undefined);
      } catch (cause) { failures.push(cause); }
    }
    for (const id of input.reservationIds) {
      try { await this.#metering.reconcile(input.uid, id, input.now); }
      catch (cause) { failures.push(cause); }
    }
    if (failures.length > 0) {
      const error = new AggregateError(failures, 'Recovery remains incomplete; resource records and unresolved usage are retained.');
      input.onProblem(error, 'recovering sandbox and usage reservations');
      throw error;
    }
  }
}
