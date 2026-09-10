import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

import { redisKeyPrefixes } from '../redis/client.ts';
import { subscriptionStatuses } from './schema.ts';
import type { Subscription } from './service.ts';

/**
 * A cached answer. `subscription: null` means "checked, and this user has none"
 * — most users, and the case worth caching hardest. Distinguishing that from a
 * cache miss is the whole point of the wrapper: without it, every free user
 * re-reads Firestore on every request.
 */
export interface CachedSubscription {
  readonly subscription: Subscription | null;
}

interface Wire {
  readonly planKey: string;
  readonly status: string;
  readonly currentPeriodStart: string;
  readonly currentPeriodEnd: string;
}

// The token lives in the cache key itself, so invalidation, expiry and Redis
// loss all revoke it. Compare and replace atomically; never recreate a lost fill.
const completeFill = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1
`;
const fillPrefix = 'filling:';

/**
 * Holds each user's subscription lookup for a short window.
 *
 * Entitlements are consulted on nearly every authenticated request, and without
 * this each one costs a billed Firestore read. The TTL is the staleness budget:
 * a plan change takes effect within it, and anything needing to be immediate
 * calls `invalidate`.
 */
export class SubscriptionCache {
  readonly #redis: Redis;
  readonly #ttlSeconds: number;

  constructor(redis: Redis, ttlSeconds: number) {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new Error(`The subscription cache TTL must be a positive integer, got ${ttlSeconds}.`);
    }
    this.#redis = redis;
    this.#ttlSeconds = ttlSeconds;
  }

  #key(uid: string): string {
    return `${redisKeyPrefixes.subscription}${uid}`;
  }

  async read(uid: string): Promise<CachedSubscription | undefined> {
    const raw = await this.#redis.get(this.#key(uid));
    if (raw === null || raw.startsWith(fillPrefix)) {
      return undefined;
    }
    if (raw === 'none') {
      return { subscription: null };
    }

    let wire: Wire;
    try {
      wire = JSON.parse(raw) as Wire;
    } catch {
      // A malformed entry is a cache problem, never a reason to deny a paying
      // customer: drop it and let the caller read the real thing.
      await this.#redis.del(this.#key(uid));
      return undefined;
    }

    const start = new Date(wire.currentPeriodStart);
    const end = new Date(wire.currentPeriodEnd);
    const statusIsKnown = (subscriptionStatuses as readonly string[]).includes(wire.status);

    if (
      typeof wire.planKey !== 'string' ||
      !statusIsKnown ||
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime())
    ) {
      await this.#redis.del(this.#key(uid));
      return undefined;
    }

    return {
      subscription: {
        planKey: wire.planKey,
        status: wire.status as Subscription['status'],
        currentPeriodStart: start,
        currentPeriodEnd: end,
      },
    };
  }

  /** Acquire before reading Firestore. Other readers may read without filling. */
  async beginFill(uid: string): Promise<string | undefined> {
    const token = `${fillPrefix}${randomUUID()}`;
    const result = await this.#redis.set(this.#key(uid), token, 'EX', this.#ttlSeconds, 'NX');
    if (result !== 'OK' && result !== null) throw new Error('Unexpected subscription cache fill response.');
    return result === 'OK' ? token : undefined;
  }

  async write(uid: string, subscription: Subscription | null, token: string): Promise<void> {
    const payload =
      subscription === null
        ? 'none'
        : JSON.stringify({
            planKey: subscription.planKey,
            status: subscription.status,
            currentPeriodStart: subscription.currentPeriodStart.toISOString(),
            currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
          } satisfies Wire);

    const result = await this.#redis.eval(completeFill, 1, this.#key(uid), token, payload, this.#ttlSeconds);
    if (result !== 0 && result !== 1) throw new Error('Unexpected subscription cache write response.');
  }

  /** Call when a subscription changes and the change must be visible at once. */
  async invalidate(uid: string): Promise<void> {
    await this.#redis.del(this.#key(uid));
  }
}
