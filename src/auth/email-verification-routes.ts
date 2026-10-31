import type { FastifyInstance } from 'fastify';

import { authenticatedUser } from './plugin.ts';
import type { EmailVerificationService } from './email-verification.ts';

const codeBody = {
  type: 'object',
  required: ['code'],
  additionalProperties: false,
  properties: {
    code: { type: 'string', pattern: '^[0-9]{6}$' },
  },
} as const;

export function registerEmailVerificationRoutes(
  app: FastifyInstance,
  verification: EmailVerificationService,
): void {
  app.post('/auth/email-verification/code', {
    preHandler: [app.requireAuth, app.enforceRateLimit('write')],
  }, async (request, reply) => {
    const user = authenticatedUser(request);
    if (user.emailVerified) {
      return { verified: true, expiresInSeconds: 0, resendAfterSeconds: 0 };
    }
    const sent = await verification.send(user.uid);
    reply.header('cache-control', 'no-store');
    return { verified: sent.expiresInSeconds === 0, ...sent };
  });

  app.post<{ Body: { code: string } }>('/auth/email-verification/verify', {
    preHandler: [app.requireAuth, app.enforceRateLimit('write')],
    schema: { body: codeBody },
  }, async (request, reply) => {
    const user = authenticatedUser(request);
    if (!user.emailVerified) {
      await verification.verify(user.uid, request.body.code);
    }
    reply.header('cache-control', 'no-store');
    return { verified: true };
  });
}
