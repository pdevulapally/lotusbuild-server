import {
  startTiming } from '../diagnostics/timing.ts';
import { commandKey, commandWasReplayed } from './commands.ts';
import type { OutgoingHttpHeaders } from 'node:http';

import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from 'fastify';

import { attachmentIdPattern, imageMediaTypes, maxAttachmentsPerMessage, type AttachmentRef } from '../attachments/store.ts';
import { authenticatedUser, bearerToken } from '../auth/plugin.ts';
import { aiEfforts, type AiEffort } from '../entitlements/build-admission.ts';
import { AppError, safeErrorDiagnostic } from '../http/errors.ts';
import { mutation } from '../http/idempotency.ts';
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
  type MessageAcceptance,
  promptMaxLength,
  sessionModes,
} from './repository.ts';
import { modelIdentifierPattern } from '../models/provider.ts';


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
/** References to uploads made through `POST /attachments`; existence is checked against the caller's own uploads. */
const attachmentsSchema = {
  type: 'array',
  maxItems: maxAttachmentsPerMessage,
  items: {
    type: 'object',
    required: ['id', 'mediaType'],
    additionalProperties: false,
    properties: {
      id: { type: 'string', pattern: attachmentIdPattern },
      mediaType: { type: 'string', enum: [...imageMediaTypes] },
    },
  },
} as const;

export interface SessionRouteOptions {
  /** Confirms every referenced image is one of the caller's own uploads. Absent only in tests. */
  readonly attachments?: { assertOwned(ownerUid: string, refs: readonly AttachmentRef[]): Promise<void> };
  readonly validateModel?: (uid: string, model: string, effort?: AiEffort) => Promise<AiEffort | undefined>;
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
    mode: session.mode,
    sandboxId: session.sandboxId,
    error: session.error,
    cancelRequested: session.cancelRequested === true,
    workspaceRecovery: session.workspaceRecovery,
    pendingInput: session.pendingInput,
    fallback: session.fallback === undefined ? undefined : {
      status: session.fallback.status, resumable: session.fallback.resumable === true, reason: session.fallback.reason, checkpointId: session.fallback.checkpointId,
      imageExpiresAt: session.fallback.imageExpiresAt, lane: session.fallback.lane, consent: session.fallback.consent === true, resetAt: session.fallback.resetAt,
      retryAt: session.fallback.retryAt, limitLabel: session.fallback.limitLabel,
      offer: session.fallback.offer === undefined ? undefined : { provider: session.fallback.offer.provider, model: session.fallback.offer.model, effort: session.fallback.offer.effort,
        ...(session.fallback.offer.estimatedInput === true ? { estimatedInput: true } : {}) },
    },
    messageCount: session.messageCount,
    heartbeatAt: session.heartbeatAt?.toISOString(),
    createdAt: session.createdAt.toISOString(),
  };
}

export function toMessageResponse(message: SessionMessage) {
  return {
    seq: message.seq,
    role: message.role,
    content: message.content,
    attachments: message.attachments,
    createdAt: message.createdAt.toISOString(),
    ...(message.voiceSpeaker === undefined ? {} : { voiceSpeaker: message.voiceSpeaker }),
  };
}

function toQueuedMessageResponse(msg: QueuedMessage) {
  return {
    id: msg.id,
    sessionId: msg.sessionId,
    prompt: msg.prompt,
    attachments: msg.attachments,
    createdAt: msg.createdAt.toISOString(),
  };
}

/** One SSE frame. `data` is JSON, so it can never contain the blank line terminator. */

function frame(event: SessionEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

/**
 * Why the server ended a stream, so a client can tell an expired token from a
 * dropped network without guessing.
 *
 * - `token-expired`: the ID token this stream was opened with has reached its
 *   expiry. A refreshed token cannot extend an open stream; reconnect with one.
 * - `authorization-failed`: re-checking the token or the session failed (revoked
 *   or disabled account, session gone, or the check itself could not complete).
 * - `slow-consumer`: the client was not reading fast enough. Resume from the
 *   last event id.
 * - `stream-error`: the server failed while starting or replaying the stream.
 */
export type StreamClosingReason =
  | 'token-expired'
  | 'authorization-failed'
  | 'slow-consumer'
  | 'stream-error';

/**
 * The last frame of a stream the server ended. It carries no `id:` line, so it
 * can never become the `Last-Event-ID` a client resumes from.
 */
export function closingFrame(reason: StreamClosingReason): string {
  return `event: stream.closing\ndata: ${JSON.stringify({ reason })}\n\n`;
}

/** How long a client that stopped reading gets to receive the closing frame before the socket is destroyed. */
const closingGraceMs = 1000;

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
      log.error({ diagnostic: safeErrorDiagnostic(error), sessionId, type }, 'session event was not published');
    });
  };

  app.post<{ Params: { projectId: string }; Body: {
    attachments?: AttachmentRef[]; prompt: string;
    model: string;
    effort?: AiEffort;
    mode?: (typeof sessionModes)[number];
  } }>(
    '/projects/:projectId/sessions',
    {
      preHandler: [app.requireAuth, app.requireVerifiedEmail, app.enforceRateLimit('build')],
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
            effort: { type: 'string', enum: [...aiEfforts] },
            mode: { type: 'string', enum: [...sessionModes] },
            attachments: attachmentsSchema,
          },
        },
      },
    },
    async (request, reply) => {
      const user = authenticatedUser(request);
      const defaultEffort = await options.validateModel?.(user.uid, request.body.model, request.body.effort);
      const effort = request.body.effort ?? defaultEffort;
      const input = {
        prompt: request.body.prompt.trim(),
        model: request.body.model,
        ...(effort === undefined ? {} : { effort }),
        ...(request.body.mode === undefined ? {} : { mode: request.body.mode }),
        ...(request.body.attachments === undefined ? {} : { attachments: request.body.attachments }),
      };
      await options.attachments?.assertOwned(user.uid, input.attachments ?? []);
      const session = await sessions.create(user.uid, request.params.projectId, input, undefined,
        mutation<BuildSession>(user.uid, `POST /projects/${request.params.projectId}/sessions`,
          commandKey(request.headers['idempotency-key'], true), { ...input, effort: request.body.effort }, (value) => ({ statusCode: 201, body: toResponse(value) })));
      if (!commandWasReplayed(session)) publish(request.log, session.id, 'session.queued', {

        status: session.status,
        model: session.model,
        effort: session.effort,
        mode: session.mode,
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

  app.post<{ Params: { sessionId: string }; Body: { prompt: string; steer?: boolean; mode?: (typeof sessionModes)[number]; inputResponse?: { id: string; answer: string }; attachments?: AttachmentRef[] } }>(

    '/sessions/:sessionId/messages',
    {
      preHandler: [app.requireAuth, app.requireVerifiedEmail, app.enforceRateLimit('build')],
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
            mode: { type: 'string', enum: [...sessionModes] },
            inputResponse: { type: 'object', required: ['id', 'answer'], additionalProperties: false, properties: {
              id: { type: 'string', pattern: documentId },
              answer: { type: 'string', minLength: 1, maxLength: promptMaxLength, pattern: promptText },
            } },
            attachments: attachmentsSchema,

          },
        },
      },
    },
    async (request, reply) => {
      const user = authenticatedUser(request);
      const prompt = request.body.prompt.trim();
      const attachments = request.body.attachments ?? [];
      await options.attachments?.assertOwned(user.uid, attachments);
      const key = commandKey(request.headers['idempotency-key'], true);
      const operation = mutation<MessageAcceptance>(user.uid, `POST /sessions/${request.params.sessionId}/messages`, key,
        { prompt, steer: request.body.steer === true, mode: request.body.mode, attachments, ...(request.body.inputResponse === undefined ? {} : { inputResponse: request.body.inputResponse }) },
        value => value.kind === 'steered' ? { statusCode: 200, body: { steered: true, sessionId: value.sessionId } }
          : value.kind === 'queued' ? { statusCode: 202, body: { queued: true, queuedMessage: toQueuedMessageResponse(value.message) } }
          : { statusCode: 202, body: { queued: false, session: toResponse(value.session) } });
      const result = await sessions.submitMessage(user.uid, request.params.sessionId,
        prompt, request.body.steer === true, operation, undefined, request.body.inputResponse, request.body.mode, attachments);
      if (result.kind === 'steered') {
        if (!commandWasReplayed(result)) publish(request.log, result.sessionId, 'session.steer', {});
        return reply.code(200).send({ steered: true, sessionId: result.sessionId });
      }
      if (result.kind === 'queued') {
        if (!commandWasReplayed(result)) publish(request.log, result.message.sessionId, 'session.message_queued', { queuedMessageId: result.message.id });
        return reply.code(202).send({ queued: true, queuedMessage: toQueuedMessageResponse(result.message) });
      }
      if (result.session.status === 'QUEUED' && !commandWasReplayed(result)) publish(request.log, result.session.id, 'session.queued', { status: result.session.status, messageCount: result.session.messageCount });
      return reply.code(202).send({ queued: false, session: toResponse(result.session) });

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
      const session = await sessions.cancel(user.uid, request.params.sessionId,
        mutation<BuildSession>(user.uid, `POST /sessions/${request.params.sessionId}/cancel`,
          commandKey(request.headers['idempotency-key'], true), {}, (value) => ({ statusCode: 200, body: toResponse(value) })));

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

  app.post<{ Params: { sessionId: string }; Body: { checkpointId: string; lane: 'premium' | 'fallback'; model: string; effort: AiEffort } }>(
    '/sessions/:sessionId/continuation', {
      preHandler: [app.requireAuth, app.requireVerifiedEmail, app.enforceRateLimit('build')],
      schema: {
        params: { type: 'object', required: ['sessionId'], additionalProperties: false, properties: { sessionId: { type: 'string', pattern: documentId } } },
        body: { type: 'object', required: ['checkpointId', 'lane', 'model', 'effort'], additionalProperties: false, properties: {
          checkpointId: { type: 'string', pattern: documentId }, lane: { type: 'string', enum: ['premium', 'fallback'] },
          model: { type: 'string', pattern: modelIdentifierPattern }, effort: { type: 'string', enum: [...aiEfforts] },
        } },
      },
    }, async (request, reply) => {
      const user = authenticatedUser(request);
      const key = commandKey(request.headers['idempotency-key'], true);
      if (key === undefined) throw new Error('Command identity is required.');
      const session = await sessions.acceptFallback(user.uid, request.params.sessionId, key, request.body);
      return reply.code(202).send(toResponse(session));
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
      // Reject malformed cursors before starting a response or contacting storage.
      const resumeFrom = parseStreamId(request.headers['last-event-id']);
      if (request.headers['last-event-id'] !== undefined && resumeFrom === undefined) throw new AppError({
        code: 'stream/invalid-cursor', statusCode: 400, message: 'Last-Event-ID is not a valid event cursor.' });

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
      // The window ends at the token's own expiry or, if the periodic re-check
      // has stalled, two heartbeats after it last succeeded; only the first is
      // an expired token.
      const lapsedReason = (): StreamClosingReason =>
        Date.now() >= tokenExpiry ? 'token-expired' : 'authorization-failed';
      const write = (chunk: string): void => {
        if (finished) return;
        if (!socket.writable) { finish(); return; }
        if (Date.now() >= authorizedUntil) { finish(lapsedReason()); return; }
        // Close slow readers at backpressure instead of accumulating bytes.
        // The client can resume from its last received event ID.
        const endWrite = startTiming('sse.socket_write');
        try { if (Buffer.byteLength(chunk) > options.maxBufferedBytes || !socket.write(chunk)) finish('slow-consumer'); } finally { endWrite(); }
      };

      // Events published while history is being read are held rather than sent,
      // so the client never sees the future before the past.
      let lastDelivered = resumeFrom;
      const deliver = (event: SessionEvent): void => {
        if (lastDelivered !== undefined && compareStreamIds(event.id, lastDelivered) <= 0) return;
        write(frame(event));
        if (!finished) lastDelivered = event.id;
      };
      let replaying = true;
      const pending: SessionEvent[] = [];
      let pendingBytes = 0;
      let release: (() => void) | undefined;

      let pumping: Promise<void> | undefined;
      let pumpAgain = false;
      // Pub/sub is only a wake-up. Always read in durable order, including missed notifications.
      const catchUp = (): Promise<void> => {
        pumpAgain = true;
        if (pumping !== undefined) return pumping;
        pumping = (async () => {
          do {
            pumpAgain = false;
            if (lastDelivered !== undefined && !await events.resumeAvailable(session.id, lastDelivered)) {
              write('event: stream.reset\ndata: {"reason":"history-unavailable"}\n\n');
              lastDelivered = undefined;
            }
            for await (const event of events.replay(session.id, lastDelivered)) {
              if (finished) break;
              deliver(event);
            }
          } while (pumpAgain && !finished);
        })().finally(() => { pumping = undefined; });
        return pumping;
      };
      let authenticating = false;
      const heartbeat = setInterval(() => {
        if (finished) return;
        if (Date.now() >= authorizedUntil) { finish(lapsedReason()); return; }
        if (authenticating) return;
        authenticating = true;
        void (async () => {
          try {
            await options.reauthenticate(bearerToken(request.headers.authorization));
            const current = await sessions.readOwned(user.uid, session.id);
            authorizedUntil = Math.min(Date.now() + authorizationWindow, tokenExpiry);
            if (events.durable) await catchUp();
            write(`event: session.state\ndata: ${JSON.stringify(toResponse(current))}\n\n`);
          } catch {
            finish('authorization-failed');
          } finally { authenticating = false; }
        })();
      }, options.heartbeatSeconds * 1000);
      // Never a reason to hold the process open at shutdown.
      heartbeat.unref();

      // A stream the client hung up on has nobody to tell, so only the server's
      // own reasons pass one. The frame is the response's last write; the socket
      // is still destroyed after a short grace so a client that stopped reading
      // cannot hold it open for the sake of a frame.
      const closeSocket = (reason: StreamClosingReason | undefined): void => {
        if (reason === undefined || !socket.writable) { socket.destroy(); return; }
        socket.end(closingFrame(reason));
        setTimeout(() => socket.destroy(), closingGraceMs).unref();
      };

      const finish = (reason?: StreamClosingReason): void => {
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
        finally { closeSocket(reason); }
      };

      request.raw.on('close', () => finish());
      request.raw.on('error', () => finish());
      socket.on('close', () => finish());
      socket.on('error', () => finish());
      if (socket.destroyed || request.raw.aborted) { finish(); return; }

      try {
        release = await events.subscribe(session.id, (event) => {
          if (finished) return;
          if (events.durable) {
            if (!replaying) void catchUp().catch(() => finish('stream-error'));
            return;
          }
          if (replaying) {
            pendingBytes += Buffer.byteLength(frame(event));
            if (pendingBytes > options.maxBufferedBytes) { finish('slow-consumer'); return; }
            pending.push(event);
            return;
          }
          deliver(event);
        });
        if (finished) {
          // The client hung up while the subscription was being established, so
          // nothing else will ever release it.
          release();
          return;
        }


        if (events.durable) await catchUp();
        else for await (const event of events.replay(session.id, resumeFrom)) {
          if (finished) break;
          deliver(event);

        }
        replaying = false;
        if (events.durable) await catchUp();
        for (const event of pending) {
          // Whatever arrived during the replay and was already in it.
          deliver(event);
        }
        pending.length = 0;
        const current = await sessions.readOwned(user.uid, session.id);
        write(`event: session.state\ndata: ${JSON.stringify(toResponse(current))}\n\n`);
      } catch (error) {
        // The response is hijacked, so the error handler can no longer reply.
        // All that is left is to log it and hang up, which the client sees as a
        // dropped stream and retries.
        request.log.error({ diagnostic: safeErrorDiagnostic(error), sessionId: session.id }, 'event stream failed to start');
        finish('stream-error');
      }
    },
  );
}
