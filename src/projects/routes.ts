import type { FastifyInstance } from 'fastify';

import { authenticatedUser } from '../auth/plugin.ts';
import type { Platform } from '../entitlements/schema.ts';
import {
  type Project,
  type ProjectRepository,
  projectDescriptionMaxLength,
  projectNameMaxLength,
} from './repository.ts';

/**
 * Rejects control characters — including the newlines and NULs that turn a
 * stored name into a log-injection or a broken export — while leaving ordinary
 * punctuation and non-Latin scripts alone. Markup is not stripped here: this API
 * returns JSON, and escaping belongs where the value is rendered. Mangling the
 * stored value instead would corrupt legitimate names containing < or &.
 */
const printableLine = '^[^\\u0000-\\u001F\\u007F]+$';

/**
 * Firestore document ids may not contain a slash, and `.`/`..` traverse. An id
 * arriving from the path is concatenated into a document path, so it is
 * constrained before it gets there rather than trusted.
 */
const documentId = '^[A-Za-z0-9_-]{1,128}$';

interface CreateProjectBody {
  readonly name: string;
  readonly description?: string;
}

/**
 * Every new project is a "web" project, because a caller no longer chooses a
 * build type: the product has one workspace, not separate web and mobile ones.
 * The value is still stored and still selects the sandbox provider row and the
 * plan gates keyed by platform, which is why it is not simply removed. A client
 * that still sends `platform` has it dropped by schema validation, not obeyed.
 */
const newProjectPlatform: Platform = 'web';

function toResponse(project: Project) {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    platform: project.platform,
    status: project.status,
    publicPreviewEnabled: project.publicPreviewEnabled === true,
    createdAt: project.createdAt.toISOString(),
  };
}

export function registerProjectRoutes(app: FastifyInstance, projects: ProjectRepository): void {
  app.patch<{ Params: { projectId: string }; Body: { enabled: boolean } }>('/projects/:projectId/public-preview', {
    preHandler: [app.requireAuth, app.enforceRateLimit('write')],
    schema: { params: { type: 'object', required: ['projectId'], additionalProperties: false, properties: { projectId: { type: 'string', pattern: documentId } } },
      body: { type: 'object', required: ['enabled'], additionalProperties: false, properties: { enabled: { type: 'boolean' } } } },
  }, async (request, reply) => {
    const result = await projects.setPublicPreview(authenticatedUser(request).uid, request.params.projectId, request.body.enabled);
    return reply.code(result.terminationPending ? 202 : 200).send({ ...result,
      message: result.terminationPending ? 'Public preview access is being revoked by terminating the active session. Access may persist until sandbox termination succeeds.'
        : result.enabled ? 'Future build previews will be publicly accessible. Anyone with the URL may view and copy their content.' : 'Future build previews will remain private.' });
  });
  app.post<{ Body: CreateProjectBody }>(
    '/projects',
    {
      preHandler: [app.requireAuth, app.requireVerifiedEmail, app.enforceRateLimit('write')],
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: {
            name: {
              type: 'string',
              minLength: 1,
              maxLength: projectNameMaxLength,
              pattern: printableLine,
            },
            description: {
              type: 'string',
              maxLength: projectDescriptionMaxLength,
              pattern: printableLine,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const user = authenticatedUser(request);
      const project = await projects.create(user.uid, {
        name: request.body.name.trim(),
        description: request.body.description?.trim(),
        platform: newProjectPlatform,
      });
      return reply.code(201).send(toResponse(project));
    },
  );

  app.get<{ Querystring: { limit?: number } }>(
    '/projects',
    {
      preHandler: [app.requireAuth, app.enforceRateLimit('read')],
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            // Bounded so a caller cannot ask for a page large enough to hold the
            // whole collection in memory at once.
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
          },
        },
      },
    },
    async (request) => {
      const user = authenticatedUser(request);
      const owned = await projects.listOwnedBy(user.uid, request.query.limit ?? 25);
      return { projects: owned.map(toResponse) };
    },
  );

  app.get<{ Params: { projectId: string } }>(
    '/projects/:projectId',
    {
      preHandler: [app.requireAuth, app.enforceRateLimit('read')],
      schema: {
        params: {
          type: 'object',
          required: ['projectId'],
          additionalProperties: false,
          properties: { projectId: { type: 'string', pattern: documentId } },
        },
      },
    },
    async (request) => {
      const user = authenticatedUser(request);
      return toResponse(await projects.readOwned(user.uid, request.params.projectId));
    },
  );

  app.patch<{
    Params: { projectId: string };
    Body: { name?: string; description?: string };
  }>(
    '/projects/:projectId',
    {
      preHandler: [app.requireAuth, app.enforceRateLimit('write')],
      schema: {
        params: {
          type: 'object',
          required: ['projectId'],
          additionalProperties: false,
          properties: { projectId: { type: 'string', pattern: documentId } },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: {
              type: 'string',
              minLength: 1,
              maxLength: projectNameMaxLength,
              pattern: printableLine,
            },
            description: {
              type: 'string',
              maxLength: projectDescriptionMaxLength,
              pattern: printableLine,
            },
          },
        },
      },
    },
    async (request) => {
      const user = authenticatedUser(request);
      const project = await projects.update(user.uid, request.params.projectId, {
        name: request.body.name?.trim(),
        description: request.body.description?.trim(),
      });
      return toResponse(project);
    },
  );

  app.delete<{ Params: { projectId: string } }>(
    '/projects/:projectId',
    {
      preHandler: [app.requireAuth, app.enforceRateLimit('write')],
      schema: {
        params: {
          type: 'object',
          required: ['projectId'],
          additionalProperties: false,
          properties: { projectId: { type: 'string', pattern: documentId } },
        },
      },
    },
    async (request, reply) => {
      const user = authenticatedUser(request);
      await projects.delete(user.uid, request.params.projectId);
      return reply.code(204).send();
    },
  );
}
