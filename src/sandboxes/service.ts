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
  }): Promise<AcquiredSandbox> {
    const { registry } = await this.#configuration.get();
    const provider = await this.providerFor(input.platform);
    // Resolved before anything is reserved: a provider with no adapter must fail
    // before it costs the user a hold.
    const adapter = adapterFor(this.#adapters, provider);

    const held: Reservation[] = [];
    try {
      for (const [meterKey, quantity] of [
        [provider.concurrencyMeterKey, 1],
        [registry.sandboxTimeMeterKey, provider.timeoutSeconds],
      ] as const) {
        held.push(
          await this.#metering.reserve({
            uid: input.uid,
            entitlements: input.entitlements,
            meterKey,
            quantity,
            operationId: input.sessionId,
            now: input.now,
          }),
        );
      }

      const running = await adapter.start(provider, {
        // Enough to find the machine from the provider's own console when
        // something is stuck, without putting anything private on it.
        metadata: { sessionId: input.sessionId, platform: provider.platform },
      });

      return { running, provider, reservations: held, startedAt: new Date() };
    } catch (error) {
      for (const reservation of held) {
        await this.#metering.release(input.uid, reservation.id, input.now);
      }
      throw error;
    }
  }

  /**
   * Stops the machine and closes its holds at what it actually cost.
   *
   * The sandbox is stopped first but a failure to stop does not prevent the
   * accounting: a machine we cannot reach still stops charging when its own
   * timeout expires, whereas a hold nobody returns is a slot the user loses for
   * good.
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
      }
    }

    const { registry } = await this.#configuration.get();
    // Rounded up: a sandbox that lived for part of a second still occupied one.
    const elapsedSeconds = Math.max(
      1,
      Math.ceil((input.now.getTime() - input.acquired.startedAt.getTime()) / 1000),
    );

    for (const reservation of input.acquired.reservations) {
      // Which verb closes a hold follows from what the meter measures, not from
      // its name: time was spent and is settled, a gauge slot was occupied and
      // is handed back.
      if (reservation.meterKey === registry.sandboxTimeMeterKey) {
        await this.#metering.settle({
          uid: input.uid,
          reservationId: reservation.id,
          // Never more than was held: the machine cannot outlive its own timeout,
          // and if the clock says otherwise the reservation is the honest figure.
          actualQuantity: Math.min(elapsedSeconds, reservation.estimatedQuantity),
          now: input.now,
        });
        continue;
      }
      await this.#metering.release(input.uid, reservation.id, input.now);
    }
  }

  /**
   * Cleans up after a runner that died holding a session.
   *
   * Called by whoever inherits the expired lease. Both halves are best effort
   * and reported rather than thrown: the successor's job is to build, and
   * refusing to work because a corpse could not be tidied would turn one dead
   * runner into a session nobody can ever pick up.
   */
  async recover(input: {
    readonly uid: string;
    readonly platform: Platform;
    readonly externalSandboxId: string | undefined;
    readonly reservationIds: readonly string[];
    readonly now: Date;
    readonly onProblem: (error: Error, what: string) => void;
  }): Promise<void> {
    if (input.externalSandboxId !== undefined) {
      try {
        const provider = await this.providerFor(input.platform);
        const adapter = adapterFor(this.#adapters, provider);
        await (await adapter.connect(input.externalSandboxId)).stop();
      } catch (cause) {
        input.onProblem(
          cause instanceof Error ? cause : new Error(String(cause)),
          `stopping orphaned sandbox ${input.externalSandboxId}`,
        );
      }
    }

    for (const reservationId of input.reservationIds) {
      try {
        await this.#metering.release(input.uid, reservationId, input.now);
      } catch (cause) {
        input.onProblem(
          cause instanceof Error ? cause : new Error(String(cause)),
          `releasing orphaned reservation ${reservationId}`,
        );
      }
    }
  }
}
