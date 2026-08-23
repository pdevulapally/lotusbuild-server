import { FieldValue, type Firestore, Timestamp, type Transaction } from 'firebase-admin/firestore';

import type { UserEntitlements } from '../entitlements/service.ts';
import type { ConfigurationStore } from '../entitlements/store.ts';
import { EntitlementConfigError } from '../entitlements/values.ts';
import { AppError } from '../http/errors.ts';
import { integerField, timestampField } from '../support/documents.ts';
import { usersCollectionPath } from '../users/repository.ts';
import { periodStartFor } from './periods.ts';

/** `users/{uid}/usage/{meterKey}` — one document per meter the user has touched. */
export const usageCollectionName = 'usage';

export interface Consumption {
  readonly meterKey: string;
  readonly consumed: number;
  readonly periodStart: Date;
}

/**
 * Records what a user has spent against their plan's meters.
 *
 * The one method here consumes a quantity that is already known — a build has
 * started, and that is one build whatever happens next. Meters whose cost is
 * only known afterwards (sandbox seconds, model tokens) need reserve-then-settle
 * instead, which lands with the code that actually spends them; writing it now
 * would be guessing at an interface with no caller to shape it.
 */
export class MeteringService {
  readonly #firestore: Firestore;
  readonly #configuration: ConfigurationStore;

  constructor(firestore: Firestore, configuration: ConfigurationStore) {
    this.#firestore = firestore;
    this.#configuration = configuration;
  }

  #ref(uid: string, meterKey: string) {
    return this.#firestore.doc(`${usersCollectionPath}/${uid}/${usageCollectionName}/${meterKey}`);
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
    if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) {
      throw new Error(
        `A metered quantity must be a positive integer, got ${input.quantity} for ` +
          `"${input.meterKey}".`,
      );
    }

    const { registry } = await this.#configuration.get();
    const meter = registry.meters.get(input.meterKey);
    if (meter === undefined) {
      throw new EntitlementConfigError(
        `Meter "${input.meterKey}" is not declared in the registry, so it cannot be charged.`,
      );
    }
    if (meter.kind !== 'COUNTER') {
      // A gauge measures how much of something is held right now — concurrent
      // sandboxes, bytes stored. Adding to it permanently would burn a slot that
      // is never returned, and the user would run out of sandboxes for good.
      throw new EntitlementConfigError(
        `Meter "${meter.key}" is a ${meter.kind}, which is held and released rather than ` +
          'consumed. Charging it would never be given back.',
      );
    }

    const limit = input.entitlements.meterLimits.get(input.meterKey);
    if (limit === undefined) {
      // Absent means unlimited if we let it, which is the one reading a paid
      // limit must never have.
      throw new EntitlementConfigError(
        `Plan "${input.entitlements.planKey}" declares no limit for "${meter.key}", so it would ` +
          'be spent unmetered.',
      );
    }

    const ref = this.#ref(input.uid, input.meterKey);
    const snapshot = await transaction.get(ref);
    const periodStart = periodStartFor(meter, input.now);

    // A stored window that is not the current one has already expired, so what
    // it recorded is spent history rather than part of this allowance.
    const stored = snapshot.exists ? snapshot.data() ?? {} : undefined;
    const consumed =
      stored === undefined ||
      timestampField(stored, 'periodStart', ref.path).getTime() !== periodStart.getTime()
        ? 0
        : integerField(stored, 'consumed', ref.path, { min: 0 });

    const after = consumed + input.quantity;
    if (after > limit.hardLimit) {
      throw new AppError({
        code: 'usage/limit-reached',
        // The remedy is a bigger plan, not a retry — 402 says that, where a 403
        // would read as "you are not allowed to do this at all".
        statusCode: 402,
        message:
          `The ${input.entitlements.planName} plan allows ${limit.hardLimit} ${meter.unit} of ` +
          `${meter.label}, and ${consumed} ${meter.unit} of that is used.`,
        details: {
          meterKey: meter.key,
          unit: meter.unit,
          label: meter.label,
          limit: limit.hardLimit,
          consumed,
          requested: input.quantity,
          resetPeriod: meter.resetPeriod,
          periodStart: periodStart.toISOString(),
          plan: input.entitlements.planKey,
        },
      });
    }

    transaction.set(ref, {
      meterKey: meter.key,
      consumed: after,
      periodStart: Timestamp.fromDate(periodStart),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return { meterKey: meter.key, consumed: after, periodStart };
  }
}
