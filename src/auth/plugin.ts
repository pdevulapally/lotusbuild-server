import type { Auth } from 'firebase-admin/auth';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';

import { AppError } from '../http/errors.ts';

export interface AuthenticatedUser {
  readonly uid: string;
  readonly email: string | undefined;
  readonly emailVerified: boolean;
  readonly displayName: string | undefined;
  readonly photoUrl: string | undefined;
  /** Seconds since the epoch, from the token. Used to reject stale sessions. */
  readonly authTime: number;
  readonly expiresAt?: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthenticatedUser;
  }
  interface FastifyInstance {
    requireAuth: preHandlerHookHandler;
  }
}

/**
 * Reads the identity a `requireAuth` route established. Handlers must not touch
 * `request.auth` directly: an unauthenticated route would hand them `undefined`
 * and the mistake would surface as a crash on a live request rather than here.
 */
export function authenticatedUser(request: FastifyRequest): AuthenticatedUser {
  if (request.auth === undefined) {
    throw new Error(
      `Route ${request.method} ${request.routeOptions.url ?? request.url} read the authenticated ` +
        'user without registering the requireAuth preHandler.',
    );
  }
  return request.auth;
}

export function bearerToken(header: string | undefined): string {
  if (header === undefined) {
    throw new AppError({
      code: 'auth/missing-token',
      statusCode: 401,
      message: 'This endpoint requires an Authorization header.',
    });
  }

  // Exactly two parts: a scheme and a token. Splitting loosely would accept
  // "Bearer a b" and pass "a" on as if the request were well formed.
  const parts = header.split(' ');
  const [scheme, token] = parts;
  if (parts.length !== 2 || scheme === undefined || token === undefined || scheme.toLowerCase() !== 'bearer') {
    throw new AppError({
      code: 'auth/malformed-header',
      statusCode: 401,
      message: 'The Authorization header must be "Bearer <firebase-id-token>".',
    });
  }

  return token;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** Firebase error codes we can explain to the client without guessing. */
const tokenFailureCodes: ReadonlyMap<string, string> = new Map([
  ['auth/id-token-expired', 'auth/token-expired'],
  ['auth/id-token-revoked', 'auth/token-revoked'],
  ['auth/user-disabled', 'auth/user-disabled'],
]);

export function registerAuth(app: FastifyInstance, firebaseAuth: Auth): void {
  const requireAuth: preHandlerHookHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const token = bearerToken(request.headers.authorization);

    let decoded;
    try {
      // Lockdown must invalidate a stolen token before its normal expiry.
      decoded = await firebaseAuth.verifyIdToken(token, true);
    } catch (cause) {
      const firebaseCode =
        typeof cause === 'object' && cause !== null && 'code' in cause
          ? String((cause as { code: unknown }).code)
          : undefined;

      const code =
        firebaseCode === undefined ? undefined : tokenFailureCodes.get(firebaseCode);

      request.log.info({ firebaseCode }, 'id token rejected');

      throw new AppError({
        code: code ?? 'auth/token-invalid',
        statusCode: 401,
        message: 'The supplied Firebase ID token is not valid.',
        cause,
      });
    }

    request.auth = Object.freeze({
      expiresAt: decoded.exp,
      uid: decoded.uid,
      email: decoded.email,
      emailVerified: decoded.email_verified === true,
      // "name" is not a declared claim on DecodedIdToken, only reachable through
      // its index signature, so its type is checked rather than trusted.
      displayName: nonEmptyString(decoded['name']),
      photoUrl: nonEmptyString(decoded.picture),
      authTime: decoded.auth_time,
    });
    reply.header('Cache-Control', 'no-store');
  };

  app.decorate('requireAuth', requireAuth);
  app.decorateRequest('auth', undefined);
}
