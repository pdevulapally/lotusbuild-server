import type { FastifyInstance } from 'fastify';

import { authenticatedUser } from '../auth/plugin.ts';
import { AppError } from '../http/errors.ts';
import {
  attachmentIdPattern,
  imageMediaTypes,
  isImageMediaType,
  maxAttachmentBytes,
  type AttachmentStore,
} from './store.ts';

/**
 * Image uploads for prompts. The body is the raw image, typed by Content-Type,
 * so a 5 MB photo is one request rather than a base64 blob inside JSON that the
 * global body limit would refuse. Uploads are owner-scoped and referenced from
 * messages by id; nothing here reads or alters a session.
 */
export function registerAttachmentRoutes(app: FastifyInstance, attachments: AttachmentStore): void {
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      [...imageMediaTypes],
      { parseAs: 'buffer', bodyLimit: maxAttachmentBytes },
      (_request, body, done) => { done(null, body); },
    );

    scope.post(
      '/attachments',
      {
        preHandler: [app.requireAuth, app.requireVerifiedEmail, app.enforceRateLimit('build')],
        bodyLimit: maxAttachmentBytes,
      },
      async (request, reply) => {
        const user = authenticatedUser(request);
        const mediaType = (request.headers['content-type'] ?? '').split(';')[0]?.trim() ?? '';
        if (!isImageMediaType(mediaType) || !Buffer.isBuffer(request.body)) {
          throw new AppError({ code: 'attachment/unsupported-type', statusCode: 415,
            message: 'Attach a PNG, JPEG, WebP or GIF image.' });
        }
        const stored = await attachments.save(user.uid, mediaType, request.body);
        return reply.code(201).send(stored);
      },
    );
  });

  app.get<{ Params: { attachmentId: string } }>(
    '/attachments/:attachmentId',
    {
      preHandler: [app.requireAuth],
      schema: {
        params: {
          type: 'object',
          required: ['attachmentId'],
          additionalProperties: false,
          properties: { attachmentId: { type: 'string', pattern: attachmentIdPattern } },
        },
      },
    },
    async (request, reply) => {
      const user = authenticatedUser(request);
      const content = await attachments.read(user.uid, request.params.attachmentId);
      return reply
        .header('Content-Type', content.mediaType)
        .header('Cache-Control', 'private, max-age=31536000, immutable')
        .header('Content-Disposition', 'inline')
        .header('X-Content-Type-Options', 'nosniff')
        .send(content.data);
    },
  );
}
