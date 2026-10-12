import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { authenticatedUser } from '../auth/plugin.ts';
import { AppError } from '../http/errors.ts';
import type { SessionRepository } from '../sessions/repository.ts';
import { toMessageResponse } from '../sessions/routes.ts';
import type { ProjectFiles } from './files.ts';
import { type ProjectRepository, type ProjectVisibility, projectVisibilities } from './repository.ts';

const projectParams = {
  type: 'object', required: ['projectId'], additionalProperties: false,
  properties: { projectId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' } },
} as const;
const ref = { type: 'string', minLength: 1, maxLength: 255, pattern: '^[A-Za-z0-9._/-]+$' } as const;
const path = { type: 'string', minLength: 1, maxLength: 1024 } as const;
const sha = { type: 'string', pattern: '^[0-9a-f]{40,64}$' } as const;
const token = { type: 'string', pattern: '^[A-Za-z0-9_-]{32}$' } as const;
const query = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'object', additionalProperties: false, required, properties }) as const;

/** Shared views are anonymous, so they are limited per client address rather than per plan. */
const sharedRequestsPerMinute = 60;

export function registerProjectContentRoutes(app: FastifyInstance, projects: ProjectRepository, files: ProjectFiles, sessions: SessionRepository): void {
  const read = [app.requireAuth, app.enforceRateLimit('read')];
  let limiter: ReturnType<FastifyInstance['createRateLimit']> | undefined;
  const sharedLimit = async (request: FastifyRequest, reply: FastifyReply) => {
    limiter ??= app.createRateLimit({ max: sharedRequestsPerMinute, timeWindow: 60_000, keyGenerator: (item) => `shared:${item.ip}` });
    const result = await limiter(request);
    if (!result.isAllowed && result.isExceeded) {
      reply.header('retry-after', String(result.ttlInSeconds));
      throw new AppError({ code: 'rate-limit/exceeded', statusCode: 429, message: 'Too many requests. Try again shortly.' });
    }
    reply.header('cache-control', 'no-store');
    reply.header('x-robots-tag', 'noindex, nofollow');
  };

  app.get<{ Params: { projectId: string }; Querystring: { ref?: string } }>('/projects/:projectId/files', {
    preHandler: read, schema: { params: projectParams, querystring: query({ ref }) },
  }, async (request) => files.tree(await projects.readOwned(authenticatedUser(request).uid, request.params.projectId), request.query.ref));

  app.get<{ Params: { projectId: string }; Querystring: { path: string; ref?: string } }>('/projects/:projectId/files/content', {
    preHandler: read, schema: { params: projectParams, querystring: query({ path, ref }, ['path']) },
  }, async (request) => files.read(await projects.readOwned(authenticatedUser(request).uid, request.params.projectId), request.query.path, request.query.ref));

  app.get<{ Params: { projectId: string }; Querystring: { ref?: string } }>('/projects/:projectId/archive', {
    preHandler: [app.requireAuth, app.enforceRateLimit('write')], schema: { params: projectParams, querystring: query({ ref }) },
  }, async (request, reply) => {
    const project = await projects.readOwned(authenticatedUser(request).uid, request.params.projectId);
    const zip = await files.archive(project, request.query.ref);
    const slug = project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'project';
    return reply
      .header('cache-control', 'no-store')
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="${slug}.zip"`)
      .send(zip);
  });
  app.get<{ Params: { projectId: string } }>('/projects/:projectId/changes', {
    preHandler: read, schema: { params: projectParams },
  }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return files.history(await projects.readOwned(authenticatedUser(request).uid, request.params.projectId));
  });
  app.get<{ Params: { projectId: string; sha: string } }>('/projects/:projectId/changes/:sha', {
    preHandler: read,
    schema: { params: { type: 'object', required: ['projectId', 'sha'], additionalProperties: false, properties: { ...projectParams.properties, sha } } },
  }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return files.changes(await projects.readOwned(authenticatedUser(request).uid, request.params.projectId), request.params.sha);
  });
  app.get<{ Params: { projectId: string } }>('/projects/:projectId/share', {
    preHandler: read, schema: { params: projectParams },
  }, async (request, reply) => {
    const project = await projects.readOwned(authenticatedUser(request).uid, request.params.projectId);
    reply.header('cache-control', 'no-store');
    return { visibility: project.visibility, shareToken: project.visibility === 'link' ? project.shareToken ?? null : null };
  });

  app.patch<{ Params: { projectId: string }; Body: { visibility: ProjectVisibility; rotateLink?: boolean } }>('/projects/:projectId/visibility', {
    preHandler: [app.requireAuth, app.enforceRateLimit('write')],
    schema: { params: projectParams, body: { type: 'object', required: ['visibility'], additionalProperties: false,
      properties: { visibility: { type: 'string', enum: [...projectVisibilities] }, rotateLink: { type: 'boolean' } } } },
  }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return projects.setVisibility(authenticatedUser(request).uid, request.params.projectId, request.body.visibility, request.body.rotateLink === true);
  });

  app.get<{ Params: { projectId: string }; Querystring: { token?: string } }>('/shared/projects/:projectId', {
    preHandler: sharedLimit, schema: { params: projectParams, querystring: query({ token }) },
  }, async (request) => {
    const project = await projects.readShared(request.params.projectId, request.query.token);
    const messages = await sessions.sharedTranscript(project.id, 100);
    return { project: { id: project.id, name: project.name, visibility: project.visibility, createdAt: project.createdAt.toISOString() }, messages: messages.map(toMessageResponse) };
  });

  app.get<{ Params: { projectId: string }; Querystring: { token?: string; ref?: string } }>('/shared/projects/:projectId/files', {
    preHandler: sharedLimit, schema: { params: projectParams, querystring: query({ token, ref }) },
  }, async (request) => files.tree(await projects.readShared(request.params.projectId, request.query.token), request.query.ref));

  app.get<{ Params: { projectId: string }; Querystring: { token?: string; path: string; ref?: string } }>('/shared/projects/:projectId/files/content', {
    preHandler: sharedLimit, schema: { params: projectParams, querystring: query({ token, path, ref }, ['path']) },
  }, async (request) => files.read(await projects.readShared(request.params.projectId, request.query.token), request.query.path, request.query.ref));
}
