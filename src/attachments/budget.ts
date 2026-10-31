import type { Redis } from 'ioredis';

import type { RateLimit } from '../entitlements/schema.ts';
import { AppError } from '../http/errors.ts';
import { redisKeyPrefixes } from '../redis/client.ts';
import { maxAttachmentBytes, maxAttachmentsPerMessage } from './store.ts';

/** How many images, and how many bytes, one account may upload per window. */
export interface UploadBudget {
  readonly windowSeconds: number;
  readonly maxUploads: number;
  readonly maxBytes: number;
}

/**
 * Derived from the plan's `build` rate limit rather than a new registry field:
 * a user can attach up to four images to every build they are allowed to start,
 * and in bytes roughly half of them at the maximum size. Plans with more builds
 * get more uploads without anyone editing a second table.
 */
export function uploadBudgetFor(build: RateLimit): UploadBudget {
  const maxUploads = build.maxRequests * maxAttachmentsPerMessage;
  return { windowSeconds: build.windowSeconds, maxUploads, maxBytes: Math.ceil((maxUploads * maxAttachmentBytes) / 2) };
}

export interface BudgetCounter {
  /** Adds one upload of `bytes` to the window; returns the totals after adding. */
  consume(key: string, bytes: number, windowSeconds: number): Promise<{ uploads: number; bytes: number; ttlSeconds: number }>;
  /** Gives back a reservation whose upload was refused. */
  release(key: string, bytes: number): Promise<void>;
}

// One round trip, atomic: the two counters and their expiry move together.
const consumeScript = `
local uploads = redis.call('HINCRBY', KEYS[1], 'uploads', 1)
local bytes = redis.call('HINCRBY', KEYS[1], 'bytes', ARGV[1])
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then redis.call('EXPIRE', KEYS[1], ARGV[2]) ttl = tonumber(ARGV[2]) end
return { uploads, bytes, ttl }
`;

export class RedisBudgetCounter implements BudgetCounter {
  readonly #redis: Redis;
  constructor(redis: Redis) { this.#redis = redis; }

  async consume(key: string, bytes: number, windowSeconds: number) {
    const result = await this.#redis.eval(consumeScript, 1, key, String(bytes), String(windowSeconds)) as [number, number, number];
    return { uploads: Number(result[0]), bytes: Number(result[1]), ttlSeconds: Number(result[2]) };
  }

  async release(key: string, bytes: number) {
    await this.#redis.multi().hincrby(key, 'uploads', -1).hincrby(key, 'bytes', -bytes).exec();
  }
}

export class UploadBudgetGuard {
  readonly #counter: BudgetCounter;
  constructor(counter: BudgetCounter) { this.#counter = counter; }

  /** Reserves this upload against the owner's window, or refuses it with a retry hint. */
  async reserve(ownerUid: string, bytes: number, budget: UploadBudget): Promise<() => Promise<void>> {
    const key = `${redisKeyPrefixes.rateLimit}upload:${ownerUid}`;
    const totals = await this.#counter.consume(key, bytes, budget.windowSeconds);
    if (totals.uploads > budget.maxUploads || totals.bytes > budget.maxBytes) {
      await this.#counter.release(key, bytes);
      const retryAfterSeconds = Math.max(1, totals.ttlSeconds);
      throw new AppError({
        code: 'attachment/budget-exceeded',
        statusCode: 429,
        message: `Image upload limit reached. Retry in ${retryAfterSeconds}s.`,
        details: { limit: budget.maxUploads, maxBytes: budget.maxBytes, windowSeconds: budget.windowSeconds, retryAfterSeconds },
      });
    }
    return () => this.#counter.release(key, bytes);
  }
}
