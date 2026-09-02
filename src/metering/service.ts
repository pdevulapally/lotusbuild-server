import {
  type DocumentReference,
  type DocumentSnapshot,
  FieldValue,
  type Firestore,
  Timestamp,
  type Transaction,
} from 'firebase-admin/firestore';

import type { MeterDefinition, MeterLimit } from '../entitlements/schema.ts';
import type { UserEntitlements } from '../entitlements/service.ts';
import type { ConfigurationStore } from '../entitlements/store.ts';
import { EntitlementConfigError } from '../entitlements/values.ts';
import { AppError } from '../http/errors.ts';
import { enumField, integerField, stringField, timestampField } from '../support/documents.ts';
import { usersCollectionPath } from '../users/repository.ts';
import { periodStartFor } from './periods.ts';

/** `users/{uid}/usage/{meterKey}` — one document per meter the user has touched. */
export const usageCollectionName = 'usage';
/** `users/{uid}/reservations/{id}` — one document per hold, open or closed. */
export const reservationsCollectionName = 'reservations';

export const reservationStatuses = ['OPEN', 'SETTLED', 'RELEASED'] as const;
export type ReservationStatus = (typeof reservationStatuses)[number];

export interface Consumption {
  readonly meterKey: string;
  readonly consumed: number;
  readonly periodStart: Date;
}

export interface Reservation {
  readonly id: string;
  readonly meterKey: string;
  readonly estimatedQuantity: number;
  readonly status: ReservationStatus;
  /** What the hold is for — a session id — so an orphan can be explained. */
  readonly operationId: string;
}

export interface MeterUsageSummary {
  readonly meterKey: string;
  readonly unit: string;
  readonly label: string;
  readonly kind: MeterDefinition['kind'];
  readonly resetPeriod: MeterDefinition['resetPeriod'];
  readonly consumed: number;
  readonly reserved: number;
  readonly includedAllowance: number;
  readonly hardLimit: number;
  readonly overageEnabled: boolean;
  readonly periodStart: Date;
}


/**
 * Passing a limit is not one failure. A counter is a quota already spent, and
 * the remedy is a bigger plan. A gauge is a ceiling being stood on right now,
 * and the remedy is to wait for something else to finish.
 */
const exceededStatus: Readonly<Record<MeterDefinition['kind'], number>> = {
  COUNTER: 402,
  GAUGE: 409,
};

/** What a usage document says about the window being charged. */
interface UsageState {
  readonly consumed: number;
  readonly reserved: number;
}

interface CloseOutcome {
  readonly status: ReservationStatus;
  readonly settledQuantity?: number;
}

/**
 * Records what a user has spent against their plan's meters.
 *
 * Two shapes of charge, because there are two shapes of cost. A build has
 * started, and that is one build whatever happens next, so it is consumed
 * outright. A sandbox will run for somewhere between a second and its whole
 * timeout, so its maximum is reserved before it starts and settled to the real
 * figure when it stops — reserving the maximum is what makes overspend
 * structurally impossible rather than merely unlikely.
 */
export class MeteringService {
  readonly #firestore: Firestore;
  readonly #configuration: ConfigurationStore;

  constructor(firestore: Firestore, configuration: ConfigurationStore) {
    this.#firestore = firestore;
    this.#configuration = configuration;
  }

  #usageRef(uid: string, meterKey: string): DocumentReference {
    return this.#firestore.doc(`${usersCollectionPath}/${uid}/${usageCollectionName}/${meterKey}`);
  }

  #reservationRef(uid: string, reservationId: string): DocumentReference {
    return this.#firestore.doc(
      `${usersCollectionPath}/${uid}/${reservationsCollectionName}/${reservationId}`,
    );
  }

  /** The meter and the plan's limit for it, or a config error naming which is wrong. */
  async #resolve(
    entitlements: UserEntitlements,
    meterKey: string,
  ): Promise<{ meter: MeterDefinition; limit: MeterLimit }> {
    const { registry } = await this.#configuration.get();
    const meter = registry.meters.get(meterKey);
    if (meter === undefined) {
      throw new EntitlementConfigError(
        `Meter "${meterKey}" is not declared in the registry, so it cannot be charged.`,
      );
    }
    const limit = entitlements.meterLimits.get(meterKey);
    if (limit === undefined) {
      // Absent would mean unlimited if we let it, which is the one reading a
      // paid limit must never have.
      throw new EntitlementConfigError(
        `Plan "${entitlements.planKey}" declares no limit for "${meter.key}", so it would be ` +
          'spent unmetered.',
      );
    }
    return { meter, limit };
  }

  /**
   * What the usage document holds for the window being charged.
   *
   * Consumption is window-scoped: a figure recorded before the window rolled
   * over is spent history, not part of this allowance. Reservations are not — a
   * hold taken before the boundary is still holding real capacity after it, and
   * zeroing it would hand the same capacity out twice.
   */
  #state(snapshot: DocumentSnapshot, periodStart: Date, path: string): UsageState {
    if (!snapshot.exists) {
      return { consumed: 0, reserved: 0 };
    }
    const fields = snapshot.data() ?? {};
    const storedWindow = timestampField(fields, 'periodStart', path);
    return {
      consumed:
        storedWindow.getTime() === periodStart.getTime()
          ? integerField(fields, 'consumed', path, { min: 0 })
          : 0,
      reserved: integerField(fields, 'reserved', path, { min: 0 }),
    };
  }

  #exceeded(
    entitlements: UserEntitlements,
    meter: MeterDefinition,
    limit: MeterLimit,
    state: UsageState,
    requested: number,
    periodStart: Date,
  ): AppError {
    return new AppError({
      code: 'usage/limit-reached',
      statusCode: exceededStatus[meter.kind],
      message:
        `The ${entitlements.planName} plan allows ${limit.hardLimit} ${meter.unit} of ` +
        `${meter.label}, and ${state.consumed + state.reserved} ${meter.unit} of that is ` +
        'already used or held.',
      details: {
        meterKey: meter.key,
        unit: meter.unit,
        label: meter.label,
        kind: meter.kind,
        limit: limit.hardLimit,
        consumed: state.consumed,
        reserved: state.reserved,
        requested,
        resetPeriod: meter.resetPeriod,
        periodStart: periodStart.toISOString(),
        plan: entitlements.planKey,
      },
    });
  }

  #assertPositive(quantity: number, meterKey: string): void {
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw new Error(
        `A metered quantity must be a positive integer, got ${quantity} for "${meterKey}".`,
      );
    }
  }

  /**
   * Charges a meter inside the caller's transaction, refusing if the plan's hard
   * limit would be passed.
   *
   * It takes a transaction rather than owning one so the thing being paid for
   * and the payment commit together. Charging first and creating second leaves a
   * user billed for a session that failed to exist; creating first and charging
   * second hands out the resource for free when the charge is refused.
   */
  async consumeIn(
    transaction: Transaction,
    input: {
      readonly uid: string;
      readonly entitlements: UserEntitlements;
      readonly meterKey: string;
      readonly quantity: number;
      readonly now: Date;
    },
  ): Promise<Consumption> {
    this.#assertPositive(input.quantity, input.meterKey);
    const { meter, limit } = await this.#resolve(input.entitlements, input.meterKey);
    if (meter.kind !== 'COUNTER') {
      // A gauge measures how much of something is held right now — concurrent
      // sandboxes, bytes stored. Adding to it permanently would burn a slot that
      // is never returned, and the user would run out of sandboxes for good.
      throw new EntitlementConfigError(
        `Meter "${meter.key}" is a ${meter.kind}, which is held and released rather than ` +
          'consumed. Charging it would never be given back.',
      );
    }

    const ref = this.#usageRef(input.uid, input.meterKey);
    const snapshot = await transaction.get(ref);
    const periodStart = periodStartFor(meter, input.now);
    const state = this.#state(snapshot, periodStart, ref.path);

    const after = state.consumed + input.quantity;
    // Held capacity counts against the same ceiling: a reservation is capacity
    // already promised to something else.
    if (after + state.reserved > limit.hardLimit) {
      throw this.#exceeded(input.entitlements, meter, limit, state, input.quantity, periodStart);
    }

    transaction.set(ref, {
      meterKey: meter.key,
      consumed: after,
      reserved: state.reserved,
      periodStart: Timestamp.fromDate(periodStart),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return { meterKey: meter.key, consumed: after, periodStart };
  }

  /**
   * Decrements a counter meter inside the caller's transaction, e.g. when an unstarted
   * operation is cancelled before claiming any runner time.
   */
  async refundIn(
    transaction: Transaction,
    input: {
      readonly uid: string;
      readonly entitlements: UserEntitlements;
      readonly meterKey: string;
      readonly quantity: number;
      readonly now: Date;
    },
  ): Promise<Consumption> {
    this.#assertPositive(input.quantity, input.meterKey);
    const { meter } = await this.#resolve(input.entitlements, input.meterKey);
    if (meter.kind !== 'COUNTER') {
      throw new EntitlementConfigError(
        `Meter "${meter.key}" is a ${meter.kind}, which is released rather than refunded.`,
      );
    }

    const ref = this.#usageRef(input.uid, input.meterKey);
    const snapshot = await transaction.get(ref);
    const periodStart = periodStartFor(meter, input.now);
    const state = this.#state(snapshot, periodStart, ref.path);

    const after = Math.max(0, state.consumed - input.quantity);

    transaction.set(ref, {
      meterKey: meter.key,
      consumed: after,
      reserved: state.reserved,
      periodStart: Timestamp.fromDate(periodStart),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return { meterKey: meter.key, consumed: after, periodStart };
  }

  /**
   * Reads the current usage summary across all declared meters for a user.
   */
  async readUsageBreakdown(
    uid: string,
    entitlements: UserEntitlements,
    now: Date = new Date(),
  ): Promise<readonly MeterUsageSummary[]> {
    const { registry } = await this.#configuration.get();
    const summaries: MeterUsageSummary[] = [];

    for (const [meterKey, meter] of registry.meters) {
      const limit = entitlements.meterLimits.get(meterKey);
      if (limit === undefined) {
        continue;
      }

      const ref = this.#usageRef(uid, meterKey);
      const snapshot = await ref.get();
      const periodStart = periodStartFor(meter, now);
      const state = this.#state(snapshot, periodStart, ref.path);

      summaries.push({
        meterKey: meter.key,
        unit: meter.unit,
        label: meter.label,
        kind: meter.kind,
        resetPeriod: meter.resetPeriod,
        consumed: state.consumed,
        reserved: state.reserved,
        includedAllowance: limit.includedAllowance,
        hardLimit: limit.hardLimit,
        overageEnabled: limit.overageEnabled,
        periodStart,
      });
    }

    return summaries;
  }


  /**
   * Moves a gauge to a new reading, inside the caller's transaction.
   *
   * A gauge is not spent, it is occupied — bytes stored, sandboxes running — so
   * it is set rather than added to. The caller passes what this one contributor
   * held before as well as what it holds now, because the meter counts every
   * contributor together: a project growing from 10MB to 12MB must move the
   * user's total by two, not by twelve. Reading the old figure in the same
   * transaction that writes the new one is what keeps the two from drifting.
   */
  async setGaugeIn(
    transaction: Transaction,
    input: {
      readonly uid: string;
      readonly entitlements: UserEntitlements;
      readonly meterKey: string;
      readonly previousQuantity: number;
      readonly quantity: number;
      readonly now: Date;
    },
  ): Promise<number> {
    for (const [name, value] of [
      ['previousQuantity', input.previousQuantity],
      ['quantity', input.quantity],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(
          `A gauge ${name} must be a non-negative integer, got ${value} for "${input.meterKey}".`,
        );
      }
    }

    const { meter, limit } = await this.#resolve(input.entitlements, input.meterKey);
    if (meter.kind !== 'GAUGE') {
      throw new EntitlementConfigError(
        `Meter "${meter.key}" is a ${meter.kind}, which is spent rather than occupied. Setting ` +
          'it would silently discard what has already been charged to it.',
      );
    }

    const ref = this.#usageRef(input.uid, input.meterKey);
    const snapshot = await transaction.get(ref);
    const periodStart = periodStartFor(meter, input.now);
    const state = this.#state(snapshot, periodStart, ref.path);

    const total = state.consumed - input.previousQuantity + input.quantity;
    if (total < 0) {
      // The contributor claims to have held more than the meter ever recorded.
      // Carrying on would hand back capacity that was never taken.
      throw new Error(
        `Usage for ${input.uid}/${meter.key} reads ${state.consumed} but a contributor claims to ` +
          `have held ${input.previousQuantity}.`,
      );
    }
    if (total + state.reserved > limit.hardLimit) {
      throw this.#exceeded(input.entitlements, meter, limit, state, input.quantity, periodStart);
    }

    transaction.set(ref, {
      meterKey: meter.key,
      consumed: total,
      reserved: state.reserved,
      periodStart: Timestamp.fromDate(periodStart),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return total;
  }

  /** `setGaugeIn` for callers with nothing else to commit alongside it. */
  async setGauge(input: {
    readonly uid: string;
    readonly entitlements: UserEntitlements;
    readonly meterKey: string;
    readonly previousQuantity: number;
    readonly quantity: number;
    readonly now: Date;
  }): Promise<number> {
    return this.#firestore.runTransaction((transaction) => this.setGaugeIn(transaction, input));
  }

  /** `consumeIn` for callers with nothing else to commit alongside it. */
  async consume(input: {
    readonly uid: string;
    readonly entitlements: UserEntitlements;
    readonly meterKey: string;
    readonly quantity: number;
    readonly now: Date;
  }): Promise<Consumption> {
    return this.#firestore.runTransaction((transaction) => this.consumeIn(transaction, input));
  }

  /**
   * Holds capacity that will be spent, before spending it.
   *
   * The estimate must be the most the operation could possibly use. Reserving
   * less and settling more would let a plan be overspent by exactly the amount
   * nobody predicted, which is the amount that matters.
   */
  async reserveIn(
    transaction: Transaction,
    input: {
      readonly uid: string;
      readonly entitlements: UserEntitlements;
      readonly meterKey: string;
      readonly quantity: number;
      readonly operationId: string;
      readonly now: Date;
    },
  ): Promise<Reservation> {
    this.#assertPositive(input.quantity, input.meterKey);
    const { meter, limit } = await this.#resolve(input.entitlements, input.meterKey);

    const usageRef = this.#usageRef(input.uid, input.meterKey);
    // Firestore generates this locally, so the id exists before anything is
    // written and a caller can commit it alongside its own record of the hold.
    const reservationRef = this.#firestore
      .collection(`${usersCollectionPath}/${input.uid}/${reservationsCollectionName}`)
      .doc();

    const snapshot = await transaction.get(usageRef);
    const periodStart = periodStartFor(meter, input.now);
    const state = this.#state(snapshot, periodStart, usageRef.path);

    if (state.consumed + state.reserved + input.quantity > limit.hardLimit) {
      throw this.#exceeded(input.entitlements, meter, limit, state, input.quantity, periodStart);
    }

    transaction.set(usageRef, {
      meterKey: meter.key,
      consumed: state.consumed,
      reserved: state.reserved + input.quantity,
      periodStart: Timestamp.fromDate(periodStart),
      updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.create(reservationRef, {
      meterKey: meter.key,
      estimatedQuantity: input.quantity,
      status: 'OPEN',
      operationId: input.operationId,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return {
      id: reservationRef.id,
      meterKey: meter.key,
      estimatedQuantity: input.quantity,
      status: 'OPEN',
      operationId: input.operationId,
    };
  }

  /** `reserveIn` for callers with nothing else to commit alongside it. */
  async reserve(input: {
    readonly uid: string;
    readonly entitlements: UserEntitlements;
    readonly meterKey: string;
    readonly quantity: number;
    readonly operationId: string;
    readonly now: Date;
  }): Promise<Reservation> {
    return this.#firestore.runTransaction((transaction) => this.reserveIn(transaction, input));
  }

  /**
   * Gives back several holds at once, inside a transaction the caller owns.
   *
   * Batched rather than offered one at a time because Firestore forbids reading
   * after writing: closing holds one by one would read the second reservation
   * after the first had already written the usage document. Every reservation
   * and every affected meter is therefore read first, and each meter is written
   * once carrying the whole decrement.
   *
   * A hold that is already SETTLED or RELEASED is skipped without touching the
   * ledger, which is what makes running this against holds somebody else closed
   * a no-op rather than a second accounting event. Returns the ids it released.
   */
  async releaseIn(
    transaction: Transaction,
    uid: string,
    reservationIds: readonly string[],
    now: Date,
  ): Promise<readonly string[]> {
    const { registry } = await this.#configuration.get();

    const open: {
      readonly ref: DocumentReference;
      readonly id: string;
      readonly meter: MeterDefinition;
      readonly quantity: number;
    }[] = [];
    for (const reservationId of reservationIds) {
      const ref = this.#reservationRef(uid, reservationId);
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) {
        throw new Error(`No reservation ${reservationId} for ${uid}.`);
      }
      const fields = snapshot.data() ?? {};
      if (enumField(fields, 'status', ref.path, reservationStatuses) !== 'OPEN') {
        continue;
      }
      const meterKey = stringField(fields, 'meterKey', ref.path);
      const meter = registry.meters.get(meterKey);
      if (meter === undefined) {
        throw new EntitlementConfigError(
          `Reservation ${reservationId} is on meter "${meterKey}", which the registry no longer ` +
            'declares, so the hold cannot be returned to it.',
        );
      }
      open.push({
        ref,
        id: reservationId,
        meter,
        quantity: integerField(fields, 'estimatedQuantity', ref.path, { min: 1 }),
      });
    }

    const byMeter = new Map<string, { readonly meter: MeterDefinition; readonly total: number }>();
    for (const entry of open) {
      const running = byMeter.get(entry.meter.key);
      byMeter.set(entry.meter.key, {
        meter: entry.meter,
        total: (running === undefined ? 0 : running.total) + entry.quantity,
      });
    }

    const pending: {
      readonly ref: DocumentReference;
      readonly meter: MeterDefinition;
      readonly state: UsageState;
      readonly total: number;
      readonly periodStart: Date;
    }[] = [];
    for (const { meter, total } of byMeter.values()) {
      const usageRef = this.#usageRef(uid, meter.key);
      const snapshot = await transaction.get(usageRef);
      const periodStart = periodStartFor(meter, now);
      const state = this.#state(snapshot, periodStart, usageRef.path);
      if (state.reserved < total) {
        // Not a limit problem: the ledger disagrees with itself, and carrying on
        // would silently invent capacity.
        throw new Error(
          `Usage for ${uid}/${meter.key} holds ${state.reserved} but the reservations being ` +
            `released claim ${total}.`,
        );
      }
      pending.push({ ref: usageRef, meter, state, total, periodStart });
    }

    for (const entry of pending) {
      transaction.set(entry.ref, {
        meterKey: entry.meter.key,
        consumed: entry.state.consumed,
        reserved: entry.state.reserved - entry.total,
        periodStart: Timestamp.fromDate(entry.periodStart),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    for (const entry of open) {
      transaction.update(entry.ref, {
        status: 'RELEASED',
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    return open.map((entry) => entry.id);
  }

  /**
   * Closes a hold at what it actually cost. The hold is returned and the real
   * figure charged in one transaction, so the two can never disagree.
   *
   * Only counters can be settled: settling a gauge would leave its consumption
   * permanently raised, so the slot would be paid for and never handed back.
   */
  async settle(input: {
    readonly uid: string;
    readonly reservationId: string;
    readonly actualQuantity: number;
    readonly now: Date;
  }): Promise<boolean> {
    return this.#close(
      input.uid,
      input.reservationId,
      input.now,
      (meter, estimatedQuantity, transaction, usageRef, state, periodStart) => {
        if (meter.kind !== 'COUNTER') {
          throw new EntitlementConfigError(
            `Reservation ${input.reservationId} is on the ${meter.kind} meter "${meter.key}", ` +
              'which is released rather than settled.',
          );
        }
        if (
          !Number.isSafeInteger(input.actualQuantity) ||
          input.actualQuantity < 0 ||
          input.actualQuantity > estimatedQuantity
        ) {
          throw new Error(
            `Reservation ${input.reservationId} held ${estimatedQuantity} ${meter.unit} and ` +
              `cannot settle at ${input.actualQuantity}.`,
          );
        }

        transaction.set(usageRef, {
          meterKey: meter.key,
          consumed: state.consumed + input.actualQuantity,
          reserved: state.reserved - estimatedQuantity,
          periodStart: Timestamp.fromDate(periodStart),
          updatedAt: FieldValue.serverTimestamp(),
        });
        return { status: 'SETTLED', settledQuantity: input.actualQuantity };
      },
    );
  }

  /**
   * Gives a hold back unspent — the operation never happened, or the meter is a
   * gauge and the thing it counted has stopped.
   *
   * Returns false when the reservation was already closed. The caller cleaning
   * up after a dead runner cannot know whether it finished first, and making
   * that a failure would turn ordinary recovery into an error to investigate.
   */
  async release(uid: string, reservationId: string, now: Date = new Date()): Promise<boolean> {
    return this.#close(
      uid,
      reservationId,
      now,
      (meter, estimatedQuantity, transaction, usageRef, state, periodStart) => {
        transaction.set(usageRef, {
          meterKey: meter.key,
          consumed: state.consumed,
          reserved: state.reserved - estimatedQuantity,
          periodStart: Timestamp.fromDate(periodStart),
          updatedAt: FieldValue.serverTimestamp(),
        });
        return { status: 'RELEASED' };
      },
    );
  }

  /**
   * The half that settling and releasing share: find the open hold, prove the
   * ledger agrees with it, let the caller decide where the quantity goes, and
   * close it. Whatever the caller writes commits with the status change.
   */
  async #close(
    uid: string,
    reservationId: string,
    now: Date,
    apply: (
      meter: MeterDefinition,
      estimatedQuantity: number,
      transaction: Transaction,
      usageRef: DocumentReference,
      state: UsageState,
      periodStart: Date,
    ) => CloseOutcome,
  ): Promise<boolean> {
    const reservationRef = this.#reservationRef(uid, reservationId);
    const { registry } = await this.#configuration.get();

    return this.#firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reservationRef);
      if (!snapshot.exists) {
        throw new Error(`No reservation ${reservationId} for ${uid}.`);
      }
      const fields = snapshot.data() ?? {};
      if (enumField(fields, 'status', reservationRef.path, reservationStatuses) !== 'OPEN') {
        return false;
      }

      const meterKey = stringField(fields, 'meterKey', reservationRef.path);
      const meter = registry.meters.get(meterKey);
      if (meter === undefined) {
        throw new EntitlementConfigError(
          `Reservation ${reservationId} is on meter "${meterKey}", which the registry no longer ` +
            'declares, so the hold cannot be returned to it.',
        );
      }
      const estimatedQuantity = integerField(fields, 'estimatedQuantity', reservationRef.path, {
        min: 1,
      });

      const usageRef = this.#usageRef(uid, meterKey);
      const usage = await transaction.get(usageRef);
      const periodStart = periodStartFor(meter, now);
      const state = this.#state(usage, periodStart, usageRef.path);

      if (state.reserved < estimatedQuantity) {
        // Not a limit problem: the ledger disagrees with itself, and carrying on
        // would silently invent capacity.
        throw new Error(
          `Usage for ${uid}/${meterKey} holds ${state.reserved} but reservation ` +
            `${reservationId} claims ${estimatedQuantity}.`,
        );
      }

      const outcome = apply(meter, estimatedQuantity, transaction, usageRef, state, periodStart);
      transaction.update(reservationRef, {
        status: outcome.status,
        ...(outcome.settledQuantity === undefined
          ? {}
          : { settledQuantity: outcome.settledQuantity }),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return true;
    });
  }
}
