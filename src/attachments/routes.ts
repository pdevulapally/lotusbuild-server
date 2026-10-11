import type { FastifyInstance } from 'fastify';

import { authenticatedUser } from '../auth/plugin.ts';
import {
  attachmentContentTypes,
  attachmentMaxBytes,
  attachmentNameMaxLength,
  attachmentsPerMessageMax,
} from '../storage/attachments.ts';
import type { Attachment, AttachmentRepository } from './repository.ts';

const documentId = '^[A-Za-z0-9_-]{1,128}$';

export const attachmentLimits = {
  maxBytes: attachmentMaxBytes,
  maxPerMessage: attachmentsPerMessageMax,
  contentTypes: [...attachmentContentTypes],
} as const;

function toResponse(attachment: Attachment) {
  return {
    id: attachment.id,
    projectId: attachment.projectId,
    name: attachment.name,
    contentType: attachment.contentType,
    bytes: attachment.bytes,
    status: attachment.status,
    expiresAt: attachment.expiresAt.toISOString(),
    createdAt: attachment.createdAt.toISOString(),
  };
}

export function registerAttachmentRoutes(app: FastifyInstance, attachments: AttachmentRepository): void {
  app.post<{ Params: { projectId: string }; Body: { name: string; contentType: string; bytes: number } }>(
    '/projects/:projectId/attachments',
    {
      preHandler: [app.requireAuth, app.requireVerifiedEmail, app.enforceRateLimit('write')],
      schema: {
        params: { type: 'object', required: ['projectId'], additionalProperties: false,
          properties: { projectId: { type: 'string', pattern: documentId } } },
        body: { type: 'object', required: ['name', 'contentType', 'bytes'], additionalProperties: false, properties: {
          name: { type: 'string', minLength: 1, maxLength: attachmentNameMaxLength },
          contentType: { type: 'string', enum: [...attachmentContentTypes] },
          bytes: { type: 'integer', minimum: 1, maximum: attachmentMaxBytes },
        } },
      },
    },
    async (request, reply) => {
      const user = authenticatedUser(request);
      const { attachment, uploadUrl } = await attachments.begin(user.uid, request.params.projectId, request.body);
      return reply.code(201).send({
        attachment: toResponse(attachment),
        upload: {
          method: 'PUT',
          url: uploadUrl,
          headers: { 'Content-Type': attachment.contentType, 'Content-Length': String(attachment.bytes), 'x-goog-if-generation-match': '0' },
        },
      });
    },
  );

  app.post<{ Params: { attachmentId: string } }>(
    '/attachments/:attachmentId/complete',
    {
      preHandler: [app.requireAuth, app.requireVerifiedEmail, app.enforceRateLimit('write')],
      schema: { params: { type: 'object', required: ['attachmentId'], additionalProperties: false,
        properties: { attachmentId: { type: 'string', pattern: documentId } } } },
    },
    async (request) => toResponse(await attachments.complete(authenticatedUser(request).uid, request.params.attachmentId)),
  );

  app.delete<{ Params: { attachmentId: string } }>(
    '/attachments/:attachmentId',
    {
      preHandler: [app.requireAuth, app.enforceRateLimit('write')],
      schema: { params: { type: 'object', required: ['attachmentId'], additionalProperties: false,
        properties: { attachmentId: { type: 'string', pattern: documentId } } } },
    },
    async (request, reply) => {
      await attachments.remove(authenticatedUser(request).uid, request.params.attachmentId);
      return reply.code(204).send();
    },
  );
}
