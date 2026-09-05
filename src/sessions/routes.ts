import type { OutgoingHttpHeaders } from 'node:http';

import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from 'fastify';

import { authenticatedUser, bearerToken } from '../auth/plugin.ts';
import { AppError } from '../http/errors.ts';
import {
  type SessionEvent,
  type SessionEvents,
  compareStreamIds,
  parseStreamId,
} from './events.ts';
import {
  type BuildSession,
  type QueuedMessage,
  type SessionMessage,
  type SessionRepository,
  promptMaxLength,
} from './repository.ts';


/** Same constraints as the project routes: ids reach a document path. */
const documentId = '^[A-Za-z0-9_-]{1,128}$';

/**
 * A prompt is prose, so newlines belong in it. NUL and the C0 controls that are
 * not whitespace do not: they corrupt logs and terminals downstream and no
 * keyboard produces them.
 */
const promptText = '^[^\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]+$';

/** Model identifiers are compared against the plan allowlist, never interpolated. */
const modelIdentifier = '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$';

export interface SessionRouteOptions {
  /**
   * How often a comment is written down an idle stream. Proxies and load
   * balancers close a connection that has said nothing, and the client cannot
   * tell that from a build that is merely thinking.
   */
  readonly heartbeatSeconds: number;
  /**
   * Open streams held at once, process-wide. Each one is a socket and a
   * listener held for as long as the client likes, and the request rate limit
   * bounds how fast they are opened, not how many exist.
   */
  readonly maxConnections: number;
  readonly maxConnectionsPerUser: number;
  readonly maxBufferedBytes: number;
  readonly reauthenticate: (token: string) => Promise<void>;
}

function toResponse(session: BuildSession) {
  return {
    id: session.id,
    projectId: session.projectId,
    status: session.status,
    model: session.model,
    effort: session.effort,
    sandboxId: session.sandboxId,
    error: session.error,
    messageCount: session.messageCount,
    heartbeatAt: session.heartbeatAt?.toISOString(),
    createdAt: session.createdAt.toISOString(),
  };
}

function toMessageResponse(message: SessionMessage) {
  return {
    seq: message.seq,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt.toISOString(),
  };
}

function toQueuedMessageResponse(msg: QueuedMessage) {
  return {
    id: msg.id,
    sessionId: msg.sessionId,
    prompt: msg.prompt,
    createdAt: msg.createdAt.toISOString(),
  };
}

/** One SSE frame. `data` is JSON, so it can never contain the blank line terminator. */

function frame(event: SessionEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

export function registerSessionRoutes(
  app: FastifyInstance,
  sessions: SessionRepository,
  events: SessionEvents,
  options: SessionRouteOptions,
): void {
  /**
   * A published event that fails to reach Redis must not fail the request that
   * caused it. Firestore already holds the session, the client can read it, and
   * the live stream is a view of state that is safe to lose — but silently
   * losing it is how a stream that stopped working goes unnoticed for a month.
   */
  const publish = (
    log: FastifyBaseLogger,
    sessionId: string,
    type: string,
    data: Readonly<Record<string, unknown>>,
  ): void => {
    events.append(sessionId, type, data).catch((error: unknown) => {
      log.error({ err: error, sessionId, type }, 'session event was not published');
    });
  };

  app.post<{ Params: { projectId: string }; Body: { prompt: string; model: string } }>(
    '/projects/:projectId/sessions',
    {
      preHandler: [app.requireAuth, app.enforceRateLimit('build')],
      schema: {
        params: {
          type: 'object',
          required: ['projectId'],
          additionalProperties: false,
          properties: { projectId: { type: 'string', pattern: documentId } },
        },
        body: {
          type: 'object',
          required: ['prompt', 'model'],
          additionalProperties: false,
          properties: {
            prompt: {
              type: 'string',
              minLength: 1,
              maxLength: promptMaxLength,
              pattern: promptText,
            },
            model: { type: 'string', pattern: modelIdentifier },
          },
        },
      },
    },
    async (request, reply) => {
      const user = authenticatedUser(request);
      const session = await sessions.create(user.uid, request.params.projectId, {
        prompt: request.body.prompt.trim(),
        model: request.body.model,
      });
      publish(request.log, session.id, 'session.queued', {
        status: session.status,
        model: session.model,
        effort: session.effort,
      });
      return reply.code(201).send(toResponse(session));
    },
  );

  app.get<{ Params: { projectId: string }; Querystring: { limit?: number } }>(
    '/projects/:projectId/sessions',
    {
      preHandler: [app.requireAuth, app.enforceRateLimit('read')],
      schema: {
        params: {
          type: 'object',
          required: ['projectId'],
          additionalProperties: false,
          properties: { projectId: { type: 'string', pattern: documentId } },
        },
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 } },
        },
      },
    },
    async (request) => {
      const user = authenticatedUser(request);
      const owned = await sessions.listForProject(
        user.uid,
        request.params.projectId,
        request.query.limit ?? 25,
      );
      return { sessions: owned.map(toResponse) };
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    '/sessions/:sessionId',
    {
      preHandler: [app.requireAuth, app.enforceRateLimit('read')],
      schema: {
        params: {
          type: 'object',
          required: ['sessionId'],
          additionalProperties: false,
          properties: { sessionId: { type: 'string', pattern: documentId } },
        },
      },
    },
    async (request) => {
      const user = authenticatedUser(request);
      return toResponse(await sessions.readOwned(user.uid, request.params.sessionId));
    },
  );

  app.get<{ Params: { sessionId: string }; Querystring: { limit?: number } }>(
    '/sessions/:sessionId/messages',
    {
      preHandler: [app.requireAuth, app.enforceRateLimit('read')],
      schema: {
        params: {
          type: 'object',
          required: ['sessionId'],
          additionalProperties: false,
          properties: { sessionId: { type: 'string', pattern: documentId } },
        },
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 } },
        },
      },
    },
    async (request) => {
      const user = authenticatedUser(request);
      const messages = await sessions.listMessages(
        user.uid,
        request.params.sessionId,
        request.query.limit ?? 100,
      );
      return { messages: messages.map(toMessageResponse) };
    },
  );

  app.post<{ Params: { sessionId: string }; Body: { prompt: string; steer?: boolean } }>(
    '/sessions/:sessionId/messages',
    {
      preHandler: [app.requireAuth, app.enforceRateLimit('build')],
      schema: {
        params: {
          type: 'object',
          required: ['sessionId'],
          additionalProperties: false,
          properties: { sessionId: { type: 'string', pattern: documentId } },
        },
        body: {
          type: 'object',
          required: ['prompt'],
          additionalProperties: false,
          properties: {
            prompt: {
              type: 'string',
              minLength: 1,
              maxLength: promptMaxLength,
              pattern: promptText,
            },
            steer: {
              type: 'boolean',
            },
          },
        },
      },
    },
    async (request, reply) => {
      const user = authenticatedUser(request);
      const prompt = request.body.prompt.trim();
      const current = await sessions.readOwned(user.uid, request.params.sessionId);

      if (request.body.steer === true) {
        if (current.status === 'RUNNING') {
          publish(request.log, current.id, 'session.steer', { prompt });
          return reply.code(200).send({ steered: true, sessionId: current.id });
        }
        if (current.status === 'QUEUED') {
          const queued = await sessions.enqueueMessage(user.uid, current.id, prompt);
          publish(request.log, current.id, 'session.message_queued', {
            queuedMessageId: queued.id,
            prompt: queued.prompt,
          });
          return reply.code(202).send({
            queued: true,
            queuedMessage: toQueuedMessageResponse(queued),
          });
        }
      }

      if (current.status === 'QUEUED' || current.status === 'RUNNING') {
        const queued = await sessions.enqueueMessage(user.uid, current.id, prompt);
        publish(request.log, current.id, 'session.message_queued', {
          queuedMessageId: queued.id,
          prompt: queued.prompt,
        });
        return reply.code(202).send({
          queued: true,
          queuedMessage: toQueuedMessageResponse(queued),
        });
      }

      const session = await sessions.appendPrompt(user.uid, current.id, prompt);
      publish(request.log, session.id, 'session.queued', {
        status: session.status,
        messageCount: session.messageCount,
      });
      return reply.code(202).send({
        queued: false,
        session: toResponse(session),
      });
    },
  );

  app.get<{ Params: { sessionId: string }; Querystring: { limit?: number; after?: string } }>(
    '/sessions/:sessionId/queued-messages',
    {
      preHandler: [app.requireAuth, app.enforceRateLimit('read')],
      schema: {
        querystring: { type: 'object', additionalProperties: false, properties: {
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
          after: { type: 'string', pattern: documentId },
        } },
        params: {
          type: 'object',
          required: ['sessionId'],
          additionalProperties: false,
          properties: { sessionId: { type: 'string', pattern: documentId } },
        },
      },
    },
    async (request) => {
      const user = authenticatedUser(request);
      const queuedMessages = await sessions.listQueuedMessages(user.uid, request.params.sessionId, request.query.limit ?? 100, request.query.after);
      return {
        queuedMessages: queuedMessages.map(toQueuedMessageResponse),
        nextCursor: queuedMessages.length === (request.query.limit ?? 100) ? queuedMessages.at(-1)!.id : null,
      };
    },
  );

  app.delete<{ Params: { sessionId: string; messageId: string } }>(
    '/sessions/:sessionId/queued-messages/:messageId',
    {
      preHandler: [app.requireAuth, app.enforceRateLimit('write')],
      schema: {
        params: {
          type: 'object',
          required: ['sessionId', 'messageId'],
          additionalProperties: false,
          properties: {
            sessionId: { type: 'string', pattern: documentId },
            messageId: { type: 'string', pattern: documentId },
          },
        },
      },
    },
    async (request, reply) => {
      const user = authenticatedUser(request);
      await sessions.deleteQueuedMessage(
        user.uid,
        request.params.sessionId,
        request.params.messageId,
      );
      publish(request.log, request.params.sessionId, 'session.message_dequeued', {
        queuedMessageId: request.params.messageId,
      });
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    '/sessions/:sessionId/cancel',

    {
      preHandler: [app.requireAuth, app.enforceRateLimit('write')],
      schema: {
        params: {
          type: 'object',
          required: ['sessionId'],
          additionalProperties: false,
          properties: { sessionId: { type: 'string', pattern: documentId } },
        },
      },
    },
    async (request, reply) => {
      const user = authenticatedUser(request);
      const session = await sessions.cancel(user.uid, request.params.sessionId);
      if (session.status === 'FAILED') {
        publish(request.log, session.id, 'session.failed', {
          error: session.error ?? 'Cancelled by user',
        });
      } else if (session.cancelRequested === true) {
        publish(request.log, session.id, 'session.cancel_requested', {
          sessionId: session.id,
        });
      }
      return reply.code(200).send(toResponse(session));
    },
  );

  let openStreams = 0;
  const streamsByUser = new Map<string, number>();


  /**
   * The live event stream.
   *
   * Authentication is the ordinary Authorization header, which means the browser
   * cannot use `EventSource` — it has no way to set one. That is deliberate: the
   * alternative is a token in the query string, where it lands in every access
   * log and proxy trace on the way. The frontend reads this with `fetch` and a
   * streaming response body instead.
   */
  app.get<{ Params: { sessionId: string } }>(
    '/sessions/:sessionId/events',
    {
      preHandler: [app.requireAuth, app.enforceRateLimit('stream')],
      schema: {
        params: {
          type: 'object',
          required: ['sessionId'],
          additionalProperties: false,
          properties: { sessionId: { type: 'string', pattern: documentId } },
        },
      },
    },
    async (request, reply: FastifyReply) => {
      const user = authenticatedUser(request);
      const session = await sessions.readOwned(user.uid, request.params.sessionId);

      if ((streamsByUser.get(user.uid) ?? 0) >= options.maxConnectionsPerUser) {
        throw new AppError({ code: 'stream/account-capacity-reached', statusCode: 429,
          message: 'Close an existing event stream before opening another.' });
      }
      if (openStreams >= options.maxConnections) {
        throw new AppError({
          code: 'stream/capacity-reached',
          statusCode: 503,
          message: 'This server is holding as many event streams as it can. Try again shortly.',
          details: { openStreams, maxConnections: options.maxConnections },
        });
      }

      // A client resuming after a dropped connection tells us where it stopped.
      // Anything that is not a stream id is ignored rather than passed to Redis.
      const resumeFrom = parseStreamId(request.headers['last-event-id']);

      openStreams += 1;
      streamsByUser.set(user.uid, (streamsByUser.get(user.uid) ?? 0) + 1);
      // Past this point the reply is ours: Fastify will not serialise, log a
      // status, or run onSend hooks for it, so every exit has to close the socket
      // itself. The headers Fastify's plugins already set — CORS, helmet — are
      // carried over rather than dropped.
      reply.hijack();
      const socket = reply.raw;
      const headers: OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(reply.getHeaders())) {
        if (value !== undefined) {
          headers[name] = value;
        }
      }
      socket.writeHead(200, {
        ...headers,
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        connection: 'keep-alive',
        // nginx buffers a proxied response by default, which holds every event
        // until the buffer fills — for a live log, that is the whole point lost.
        'x-accel-buffering': 'no',
      });
      socket.flushHeaders();

      let finished = false;
      const authorizationWindow = options.heartbeatSeconds * 2000;
      const tokenExpiry = user.expiresAt === undefined ? Number.POSITIVE_INFINITY : user.expiresAt * 1000;
      let authorizedUntil = Math.min(Date.now() + authorizationWindow, tokenExpiry);
      const write = (chunk: string): void => {
        if (finished) return;
        if (!socket.writable || Date.now() >= authorizedUntil) { finish(); return; }
        if (socket.writable) {
          // Close slow readers at backpressure instead of accumulating bytes.
          // The client can resume from its last received event ID.
          if (Buffer.byteLength(chunk) > options.maxBufferedBytes || !socket.write(chunk)) finish();
        }
      };

      // Events published while history is being read are held rather than sent,
      // so the client never sees the future before the past.
      let replaying = true;
      const pending: SessionEvent[] = [];
      let pendingBytes = 0;
      let release: (() => void) | undefined;

      let authenticating = false;
      const heartbeat = setInterval(() => {
        if (finished) return;
        if (Date.now() >= authorizedUntil) { finish(); return; }
        if (authenticating) return;
        authenticating = true;
        void (async () => {
          try {
            await options.reauthenticate(bearerToken(request.headers.authorization));
            await sessions.readOwned(user.uid, session.id);
            authorizedUntil = Math.min(Date.now() + authorizationWindow, tokenExpiry);
            write(': keep-alive\n\n');
          } catch {
            finish();
          } finally { authenticating = false; }
        })();
      }, options.heartbeatSeconds * 1000);
      // Never a reason to hold the process open at shutdown.
      heartbeat.unref();

      const finish = (): void => {
        if (finished) {
          return;
        }
        finished = true;
        openStreams -= 1;
        const remaining = (streamsByUser.get(user.uid) ?? 1) - 1;
        if (remaining === 0) streamsByUser.delete(user.uid);
        else streamsByUser.set(user.uid, remaining);
        clearInterval(heartbeat);
        pending.length = 0;
        try { release?.(); } catch { request.log.warn({ sessionId: session.id }, 'event listener cleanup failed'); }
        finally { socket.destroy(); }
      };

      request.raw.on('close', finish);
      request.raw.on('error', finish);
      socket.on('close', finish);
      socket.on('error', finish);
      if (socket.destroyed || request.raw.aborted) { finish(); return; }

      try {
        release = await events.subscribe(session.id, (event) => {
          if (finished) return;
          if (replaying) {
            pendingBytes += Buffer.byteLength(frame(event));
            if (pendingBytes > options.maxBufferedBytes) { finish(); return; }
            pending.push(event);
            return;
          }
          write(frame(event));
        });
        if (finished) {
          // The client hung up while the subscription was being established, so
          // nothing else will ever release it.
          release();
          return;
        }

        let lastReplayed: string | undefined;
        for await (const event of events.replay(session.id, resumeFrom)) {
          if (finished) break;
          write(frame(event));
          lastReplayed = event.id;
        }
        replaying = false;
        for (const event of pending) {
          // Whatever arrived during the replay and was already in it.
          if (lastReplayed !== undefined && compareStreamIds(event.id, lastReplayed) <= 0) {
            continue;
          }
          write(frame(event));
        }
        pending.length = 0;
      } catch (error) {
        // The response is hijacked, so the error handler can no longer reply.
        // All that is left is to log it and hang up, which the client sees as a
        // dropped stream and retries.
        request.log.error({ err: error, sessionId: session.id }, 'event stream failed to start');
        finish();
      }
    },
  );
}
