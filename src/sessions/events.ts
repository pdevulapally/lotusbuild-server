import type { Redis } from 'ioredis';

import { redisKeyPrefixes } from '../redis/client.ts';

export interface SessionEvent {
  /** A Redis stream id, `<ms>-<seq>`. Monotonic, and what a client resumes from. */
  readonly id: string;
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export type SessionEventListener = (event: SessionEvent) => void;

/** Rejects anything that is not a Redis stream id before it reaches Redis. */
const streamIdPattern = /^\d{1,20}-\d{1,20}$/;

export function parseStreamId(value: unknown): string | undefined {
  return typeof value === 'string' && streamIdPattern.test(value) ? value : undefined;
}

/**
 * Orders two stream ids. They cannot be compared as strings — "10-0" sorts
 * before "9-0" — and getting this wrong would replay events a client has
 * already seen, or drop ones it has not.
 */
export function compareStreamIds(left: string, right: string): number {
  const [leftMs = 0, leftSeq = 0] = left.split('-').map(Number);
  const [rightMs = 0, rightSeq = 0] = right.split('-').map(Number);
  return leftMs === rightMs ? leftSeq - rightSeq : leftMs - rightMs;
}

export interface SessionEventsOptions {
  /** How long after its last event a session's log is dropped from Redis. */
  readonly retentionSeconds: number;
  /** Ceiling on events held per session, so one runaway build cannot fill RAM. */
  readonly maxPerSession: number;
  /** A listener threw. Delivery to the others must not be lost with it. */
  readonly onListenerError: (error: Error, sessionId: string) => void;
}

/**
 * The live log of what a build is doing.
 *
 * Two mechanisms, because they answer different questions. A Redis stream holds
 * the recent history, so a browser that reconnects mid-build resumes from the
 * event it last saw instead of from nothing. Pub/sub delivers what happens next.
 *
 * The alternative — every reader blocking on XREAD — would need one Redis
 * connection per open browser tab, and with `enableOfflineQueue` off a blocking
 * command on the shared connection would stall rate limiting for the whole
 * process. One subscriber connection with in-process fan-out costs a Map.
 *
 * None of this is the system of record. Losing Redis loses the live view of a
 * build in flight, never the session or its transcript.
 */
export class SessionEvents {
  readonly #redis: Redis;
  readonly #subscriber: Redis;
  readonly #retentionSeconds: number;
  readonly #maxPerSession: number;
  readonly #onListenerError: SessionEventsOptions['onListenerError'];
  readonly #listeners = new Map<string, Set<SessionEventListener>>();

  constructor(redis: Redis, subscriber: Redis, options: SessionEventsOptions) {
    if (!Number.isSafeInteger(options.retentionSeconds) || options.retentionSeconds <= 0) {
      throw new Error(`Event retention must be a positive number of seconds.`);
    }
    if (!Number.isSafeInteger(options.maxPerSession) || options.maxPerSession <= 0) {
      throw new Error(`The per-session event ceiling must be a positive integer.`);
    }
    this.#redis = redis;
    this.#subscriber = subscriber;
    this.#retentionSeconds = options.retentionSeconds;
    this.#maxPerSession = options.maxPerSession;
    this.#onListenerError = options.onListenerError;
    this.#subscriber.on('message', (channel, payload) => {
      this.#deliver(channel, payload);
    });
  }

  #key(sessionId: string): string {
    return `${redisKeyPrefixes.sessionEvents}${sessionId}`;
  }

  /**
   * Appends an event and publishes it. The stream key and the pub/sub channel
   * share a name deliberately: channels are not part of the keyspace, so they
   * cannot collide, and one name means one thing to look at when debugging.
   */
  async append(
    sessionId: string,
    type: string,
    data: Readonly<Record<string, unknown>>,
  ): Promise<SessionEvent> {
    const key = this.#key(sessionId);
    const id = await this.#redis.xadd(
      key,
      'MAXLEN',
      '~',
      this.#maxPerSession,
      '*',
      'type',
      type,
      'data',
      JSON.stringify(data),
    );
    if (id === null) {
      throw new Error(`Redis refused to append a "${type}" event to session ${sessionId}.`);
    }

    const event: SessionEvent = { id, type, data };
    // Refreshed on every append rather than set once, so the log outlives a long
    // build but does not outlive interest in it.
    await this.#redis
      .pipeline()
      .expire(key, this.#retentionSeconds)
      .publish(key, JSON.stringify(event))
      .exec();

    return event;
  }

  /**
   * Everything still held for this session, optionally only what came after the
   * event the client last saw.
   */
  async history(sessionId: string, afterId: string | undefined): Promise<readonly SessionEvent[]> {
    const entries = await this.#redis.xrange(
      this.#key(sessionId),
      afterId === undefined ? '-' : `(${afterId}`,
      '+',
      'COUNT',
      this.#maxPerSession,
    );

    return entries.map(([id, fields]) => {
      const values = new Map<string, string>();
      for (let index = 0; index + 1 < fields.length; index += 2) {
        values.set(fields[index] as string, fields[index + 1] as string);
      }
      const type = values.get('type');
      const data = values.get('data');
      if (type === undefined || data === undefined) {
        // We are the only writer of this stream, so a malformed entry is our own
        // bug and hiding it would make the next one harder to find.
        throw new Error(`Session event ${id} is missing its type or data.`);
      }
      return { id, type, data: JSON.parse(data) as Record<string, unknown> };
    });
  }

  /**
   * Registers a listener, resolving once Redis has confirmed the subscription.
   *
   * Awaiting matters: a caller that replays history before the subscription is
   * live loses everything published in between, which on a fast build is the
   * first thing the user was waiting to see.
   */
  async subscribe(sessionId: string, listener: SessionEventListener): Promise<() => void> {
    const key = this.#key(sessionId);
    // SUBSCRIBE on a channel this connection already holds is a no-op, so each
    // caller can await its own without tracking who subscribed first.
    await this.#subscriber.subscribe(key);

    let listeners = this.#listeners.get(key);
    if (listeners === undefined) {
      listeners = new Set();
      this.#listeners.set(key, listeners);
    }
    listeners.add(listener);

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const current = this.#listeners.get(key);
      if (current === undefined) {
        return;
      }
      current.delete(listener);
      if (current.size === 0) {
        this.#listeners.delete(key);
        void this.#subscriber.unsubscribe(key);
      }
    };
  }

  #deliver(channel: string, payload: string): void {
    const listeners = this.#listeners.get(channel);
    if (listeners === undefined || listeners.size === 0) {
      return;
    }
    const sessionId = channel.slice(redisKeyPrefixes.sessionEvents.length);

    let event: SessionEvent;
    try {
      event = JSON.parse(payload) as SessionEvent;
    } catch (cause) {
      this.#onListenerError(
        new Error(`Session ${sessionId} published an unparseable event.`, { cause }),
        sessionId,
      );
      return;
    }

    for (const listener of listeners) {
      try {
        listener(event);
      } catch (cause) {
        this.#onListenerError(
          cause instanceof Error ? cause : new Error(String(cause)),
          sessionId,
        );
      }
    }
  }
}
