import type { FastifyInstance } from 'fastify';

import { authenticatedUser } from '../auth/plugin.ts';
import type { EntitlementService } from '../entitlements/service.ts';
import { AppError } from '../http/errors.ts';
import { uploadBudgetFor, type UploadBudgetGuard } from './budget.ts';
import { assertImageMatches, inspectImage, stripMetadata } from './image.ts';
import {
  attachmentIdPattern,
  imageMediaTypes,
  isImageMediaType,
  maxAttachmentBytes,
  type AttachmentStore,
} from './store.ts';

export interface AttachmentRouteDependencies {
  readonly store: AttachmentStore;
  readonly entitlements: EntitlementService;
  readonly budget: UploadBudgetGuard;
}

const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' } as const;

/**
 * Image uploads for prompts. The body is the raw image, typed by Content-Type,
 * so a 5 MB photo is one request rather than a base64 blob inside JSON that the
 * global body limit would refuse. Uploads are owner-scoped and referenced from
 * messages by id; nothing here reads or alters a session.
 */
export function registerAttachmentRoutes(app: FastifyInstance, { store: attachments, entitlements, budget }: AttachmentRouteDependencies): void {
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
        // Bytes first: the declared type is only a claim until the header agrees.
        const info = inspectImage(request.body);
        assertImageMatches(info, mediaType);
        const resolved = await entitlements.forUser(user.uid);
        const build = resolved.rateLimits.get('build');
        if (build === undefined) {
          throw new AppError({ code: 'config/rate-limit-missing', statusCode: 500, message: `Plan "${resolved.planKey}" declares no "build" rate limit.` });
        }
        const release = await budget.reserve(user.uid, request.body.byteLength, uploadBudgetFor(build));
        try {
          const stored = await attachments.save(user.uid, mediaType, stripMetadata(request.body, mediaType));
          return await reply.code(201).send({ ...stored, width: info.width, height: info.height });
        } catch (error) {
          await release().catch(() => undefined);
          throw error;
        }
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
      // Served as an opaque image: no scripts, no document context, no sniffing into HTML.
      return reply
        .header('Content-Type', content.mediaType)
        .header('Content-Length', String(content.data.byteLength))
        .header('Cache-Control', 'private, max-age=31536000, immutable')
        .header('Content-Disposition', `inline; filename="${content.id}.${extensions[content.mediaType]}"`)
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .header('X-Content-Type-Options', 'nosniff')
        .send(content.data);
    },
  );
}
