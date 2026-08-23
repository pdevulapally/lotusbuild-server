import { FieldValue, type Firestore, Timestamp } from 'firebase-admin/firestore';
import type { Redis } from 'ioredis';

import { subscriptionsCollectionPath } from '../entitlements/service.ts';
import type { SubscriptionCache } from '../entitlements/subscription-cache.ts';
import { redisKeyPrefixes } from '../redis/client.ts';
import { countField, stringField } from '../support/documents.ts';
import { usersCollectionPath } from '../users/repository.ts';
import type { StripeSubscriptionState } from './stripe.ts';

/** `stripeCustomers/{customerId}` — which account a Stripe customer belongs to. */
export const stripeCustomersCollectionPath = 'stripeCustomers';

export class BillingRepository {
  readonly #firestore: Firestore;
  readonly #redis: Redis;
  readonly #cache: SubscriptionCache;
  readonly #eventRetentionSeconds: number;

  constructor(
    firestore: Firestore,
    redis: Redis,
    cache: SubscriptionCache,
    eventRetentionSeconds: number,
  ) {
    if (!Number.isSafeInteger(eventRetentionSeconds) || eventRetentionSeconds <= 0) {
      throw new Error('The webhook replay window must be a positive number of seconds.');
    }
    this.#firestore = firestore;
    this.#redis = redis;
    this.#cache = cache;
    this.#eventRetentionSeconds = eventRetentionSeconds;
  }

  /**
   * Claims a webhook event, returning false if it has already been handled.
   *
   * Stripe delivers at least once, so the same event arrives again after any
   * timeout — including one where we did the work and the acknowledgement was
   * lost. Redis is the right home for this: it is replay protection with a
   * horizon, not a record anybody needs to keep.
   */
  async claimEvent(eventId: string): Promise<boolean> {
    const claimed = await this.#redis.set(
      `${redisKeyPrefixes.stripeEvent}${eventId}`,
      '1',
      'EX',
      this.#eventRetentionSeconds,
      'NX',
    );
    return claimed === 'OK';
  }

  /** Releases the claim so a failed event is retried rather than swallowed. */
  async releaseEvent(eventId: string): Promise<void> {
    await this.#redis.del(`${redisKeyPrefixes.stripeEvent}${eventId}`);
  }

  async uidForCustomer(customerId: string): Promise<string | undefined> {
    const ref = this.#firestore.doc(`${stripeCustomersCollectionPath}/${customerId}`);
    const snapshot = await ref.get();
    return snapshot.exists ? stringField(snapshot.data() ?? {}, 'uid', ref.path) : undefined;
  }

  /** Records the mapping both ways, so either side can find the other. */
  async linkCustomer(uid: string, customerId: string): Promise<void> {
    await this.#firestore.runTransaction(async (transaction) => {
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
   * Writes what Stripe says the subscription now is.
   *
   * Fenced on the event's own timestamp. Stripe does not promise order, so an
   * upgrade and the cancellation that followed it can arrive the wrong way
   * round — and applying the older one last would leave a customer entitled to
   * something they no longer pay for, or cut off from something they do. An
   * event older than what is already recorded is dropped.
   */
  async applySubscription(input: {
    readonly uid: string;
    readonly state: StripeSubscriptionState;
    readonly eventCreatedAt: Date;
  }): Promise<'applied' | 'superseded'> {
    const ref = this.#firestore.doc(`${subscriptionsCollectionPath}/${input.uid}`);

    const outcome = await this.#firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const appliedAt = snapshot.exists
        ? countField(snapshot.data() ?? {}, 'eventCreatedAt', ref.path)
        : 0;
      const incoming = Math.floor(input.eventCreatedAt.getTime() / 1000);
      if (incoming < appliedAt) {
        return 'superseded' as const;
      }

      transaction.set(ref, {
        planKey: input.state.planKey,
        status: input.state.status,
        currentPeriodStart: Timestamp.fromDate(input.state.currentPeriodStart),
        currentPeriodEnd: Timestamp.fromDate(input.state.currentPeriodEnd),
        stripeCustomerId: input.state.customerId,
        // Seconds, matching the units Stripe stamps events with.
        eventCreatedAt: incoming,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return 'applied' as const;
    });

    if (outcome === 'applied') {
      // The cached copy would otherwise keep the old plan alive for its whole
      // TTL, which is the one moment a customer is watching for the change.
      await this.#cache.invalidate(input.uid);
    }
    return outcome;
  }

  /**
   * Forgets a subscription entirely, dropping the user back to the default plan.
   *
   * Used when Stripe deletes one. Keeping a CANCELED record would work too, but
   * absent is what the entitlement resolver already treats as "no subscription",
   * and one representation of that state is better than two.
   */
  async removeSubscription(uid: string): Promise<void> {
    await this.#firestore.doc(`${subscriptionsCollectionPath}/${uid}`).delete();
    await this.#cache.invalidate(uid);
  }
}
