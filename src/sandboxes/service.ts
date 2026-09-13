import type { Platform, SandboxProvider } from '../entitlements/schema.ts';
import type { UserEntitlements } from '../entitlements/service.ts';
import type { ConfigurationStore } from '../entitlements/store.ts';
import { AppError } from '../http/errors.ts';
import type { MeteringService, Reservation } from '../metering/service.ts';
import { type RunningSandbox, type SandboxAdapter, type SandboxLifecycle, adapterFor } from './provider.ts';

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
   * preparation fails, known termination releases capacity; unknown provider
   * outcomes and unknown runtime usage retain their durable holds.
   */
  async acquire(input: {
    readonly signal?: AbortSignal;
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
    const { registry, plans } = await this.#configuration.get();
    const plan = plans.get(input.entitlements.planKey);
    if (plan === undefined) throw new Error('The sandbox plan is not configured.');
    const provider = await this.providerFor(input.platform);
    // Resolved before anything is reserved: a provider with no adapter must fail
    // before it costs the user a hold.
    const adapter = adapterFor(this.#adapters, provider);
    if (adapter.terminate === undefined) throw new Error('Provider termination without resuming is unavailable.');
    if (input.source !== undefined && input.source.forkForValidation === undefined) {
      throw new Error('This sandbox provider cannot create an isolated validation copy.');
    }

    const held: Reservation[] = [];
    let dispatched = false;
    let created: RunningSandbox | undefined;
    let identityRecorded = false;
    const lifecycle: SandboxLifecycle = {
      beforeCreate: async () => {
        input.signal?.throwIfAborted();
        await this.#metering.markInFlight(input.uid, held.map((hold) => hold.id));
        input.signal?.throwIfAborted();
        dispatched = true;
      },
      created: async (running) => {
        created = running;
        await this.#metering.recordSandbox(input.uid, held.map((hold) => hold.id), {
          externalId: running.externalId, platform: provider.platform,
        });
        identityRecorded = true;
        input.signal?.throwIfAborted();
      },
    };
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

      const running = input.source === undefined ? await adapter.start(provider, {
        // Enough to find the machine from the provider's own console when
        // something is stuck, without putting anything private on it.
        metadata: { sessionId: input.sessionId, platform: provider.platform },
        publicPreviewEnabled: input.publicPreviewEnabled === true,
        networkPolicy: plan.sandboxNetwork,
        lifecycle,
      }) : await input.source.forkForValidation!(provider.timeoutSeconds * 1000, plan.sandboxNetwork, lifecycle);

      if (!dispatched || created !== running || !identityRecorded) {
        created = running;
        identityRecorded = false;
        throw new Error('Sandbox adapter did not complete acquisition accounting.');
      }
      if (running.lifetime === undefined) throw new Error('The provider does not expose authoritative sandbox lifetime metadata.');
      const lifetime = await running.lifetime();
      await this.#metering.recordSandbox(input.uid, held.map((hold) => hold.id), {
        externalId: running.externalId, platform: provider.platform, ...lifetime,
      });
      return { running, provider, reservations: held, startedAt: lifetime.startedAt };
    } catch (cause) {
      const ids = held.map((hold) => hold.id);
      if (created !== undefined) {
        try {
          await this.#stopAndReconcile(input.uid, adapter, created.externalId, ids,
            identityRecorded ? undefined : provider.platform);
        } catch (cleanup) {
          throw new AggregateError([cause, cleanup], `Sandbox preparation failed; ${cleanup instanceof Error ? cleanup.message : 'cleanup deferred'}`);
        }
        throw new AggregateError([cause], 'Sandbox preparation failed; termination confirmed; reservations reconciled.');
      }
      if (!dispatched) {
        try {
          await this.#metering.confirmSandboxNotCreated(input.uid, ids);
          await this.#reconcile(input.uid, ids);
        } catch (cleanup) { throw new AggregateError([cause, cleanup], 'Sandbox creation was not dispatched; reconciliation deferred.'); }
        throw cause;
      }
      throw new AggregateError([cause], 'Sandbox creation outcome unknown; reservations retained for reconciliation.');
    }
  }

  async #reconcile(uid: string, ids: readonly string[]): Promise<void> {
    const failures: unknown[] = [];
    // A runtime hold with unknown usage must not prevent releasing confirmed-free concurrency.
    for (const id of ids) {
      try { await this.#metering.reconcile(uid, id, new Date()); }
      catch (cause) { failures.push(cause); }
    }
    if (failures.length) throw new AggregateError(failures, 'Reservation reconciliation deferred.');
  }

  async #stopAndReconcile(uid: string, adapter: SandboxAdapter, externalId: string, ids: readonly string[], unregisteredPlatform?: string,
    onStopFailure?: (error: Error) => void): Promise<void> {
    let identityFailure: unknown;
    if (unregisteredPlatform !== undefined) {
      // Preserve the retry target even if the following termination call fails.
      try {
        await this.#metering.recordSandbox(uid, ids, { externalId, platform: unregisteredPlatform });
        unregisteredPlatform = undefined;
      } catch (cause) { identityFailure = cause; }
    }
    let terminated: boolean;
    try {
      if (adapter.terminate === undefined) throw new Error('Provider termination without resuming is unavailable.');
      terminated = await adapter.terminate(externalId);
      if (typeof terminated !== 'boolean') throw new Error('Provider returned no termination outcome.');
    } catch (cause) {
      const error = new AggregateError(identityFailure === undefined ? [cause] : [identityFailure, cause],
        'Termination uncertain; reservations retained.');
      onStopFailure?.(error);
      throw error;
    }
    const stoppedAt = terminated ? new Date() : undefined;
    try {
      // Retry an early identity write that failed or lost its acknowledgement.
      if (unregisteredPlatform !== undefined) await this.#metering.recordSandbox(uid, ids, { externalId, platform: unregisteredPlatform });
      await this.#metering.confirmSandboxStopped(uid, ids, externalId, stoppedAt);
      await this.#reconcile(uid, ids);
    } catch (cause) { throw new AggregateError([cause], 'Termination confirmed; reconciliation deferred.'); }
  }

  /**
   * Stops the machine and closes its holds at what it actually cost.
   *
   * Termination must succeed before capacity is released. A failed or ambiguous
   * stop preserves holds until provider evidence can resolve the lifetime.
   */
  async release(input: {
    readonly uid: string;
    readonly acquired: Pick<AcquiredSandbox, 'reservations' | 'startedAt' | 'provider'> & {
      readonly running?: RunningSandbox;
    };
    readonly now: Date;
    readonly onStopFailure: (error: Error) => void;
  }): Promise<void> {
    if (input.acquired.running === undefined) {
      throw new Error('Sandbox termination is unconfirmed; reservations remain held.');
    }
    const ids = input.acquired.reservations.map((hold) => hold.id);
    const adapter = adapterFor(this.#adapters, input.acquired.provider);
    await this.#stopAndReconcile(input.uid, adapter, input.acquired.running.externalId, ids, undefined, input.onStopFailure);
  }

  /**
   * Cleans up after a runner that died holding a session.
   *
   * Called by whoever inherits the expired lease. Unresolved usage preserves
   * the ledger and prevents new work until reconciliation succeeds.
   */
  async recover(input: {
    readonly salvageRequired?: boolean;
    readonly uid: string;
    readonly platform: Platform;
    readonly externalSandboxId: string | undefined;
    readonly reservationIds: readonly string[];
    readonly now: Date;
    readonly onProblem: (error: Error, what: string) => void;
  }): Promise<void> {
    if (input.salvageRequired === true) throw new Error('Workspace salvage must precede destructive sandbox recovery.');
    const provider = await this.providerFor(input.platform);
    const adapter = adapterFor(this.#adapters, provider);
    if (adapter.terminate === undefined) throw new Error('Provider termination without resuming is unavailable.');
    const groups = new Map<string, { ids: string[]; stopped: boolean }>();
    for (const id of input.reservationIds) {
      const fields = await this.#metering.reservationRecord(input.uid, id);
      if (fields['status'] !== 'OPEN') continue;
      const externalId = fields['sandboxExternalId'];
      if (typeof externalId === 'string') {
        const group = groups.get(externalId) ?? { ids: [], stopped: true };
        group.ids.push(id);
        group.stopped &&= fields['sandboxStopped'] === true;
        groups.set(externalId, group);
      }
    }
    if (input.externalSandboxId !== undefined && !groups.has(input.externalSandboxId)) {
      groups.set(input.externalSandboxId, { ids: [], stopped: false });
    }
    const failures: unknown[] = [];
    for (const [id, group] of groups) {
      try {
        const terminated = group.stopped ? false : await adapter.terminate(id);
        if (typeof terminated !== 'boolean') throw new Error('Provider returned no termination outcome.');
        // Already absent proves no concurrency, but not when billing stopped.
        await this.#metering.confirmSandboxStopped(input.uid, group.ids, id, terminated ? new Date() : undefined);
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

  /** Reuses the existing VM without creating another reservation or restoring old files. */
  async reconnectForSalvage(platform: Platform, externalId: string): Promise<RunningSandbox | undefined> {
    const provider = await this.providerFor(platform);
    return adapterFor(this.#adapters, provider).connect(externalId);
  }
}
