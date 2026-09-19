import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { Redis } from 'ioredis';
import { WebSocket } from 'ws';

import { authenticatedUser } from '../auth/plugin.ts';
import { AppError, safeErrorDiagnostic } from '../http/errors.ts';
import type { SessionRepository } from '../sessions/repository.ts';
import { desktopHandoffExists, readDesktopHandoff, type DesktopHandoff } from './handoff.ts';
import { DesktopTickets, desktopTicketTtlSeconds } from './tickets.ts';

/**
 * Why the relay ended a socket. A failed WebSocket upgrade shows a browser only
 * a generic error, so every refusal is an accepted upgrade that is closed at
 * once with one of these codes; the reason string is the same token.
 */
export type DesktopCloseReason =
  | 'desktop-ended'
  | 'server-shutdown'
  | 'protocol-abuse'
  | 'ticket-invalid'
  | 'origin-not-allowed'
  | 'session-not-found'
  | 'no-desktop'
  | 'max-lifetime'
  | 'slow-consumer'
  | 'capacity-reached'
  | 'relay-error';

export const desktopCloseCodes: Readonly<Record<DesktopCloseReason, number>> = {
  'desktop-ended': 1000,
  'server-shutdown': 1001,
  'protocol-abuse': 4400,
  'ticket-invalid': 4401,
  'origin-not-allowed': 4403,
  'session-not-found': 4404,
  'no-desktop': 4409,
  'max-lifetime': 4410,
  'slow-consumer': 4413,
  'capacity-reached': 4429,
  'relay-error': 4500,
};

/** The only sandbox port the relay will ever connect to: the noVNC proxy. Never the sandbox's control port. */
const desktopPort = 6080;

/** noVNC's own subprotocol. Requested upstream and selected for the browser. */
const desktopSubprotocol = 'binary';

/** Header E2B requires on requests to a private sandbox's ports. */
const trafficTokenHeader = 'e2b-traffic-access-token';

const upstreamMaxPayload = 8 * 1024 * 1024;
const clientMaxPayload = 64 * 1024;

export interface DesktopRelayOptions {
  readonly maxConnections: number;
  readonly maxConnectionsPerUser: number;
  readonly maxViewersPerSession: number;
  readonly streamMaxSeconds: number;
  readonly pingSeconds: number;
  readonly bufferMaxBytes: number;
  readonly clientMaxBytesPerSecond: number;
  /** Exact origins, the same list CORS uses. WebSockets are not covered by CORS, so this is checked here. */
  readonly allowedOrigins: ReadonlySet<string>;
  /** Hosts outside this domain are never connected to, whatever the handoff says. */
  readonly upstreamDomain: string;
  /** How to reach the sandbox. Replaceable so tests can point at a local server. */
  readonly connectUpstream?: (host: string, token: string) => WebSocket;
}

export interface DesktopRelayDependencies {
  readonly redis: Redis;
  readonly sessions: Pick<SessionRepository, 'readOwned'>;
  readonly tickets: DesktopTickets;
}

function defaultConnect(host: string, token: string): WebSocket {
  return new WebSocket(`wss://${host}/websockify`, [desktopSubprotocol], {
    headers: { [trafficTokenHeader]: token },
    handshakeTimeout: 10_000,
    maxPayload: upstreamMaxPayload,
  });
}

function rawSize(data: WebSocket.RawData): number {
  if (Array.isArray(data)) return data.reduce((sum, part) => sum + part.length, 0);
  return data instanceof ArrayBuffer ? data.byteLength : data.length;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Copies bytes between a browser and a private sandbox's desktop stream.
 *
 * It does not parse the stream. Whether a viewer may type is decided at the
 * source, where the VNC server is started view-only; what the relay adds is
 * identity (a single-use ticket), origin checking, capacity, liveness and a
 * ceiling on what a viewer may send.
 */
export class DesktopRelay {
  readonly #deps: DesktopRelayDependencies;
  readonly #options: DesktopRelayOptions;
  readonly #hostPattern: RegExp;
  #open = 0;
  readonly #perUser = new Map<string, number>();
  readonly #perSession = new Map<string, number>();
  readonly #active = new Set<(reason: DesktopCloseReason) => void>();

  constructor(deps: DesktopRelayDependencies, options: DesktopRelayOptions) {
    for (const [name, value] of Object.entries({
      maxConnections: options.maxConnections, maxConnectionsPerUser: options.maxConnectionsPerUser,
      maxViewersPerSession: options.maxViewersPerSession, streamMaxSeconds: options.streamMaxSeconds,
      pingSeconds: options.pingSeconds, bufferMaxBytes: options.bufferMaxBytes,
      clientMaxBytesPerSecond: options.clientMaxBytesPerSecond,
    })) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Desktop relay option ${name} must be a positive integer.`);
    }
    if (options.upstreamDomain === '') throw new Error('Desktop relay needs the domain sandbox hosts belong to.');
    this.#deps = deps;
    this.#options = options;
    this.#hostPattern = new RegExp(`^${desktopPort}-[a-z0-9]{10,40}\\.${escapeRegExp(options.upstreamDomain)}$`);
  }

  /** Best effort at ticket time; the authoritative check is when the socket opens. */
  hasCapacity(uid: string, sessionId: string): boolean {
    return this.#open < this.#options.maxConnections
      && (this.#perUser.get(uid) ?? 0) < this.#options.maxConnectionsPerUser
      && (this.#perSession.get(sessionId) ?? 0) < this.#options.maxViewersPerSession;
  }

  #reserve(uid: string, sessionId: string): (() => void) | undefined {
    if (!this.hasCapacity(uid, sessionId)) return undefined;
    this.#open += 1;
    this.#perUser.set(uid, (this.#perUser.get(uid) ?? 0) + 1);
    this.#perSession.set(sessionId, (this.#perSession.get(sessionId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#open -= 1;
      for (const [map, key] of [[this.#perUser, uid], [this.#perSession, sessionId]] as const) {
        const remaining = (map.get(key) ?? 1) - 1;
        if (remaining <= 0) map.delete(key);
        else map.set(key, remaining);
      }
    };
  }

  /** Ends every open stream, for a process that is shutting down. */
  closeAll(reason: DesktopCloseReason): void {
    for (const finish of [...this.#active]) finish(reason);
  }

  /**
   * Resolves once the sandbox connection is open, together with anything the sandbox
   * said before the caller could start listening. The desktop server speaks first (the
   * protocol version banner), and it can do so in the same tick the connection opens,
   * so a listener attached a moment later would miss it.
   */
  #connect(handoff: DesktopHandoff): Promise<{ upstream: WebSocket; early: [WebSocket.RawData, boolean][]; stopCollecting: () => void }> {
    return new Promise((resolve, reject) => {
      const upstream = (this.#options.connectUpstream ?? defaultConnect)(handoff.host, handoff.token);
      const early: [WebSocket.RawData, boolean][] = [];
      const collect = (data: WebSocket.RawData, isBinary: boolean): void => { early.push([data, isBinary]); };
      upstream.on('message', collect);
      const fail = (): void => {
        upstream.terminate();
        reject(new Error('The desktop upstream connection failed.'));
      };
      upstream.once('open', () => {
        upstream.off('error', fail);
        upstream.off('unexpected-response', fail);
        resolve({ upstream, early, stopCollecting: () => { upstream.off('message', collect); } });
      });
      upstream.once('error', fail);
      upstream.once('unexpected-response', fail);
    });
  }

  /** Serves one accepted browser WebSocket for the whole of its life. Never throws. */
  async serve(
    socket: WebSocket,
    input: { readonly sessionId: string; readonly origin: string | undefined; readonly ticket: string | undefined; readonly log: FastifyBaseLogger },
  ): Promise<void> {
    const { sessionId, log } = input;
    let finished = false;
    let release: (() => void) | undefined;
    let upstream: WebSocket | undefined;
    const timers: NodeJS.Timeout[] = [];

    const finish = (reason?: DesktopCloseReason): void => {
      if (finished) return;
      finished = true;
      for (const timer of timers) { clearTimeout(timer); clearInterval(timer); }
      this.#active.delete(finish);
      release?.();
      upstream?.terminate();
      if (reason === undefined) socket.terminate();
      else if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(desktopCloseCodes[reason], reason);
      }
    };

    // An error is always followed by a close event, and that is where cleanup happens.
    socket.on('error', () => {});
    socket.on('close', () => finish());

    try {
      if (input.origin === undefined || !this.#options.allowedOrigins.has(input.origin)) return finish('origin-not-allowed');

      const grant = input.ticket === undefined ? undefined : await this.#deps.tickets.consume(input.ticket);
      if (finished) return;
      if (grant === undefined || grant.sessionId !== sessionId) return finish('ticket-invalid');

      try { await this.#deps.sessions.readOwned(grant.uid, sessionId); }
      catch (error) {
        if (error instanceof AppError && error.code === 'session/not-found') return finish('session-not-found');
        throw error;
      }
      if (finished) return;

      release = this.#reserve(grant.uid, sessionId);
      if (release === undefined) return finish('capacity-reached');

      const handoff = await readDesktopHandoff(this.#deps.redis, sessionId);
      if (finished) return;
      if (handoff === undefined) return finish('no-desktop');
      if (!this.#hostPattern.test(handoff.host)) {
        log.error({ sessionId }, 'desktop handoff host is outside the sandbox domain');
        return finish('relay-error');
      }

      this.#active.add(finish);
      const connection = await this.#connect(handoff);
      upstream = connection.upstream;
      // The viewer left while the sandbox connection was opening; finish() ran before
      // this socket existed, so it has to be closed here.
      if (finished) { connection.upstream.terminate(); return; }

      this.#pipe(socket, connection, finish, timers, sessionId);
    } catch (error) {
      log.error({ diagnostic: safeErrorDiagnostic(error), sessionId }, 'desktop relay failed');
      finish('relay-error');
    }
  }

  #pipe(
    socket: WebSocket,
    connection: { upstream: WebSocket; early: [WebSocket.RawData, boolean][]; stopCollecting: () => void },
    finish: (reason?: DesktopCloseReason) => void,
    timers: NodeJS.Timeout[],
    sessionId: string,
  ): void {
    const { upstream } = connection;
    const options = this.#options;
    let windowStart = Date.now();
    let windowBytes = 0;

    const forward = (data: WebSocket.RawData, isBinary: boolean): void => {
      // Stop copying rather than queue without limit for a viewer that is not keeping up.
      if (socket.bufferedAmount > options.bufferMaxBytes) return finish('slow-consumer');
      socket.send(data, { binary: isBinary }, (error) => { if (error) finish(); });
    };
    connection.stopCollecting();
    for (const [data, isBinary] of connection.early) forward(data, isBinary);
    upstream.on('message', forward);
    socket.on('message', (data, isBinary) => {
      const now = Date.now();
      if (now - windowStart >= 1000) { windowStart = now; windowBytes = 0; }
      windowBytes += rawSize(data);
      if (windowBytes > options.clientMaxBytesPerSecond) return finish('protocol-abuse');
      upstream.send(data, { binary: isBinary }, () => {});
    });
    upstream.on('close', () => finish('desktop-ended'));
    upstream.on('error', () => finish('relay-error'));

    // A desktop that is not being touched sends almost nothing, so liveness is
    // judged by ping and pong, never by traffic.
    let alive = true;
    let checking = false;
    socket.on('pong', () => { alive = true; });
    const tick = setInterval(() => {
      if (!alive) return finish();
      alive = false;
      socket.ping();
      upstream.ping();
      // The runner deleting the handoff is how the relay learns the desktop is gone.
      if (checking) return;
      checking = true;
      desktopHandoffExists(this.#deps.redis, sessionId)
        .then((exists) => { if (!exists) finish('desktop-ended'); }, () => finish('relay-error'))
        .finally(() => { checking = false; });
    }, options.pingSeconds * 1000);
    timers.push(tick, setTimeout(() => finish('max-lifetime'), options.streamMaxSeconds * 1000));
    for (const timer of timers) timer.unref();
  }
}

const sessionParams = {
  type: 'object',
  required: ['sessionId'],
  additionalProperties: false,
  properties: { sessionId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' } },
} as const;

/**
 * The two routes a browser needs to watch a desktop:
 *
 *   POST /sessions/:sessionId/desktop-ticket   (Firebase-authenticated) -> a ticket
 *   GET  /sessions/:sessionId/desktop?ticket=  (WebSocket)              -> the stream
 *
 * Must be awaited: the WebSocket plugin has to be loaded before the route that
 * uses it is declared.
 */
export async function registerDesktopRoutes(
  app: FastifyInstance,
  deps: DesktopRelayDependencies & { readonly relay: DesktopRelay },
): Promise<void> {
  const { relay, sessions, tickets, redis } = deps;

  await app.register(websocket, {
    options: {
      // Small: a view-only client sends only tiny requests. An oversize frame closes the socket.
      maxPayload: clientMaxPayload,
      handleProtocols: (protocols) => (protocols.has(desktopSubprotocol) ? desktopSubprotocol : false),
    },
    // Replaces the plugin's own shutdown step, which closes every client without a
    // status code, so a viewer could not tell a restart from a dropped connection.
    preClose(this: FastifyInstance, done) {
      relay.closeAll('server-shutdown');
      for (const client of this.websocketServer.clients) client.close(desktopCloseCodes['server-shutdown'], 'server-shutdown');
      // Stop accepting new upgrades; nothing else on this server handles them.
      this.server.removeAllListeners('upgrade');
      this.websocketServer.close(() => done());
    },
  });

  app.post<{ Params: { sessionId: string } }>(
    '/sessions/:sessionId/desktop-ticket',
    { preHandler: [app.requireAuth, app.enforceRateLimit('stream')], schema: { params: sessionParams } },
    async (request) => {
      const user = authenticatedUser(request);
      const { sessionId } = request.params;
      await sessions.readOwned(user.uid, sessionId);
      if (!(await desktopHandoffExists(redis, sessionId))) {
        throw new AppError({ code: 'session/no-desktop', statusCode: 409, message: 'No desktop is running for this session.' });
      }
      if (!relay.hasCapacity(user.uid, sessionId)) {
        throw new AppError({
          code: 'desktop/capacity-reached', statusCode: 429,
          message: 'Close another desktop view before opening this one.',
        });
      }
      return {
        ticket: await tickets.issue({ uid: user.uid, sessionId }),
        expiresInSeconds: desktopTicketTtlSeconds,
        path: `/sessions/${sessionId}/desktop`,
      };
    },
  );

  app.get<{ Params: { sessionId: string }; Querystring: { ticket?: unknown } }>(
    '/sessions/:sessionId/desktop',
    { websocket: true, schema: { params: sessionParams } },
    (socket, request) => {
      const { ticket } = request.query;
      void relay.serve(socket, {
        sessionId: request.params.sessionId,
        origin: request.headers.origin,
        ticket: typeof ticket === 'string' ? ticket : undefined,
        log: request.log,
      });
    },
  );
}
