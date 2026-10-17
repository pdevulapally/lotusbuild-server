import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { configurationKeys } from '../config/index.ts';
import { MutationReplay } from './mutation-response.ts';

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

// Logging allowlists, not a domain-code registry: unknown codes remain explicit
// generic categories. Never copy message, stack, details or arbitrary properties.
const diagnosticCodes = new Set([
  'session/model-unavailable', 'session/effort-unsupported', 'session/effort-not-permitted',
  'release/recovery-protocol-incompatible', 'session/recovery-protocol-incompatible',
  'usage/limit-reached', 'usage/reconciliation-required', 'entitlement/misconfigured',
  'session/cancelled', 'session/lease-lost', 'session/project-guard-lost',
  'session/project-state-inconsistent', 'session/workspace-unrecoverable', 'session/not-found',
  'session/ai-not-permitted', 'session/model-not-permitted', 'session/platform-not-permitted',
  'account/erasure-pending', 'account/reconciliation-required', 'project/deleting', 'project/not-found',
  'project/persistence-failed', 'sandbox/platform-unconfigured', 'billing/provider-unavailable',
  'billing/bad-signature', 'session/no-desktop', 'desktop/capacity-reached', 'auth/token-invalid', 'auth/token-expired', 'auth/token-revoked', 'auth/email-not-verified',
  'runner/shutdown', 'runner/execution-failed',
]);
const diagnosticStages = new Set([
  'runner/work-failed', 'workspace/salvage-authorization-failed', 'workspace/salvage-failed',
  'sandbox/recovery-failed', 'workspace/terminalization-failed', 'workspace/save-failed',
  'workspace/save-and-cleanup-failed', 'workspace/save-failed-without-mutations',
  'sandbox/cleanup-failed', 'session/finalization-failed',
]);

export interface SafeErrorDiagnostic {
  readonly category: string;
  readonly statusCode?: number;
  readonly exitCode?: number;
  readonly primaryCategory?: string;
  readonly secondaryStage?: string;
  readonly configurationKeys?: readonly string[];
  readonly nestedCount?: number;
  readonly nestedCategories?: readonly string[];
  readonly truncated?: boolean;
}

/** Own data only: no getters, toJSON, coercion or enumeration of provider payloads. */
function diagnosticField(value: unknown, key: string): unknown {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return undefined;
  try { return Object.getOwnPropertyDescriptor(value, key)?.value as unknown; }
  catch { return undefined; }
}

/** Safe at Pino and stderr boundaries. At most 16 nodes, 8 children/node, depth 3. */
export function safeErrorDiagnostic(error: unknown): SafeErrorDiagnostic {
  const seen = new Set<unknown>();
  let remaining = 16;
  const visit = (value: unknown, depth: number): SafeErrorDiagnostic => {
    if (remaining-- <= 0 || depth > 3 || seen.has(value)) return { category: 'error/unknown', truncated: true };
    if (typeof value === 'object' && value !== null) seen.add(value);
    const code = diagnosticField(value, 'code');
    const name = diagnosticField(value, 'name');
    const primary = diagnosticField(value, 'primaryCategory');
    const secondary = diagnosticField(value, 'secondaryStage');
    const errors: unknown = Array.isArray(value) ? value : diagnosticField(value, 'errors');
    const cause = diagnosticField(value, 'cause');
    const problems = name === 'EnvironmentError' ? diagnosticField(value, 'problems') : undefined;
    const invalidKeys = new Set<string>();
    if (Array.isArray(problems)) {
      for (let i = 0; i < Math.min(problems.length, 64); i++) {
        const problem = diagnosticField(problems, String(i));
        if (typeof problem === 'string') {
          for (const key of configurationKeys) if (problem.startsWith(key + ' ')) invalidKeys.add(key);
        }
      }
    }
    const category = value instanceof AppError ? typeof code === 'string' && code.length <= 64 && diagnosticCodes.has(code) ? code : 'application/error'
      : name === 'RunnerWorkError' ? 'runner/work-failed'
        : Array.isArray(errors) ? 'error/aggregate'
          : name === 'EnvironmentError' ? 'configuration/invalid'
            : value instanceof Error ? 'error/runtime' : 'error/unknown';
    const status = diagnosticField(value, 'statusCode') ?? diagnosticField(value, 'status');
    const exit = diagnosticField(value, 'exitCode');
    const count = (Array.isArray(errors) ? errors.length : 0) + (cause === undefined ? 0 : 1);
    const nested: SafeErrorDiagnostic[] = [];
    const inspectChild = (child: unknown) => { if (nested.length < 8 && remaining > 0) nested.push(visit(child, depth + 1)); };
    if (cause !== undefined) inspectChild(cause);
    if (Array.isArray(errors)) {
      for (let i = 0; i < Math.min(errors.length, 8) && nested.length < 8 && remaining > 0; i++) {
        inspectChild(diagnosticField(errors, String(i)));
      }
    }
    return {
      category,
      ...(invalidKeys.size > 0 ? { configurationKeys: [...invalidKeys] } : {}),
      ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? { statusCode: status } : {}),
      ...(typeof exit === 'number' && Number.isInteger(exit) && exit >= -128 && exit <= 255 ? { exitCode: exit } : {}),
      ...(name === 'RunnerWorkError' && typeof primary === 'string' && primary.length <= 64 && diagnosticCodes.has(primary) ? { primaryCategory: primary } : {}),
      ...(name === 'RunnerWorkError' && typeof secondary === 'string' && secondary.length <= 64 && diagnosticStages.has(secondary) ? { secondaryStage: secondary } : {}),
      ...(count > 0 ? { nestedCount: count, nestedCategories: nested.flatMap((item) => [item.category, ...(item.nestedCategories ?? [])]).slice(0, 16) } : {}),
      ...(count > nested.length || nested.some((item) => item.truncated) ? { truncated: true } : {}),
    };
  };
  // Revoked/hostile proxies can reject even instanceof/Array.isArray. Reporting
  // a diagnostic must never replace the original failure with a sanitizer error.
  try { return visit(error, 0); }
  catch { return { category: 'error/unknown' }; }
}

/** SDK log arguments include request bodies and URLs, even at non-error levels. */
export function safeProviderLogger(log: Record<'error' | 'warn' | 'info' | 'debug', (details: object, message: string) => void>, provider: 'anthropic') {
  const write = (level: 'error' | 'warn' | 'info' | 'debug') => (...args: unknown[]): void => {
    log[level]({ provider, diagnostic: safeErrorDiagnostic(args) }, 'provider diagnostic');
  };
  return { error: write('error'), warn: write('warn'), info: write('info'), debug: write('debug') };
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
    if (error instanceof MutationReplay) {
      return reply.code(error.response.statusCode).send(error.response.body);
    }
    if (error instanceof AppError) {
      if (error.statusCode >= 500) {
        // Internal configuration values and provider diagnostics are not public
        // domain errors. Keep a stable code for support without echoing data.
        request.log.error({ diagnostic: safeErrorDiagnostic(error), requestId: request.id }, 'internal request failure');
        return reply.code(error.statusCode).send(
          body(error.code, 'The request could not be completed. Contact support with this request ID.', request.id),
        );
      }
      request.log.info(
        { diagnostic: safeErrorDiagnostic(error) },
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
      request.log.info({ diagnostic: safeErrorDiagnostic(error) }, 'request rejected');
      return reply
        .code(status)
        .send(
          body('request/invalid', error.message, request.id, {
            reason: error.code ?? 'unspecified',
          }),
        );
    }

    request.log.error({ diagnostic: safeErrorDiagnostic(error) }, 'unhandled error');
    return reply
      .code(500)
      .send(body('internal/unexpected', 'An unexpected error occurred.', request.id));
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) =>
    reply.code(404).send(body('request/not-found', 'No route matches this request.', request.id)),
  );
}
