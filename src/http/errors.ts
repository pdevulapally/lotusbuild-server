import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * The single error shape the API ever returns:
 *
 *   { "error": { "code": "auth/token-expired", "message": "...", "details": {...} },
 *     "requestId": "req-7" }
 *
 * `code` is the stable contract — clients branch on it, never on `message`.
 * `details` carries only values we have deliberately decided are safe to expose;
 * an internal failure must never reach the client as a message, because error
 * text is where stack traces, file paths and query fragments leak.
 */
export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(args: {
    code: string;
    statusCode: number;
    message: string;
    details?: Readonly<Record<string, unknown>>;
    cause?: unknown;
  }) {
    super(args.message, args.cause === undefined ? undefined : { cause: args.cause });
    this.name = 'AppError';
    this.code = args.code;
    this.statusCode = args.statusCode;
    this.details = args.details;
  }
}

interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
  readonly requestId: string;
}

function body(
  code: string,
  message: string,
  requestId: string,
  details?: Readonly<Record<string, unknown>>,
): ErrorBody {
  return { error: details === undefined ? { code, message } : { code, message, details }, requestId };
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | AppError, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof AppError) {
      request.log.info(
        { code: error.code, statusCode: error.statusCode },
        'request rejected',
      );
      return reply
        .code(error.statusCode)
        .send(body(error.code, error.message, request.id, error.details));
    }

    // Schema validation rejected the request before the handler ran. The
    // validation text describes the client's own payload, so it is safe to echo.
    if ('validation' in error && error.validation !== undefined) {
      return reply
        .code(400)
        .send(body('request/invalid', error.message, request.id));
    }

    // Fastify's own errors — a body that is not JSON, an empty one where a body
    // was required, a payload past the limit, a content type nothing parses —
    // describe what the caller sent and already carry the right status. Letting
    // them fall through to 500 blames us for their mistake, and hides a
    // four-hundred-class problem behind a page that says nothing.
    const status = (error as FastifyError).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      request.log.info({ code: error.code, statusCode: status }, 'request rejected');
      return reply
        .code(status)
        .send(
          body('request/invalid', error.message, request.id, {
            reason: error.code ?? 'unspecified',
          }),
        );
    }

    // Anything else is our bug. Log it in full, tell the client nothing.
    request.log.error({ err: error }, 'unhandled error');
    return reply
      .code(500)
      .send(body('internal/unexpected', 'An unexpected error occurred.', request.id));
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) =>
    reply.code(404).send(body('request/not-found', 'No route matches this request.', request.id)),
  );
}
