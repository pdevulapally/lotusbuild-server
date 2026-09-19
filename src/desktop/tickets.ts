import { createHash, randomBytes } from 'node:crypto';

import type { Redis } from 'ioredis';

import { redisKeyPrefixes } from '../redis/client.ts';

/** What a ticket lets its holder do: watch one session's desktop, as one account. */
export interface DesktopGrant {
  readonly uid: string;
  readonly sessionId: string;
}

/** A browser WebSocket cannot send an Authorization header, so it presents this instead. */
export const desktopTicketTtlSeconds = 30;

/** 32 random bytes, base64url: 43 characters. Anything else is not a ticket. */
export const desktopTicketPattern = /^[A-Za-z0-9_-]{43}$/;

const keyFor = (ticket: string): string =>
  `${redisKeyPrefixes.desktopTicket}${createHash('sha256').update(ticket).digest('hex')}`;

/**
 * Read and delete in one step. A separate GET then DEL would let two connections
 * present the same ticket in the window between them, and both would win.
 * A script rather than GETDEL so this does not depend on the Redis version.
 */
const consumeScript = "local v = redis.call('GET', KEYS[1]); if v then redis.call('DEL', KEYS[1]) end; return v";

/**
 * Single-use, short-lived tickets for the desktop WebSocket.
 *
 * Only a SHA-256 of the ticket is stored, so a copy of Redis does not yield
 * anything a browser could present.
 */
export class DesktopTickets {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  async issue(grant: DesktopGrant): Promise<string> {
    const ticket = randomBytes(32).toString('base64url');
    const stored = await this.#redis.set(keyFor(ticket), JSON.stringify(grant), 'EX', desktopTicketTtlSeconds, 'NX');
    if (stored !== 'OK') throw new Error('A desktop ticket could not be stored.');
    return ticket;
  }

  /** `undefined` for anything that is not a live, unused ticket. Consuming it is what makes it unusable again. */
  async consume(ticket: string): Promise<DesktopGrant | undefined> {
    if (!desktopTicketPattern.test(ticket)) return undefined;
    const raw = await this.#redis.eval(consumeScript, 1, keyFor(ticket));
    if (typeof raw !== 'string') return undefined;
    const parsed: unknown = JSON.parse(raw);
    const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
    const uid = record?.['uid'];
    const sessionId = record?.['sessionId'];
    if (typeof uid !== 'string' || typeof sessionId !== 'string') throw new Error('Malformed desktop ticket.');
    return { uid, sessionId };
  }
}

/**
 * The ticket travels in the query string, and Fastify's request logger writes
 * the URL. Single use and 30 seconds already make a logged ticket worthless,
 * but there is no reason for it to reach a log at all.
 */
export function redactDesktopTicket(url: string): string {
  return url.replace(/([?&]ticket=)[^&#]*/g, '$1[redacted]');
}
