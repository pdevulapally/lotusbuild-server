import { Redis } from 'ioredis';

import { EnvironmentError } from '../config/env.ts';
import type { SharedConfig } from '../config/index.ts';

/**
 * Connects to Redis, proving it before the process is allowed to serve.
 *
 * Two defaults are deliberately overridden:
 *
 * `enableOfflineQueue: false` — ioredis normally buffers commands while
 * disconnected and replays them on reconnect. That turns an outage into
 * unbounded memory growth and a burst of stale writes, and hides the failure
 * from the caller, who sees a slow request rather than an error.
 *
 * `maxRetriesPerRequest: 2` — a command against a dead server should fail in
 * milliseconds. The default retries until the connection returns, so a request
 * hangs for as long as the incident lasts.
 */
export async function connectRedis(
  config: SharedConfig,
  onError: (error: Error) => void,
  // Named so `CLIENT LIST` on the server says which process holds a connection.
  // Passed in rather than fixed here: the API and the runner both call this, and
  // a shared literal would have them both claim to be the API.
  connectionName: string,
): Promise<Redis> {
  const redis = new Redis(config.REDIS_URL.toString(), {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 2,
    connectTimeout: 5000,
    connectionName,
  });

  // ioredis emits 'error' on every failed connection attempt, and an unheard
  // 'error' event on an EventEmitter takes the process down. A reconnect blip
  // must be reported, not fatal: commands fail on their own because the offline
  // queue is disabled, so the caller already learns about it.
  // Redis AUTH errors can carry command.args, including the password.
  redis.on('error', () => onError(new Error('REDIS_URL connection error.')));

  try {
    await redis.connect();
  } catch {
    throw new EnvironmentError([
      'REDIS_URL could not establish a connection; check reachability and authentication.',
    ]);
  }

  let pong: string;
  try { pong = await redis.ping(); }
  catch { throw new EnvironmentError(['REDIS_URL readiness check failed.']); }
  if (pong !== 'PONG') {
    throw new EnvironmentError(['REDIS_URL returned an unexpected PING response.']);
  }

  return redis;
}

/**
 * Redis holds only state that is in flight or reconstructible — rate-limit
 * counters, cached subscriptions, and later the live event stream. It is
 * deliberately not the system of record, so losing it fails work in progress
 * rather than losing anything a user owns.
 *
 * Keys are namespaced so a shared server, or a stray FLUSHDB scoped by prefix,
 * cannot confuse one concern with another.
 */
export const redisKeyPrefixes = {
  rateLimit: 'rl:',
  subscription: 'sub:',
  /** Doubles as the pub/sub channel name; channels are not part of the keyspace. */
  sessionEvents: 'ev:',
  /** Stripe event ids already handled, so a redelivery is not applied twice. */
  stripeEvent: 'evt:',
  /** Single-use, hashed tickets that let a browser open the desktop WebSocket. */
  desktopTicket: 'dkt:',
  /** Where a running desktop is, handed from the runner to the API's relay. Holds a bearer token. */
  desktopHandoff: 'dkh:',
  /** Short-lived hashed email verification codes, scoped to one Firebase uid. */
  emailVerification: 'emv:',
} as const;
