import { FieldValue, type Firestore, Timestamp } from 'firebase-admin/firestore';
import { randomUUID } from 'node:crypto';

import { subscriptionsCollectionPath } from '../entitlements/service.ts';
import type { SubscriptionCache } from '../entitlements/subscription-cache.ts';
import { stringField, timestampField } from '../support/documents.ts';
import { AppError } from '../http/errors.ts';
import { usersCollectionPath } from '../users/repository.ts';
import type { StripeSubscriptionState } from './stripe.ts';

/** `stripeCustomers/{customerId}` — which account a Stripe customer belongs to. */
export const stripeCustomersCollectionPath = 'stripeCustomers';

// Longer than the bounded Stripe API operation; expiry enables crash recovery.
const processingLeaseMs = 5 * 60 * 1000;
export type EventClaim = { readonly kind: 'completed' } | { readonly kind: 'claimed'; readonly token: string };
export interface CheckoutOperation {
  readonly id: string;
  readonly planKey: string;
  readonly priceId: string;
  readonly expiresAt: number;
}

function busy(): AppError {
  return new AppError({ code: 'billing/processing', statusCode: 503,
    message: 'A billing operation is still processing. Retry shortly.' });
}

export class BillingRepository {
  readonly #firestore: Firestore;
  readonly #cache: SubscriptionCache;
  readonly #eventRetentionSeconds: number;

  constructor(
    firestore: Firestore,
    cache: SubscriptionCache,
    eventRetentionSeconds: number,
  ) {
    if (!Number.isSafeInteger(eventRetentionSeconds) || eventRetentionSeconds <= 0) {
      throw new Error('The webhook replay window must be a positive number of seconds.');
    }
    this.#firestore = firestore;
    this.#cache = cache;
    this.#eventRetentionSeconds = eventRetentionSeconds;
  }

  /** Only completed events are acknowledged as duplicates. A live claim must be retried. */
  async claimEvent(eventId: string): Promise<EventClaim> {
    const ref = this.#firestore.doc(`stripeEvents/${eventId}`);
    const token = randomUUID();
    return this.#firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (snapshot.exists) {
        const fields = snapshot.data() ?? {};
        if (fields['status'] === 'COMPLETED') return { kind: 'completed' as const };
        if (timestampField(fields, 'leaseUntil', ref.path).getTime() > Date.now()) throw busy();
      }
      tx.set(ref, { status: 'PROCESSING', token,
        leaseUntil: Timestamp.fromMillis(Date.now() + processingLeaseMs) });
      return { kind: 'claimed' as const, token };
    });
  }

  async completeEvent(eventId: string, token: string): Promise<void> {
    const ref = this.#firestore.doc(`stripeEvents/${eventId}`);
    await this.#firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      const fields = snapshot.data() ?? {};
      if (fields['token'] !== token || timestampField(fields, 'leaseUntil', ref.path).getTime() <= Date.now()) throw busy();
      tx.set(ref, { status: 'COMPLETED', completedAt: FieldValue.serverTimestamp(),
        expiresAt: Timestamp.fromMillis(Date.now() + this.#eventRetentionSeconds * 1000) });
    });
  }

  async releaseEvent(eventId: string, token: string): Promise<void> {
    const ref = this.#firestore.doc(`stripeEvents/${eventId}`);
    await this.#firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (snapshot.data()?.['token'] === token) tx.delete(ref);
    });
  }

  async uidForCustomer(customerId: string): Promise<string | undefined> {
    const ref = this.#firestore.doc(`${stripeCustomersCollectionPath}/${customerId}`);
    const snapshot = await ref.get();
    return snapshot.exists ? stringField(snapshot.data() ?? {}, 'uid', ref.path) : undefined;
  }

  /** Records the mapping both ways, so either side can find the other. */
  async linkCustomer(uid: string, customerId: string): Promise<void> {
    await this.#firestore.runTransaction(async (transaction) => {
      const child = await transaction.get(this.#firestore.doc(`familyLinks/${uid}`));
      const erasure = await transaction.get(this.#firestore.doc(`accountErasures/${uid}`));
      if (child.exists || erasure.exists) throw new AppError({ code: 'billing/account-restricted', statusCode: 403, message: 'This account cannot manage billing.' });
      transaction.set(this.#firestore.doc(`${stripeCustomersCollectionPath}/${customerId}`), {
        uid,
        createdAt: FieldValue.serverTimestamp(),
      });
      transaction.update(this.#firestore.doc(`${usersCollectionPath}/${uid}`), {
        stripeCustomerId: customerId,
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
  }

  async customerIdFor(uid: string): Promise<string | undefined> {
    const ref = this.#firestore.doc(`${usersCollectionPath}/${uid}`);
    const snapshot = await ref.get();
    const value = (snapshot.data() ?? {})['stripeCustomerId'];
    return typeof value === 'string' && value !== '' ? value : undefined;
  }

  /**
   * Serialize authoritative Stripe reads per account. Event snapshots/timestamps
   * are never applied: even a delayed deletion reads the customer's current state.
   * The token and expiry fence a process that resumes after its lease was taken.
   */
  async synchronizeSubscription(uid: string, read: () => Promise<StripeSubscriptionState | null>): Promise<void> {
    const lock = this.#firestore.doc(`billingSynchronization/${uid}`);
    const token = randomUUID();
    await this.#firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(lock);
      if (snapshot.exists && timestampField(snapshot.data() ?? {}, 'leaseUntil', lock.path).getTime() > Date.now()) throw busy();
      tx.set(lock, { token, leaseUntil: Timestamp.fromMillis(Date.now() + processingLeaseMs) });
    });
    try {
      const state = await read();
      await this.#firestore.runTransaction(async (tx) => {
        const snapshot = await tx.get(lock);
        const fields = snapshot.data() ?? {};
        if (fields['token'] !== token || timestampField(fields, 'leaseUntil', lock.path).getTime() <= Date.now()) throw busy();
        const ref = this.#firestore.doc(`${subscriptionsCollectionPath}/${uid}`);
        if (state === null) tx.delete(ref);
        else tx.set(ref, {
          planKey: state.planKey, status: state.status, stripeCustomerId: state.customerId,
          currentPeriodStart: Timestamp.fromDate(state.currentPeriodStart),
          currentPeriodEnd: Timestamp.fromDate(state.currentPeriodEnd), updatedAt: FieldValue.serverTimestamp(),
        });
        tx.delete(lock);
      });
      await this.#cache.invalidate(uid);
    } catch (cause) {
      try {
        await this.#firestore.runTransaction(async (tx) => {
          const snapshot = await tx.get(lock);
          if (snapshot.data()?.['token'] === token) tx.delete(lock);
        });
      } catch (cleanup) {
        throw new AggregateError([cause, cleanup], 'Subscription synchronization and lease cleanup failed.');
      }
      throw cause;
    }
  }

  /** Persist request parameters before Stripe, so retries use one checkout and price. */
  async checkoutOperation(uid: string, planKey: string, priceId: string): Promise<CheckoutOperation> {
    const ref = this.#firestore.doc(`billingCheckouts/${uid}`);
    return this.#firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (snapshot.exists) {
        const fields = snapshot.data() ?? {};
        const expiresAt = timestampField(fields, 'expiresAt', ref.path).getTime() / 1000;
        if (expiresAt > Date.now() / 1000) {
          const storedPlan = stringField(fields, 'planKey', ref.path);
          if (storedPlan !== planKey) throw new AppError({ code: 'billing/checkout-pending', statusCode: 409,
            message: 'A checkout for another plan is still open. Complete it or wait for it to expire.' });
          return { id: stringField(fields, 'id', ref.path), planKey: storedPlan,
            priceId: stringField(fields, 'priceId', ref.path), expiresAt };
        }
      }
      // Stripe permits checkout lifetimes from 30 minutes to 24 hours. An hour
      // leaves the minimum creation margin after transaction/API retries.
      const operation = { id: randomUUID(), planKey, priceId, expiresAt: Math.floor(Date.now() / 1000) + 3600 };
      tx.set(ref, { ...operation, expiresAt: Timestamp.fromMillis(operation.expiresAt * 1000) });
      return operation;
    });
  }
}
