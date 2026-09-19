import type { Redis } from 'ioredis';

import { redisKeyPrefixes } from '../redis/client.ts';

/**
 * Where a session's desktop is, and the credential for reaching it.
 *
 * The runner creates the sandbox and is the only process that knows the
 * traffic token; the API relays the stream but deliberately holds no E2B key.
 * This record is the one thing passed between them. The token opens a single
 * sandbox's ports, so the record lives only as long as that sandbox does.
 */
export interface DesktopHandoff {
  readonly host: string;
  readonly token: string;
}

const keyFor = (sessionId: string): string => `${redisKeyPrefixes.desktopHandoff}${sessionId}`;

/** Runner side: publishes a running desktop. `ttlSeconds` must not outlive the sandbox. */
export async function writeDesktopHandoff(
  redis: Redis,
  sessionId: string,
  handoff: DesktopHandoff,
  ttlSeconds: number,
): Promise<void> {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error('A desktop handoff needs a positive lifetime.');
  }
  await redis.set(keyFor(sessionId), JSON.stringify({ host: handoff.host, token: handoff.token }), 'EX', ttlSeconds);
}

/** Runner side: the desktop is gone. Deleting is what tells every open relay socket to end. */
export async function deleteDesktopHandoff(redis: Redis, sessionId: string): Promise<void> {
  await redis.del(keyFor(sessionId));
}

/** Presence only, so a liveness poll never has to read the credential. */
export async function desktopHandoffExists(redis: Redis, sessionId: string): Promise<boolean> {
  return (await redis.exists(keyFor(sessionId))) === 1;
}

/**
 * API side. `undefined` means no desktop is running. A record that exists but is
 * malformed is a bug in whoever wrote it, so it throws rather than being read as
 * "no desktop".
 */
export async function readDesktopHandoff(redis: Redis, sessionId: string): Promise<DesktopHandoff | undefined> {
  const raw = await redis.get(keyFor(sessionId));
  if (raw === null) return undefined;
  const parsed: unknown = JSON.parse(raw);
  const record = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
  const host = record?.['host'];
  const token = record?.['token'];
  if (typeof host !== 'string' || host === '' || typeof token !== 'string' || token === '') {
    throw new Error('Malformed desktop handoff.');
  }
  return { host, token };
}
