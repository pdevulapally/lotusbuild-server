import type { FastifyInstance } from 'fastify';
import { authenticatedUser } from '../auth/plugin.ts';
import { AppError } from '../http/errors.ts';
import type { ProjectRepository } from '../projects/repository.ts';
import type { SessionRepository } from '../sessions/repository.ts';
import { promptMaxLength } from '../sessions/repository.ts';
import type { FamilyService } from './service.ts';

const id = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' };
const pagination = { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 }, after: id } };
type Page = { limit?: number; after?: string };
export function registerFamilyRoutes(app: FastifyInstance, family: FamilyService, projects: ProjectRepository, sessions: SessionRepository) {
  const write = [app.requireAuth, app.enforceRateLimit('write')];
  const read = [app.requireAuth, app.enforceRateLimit('read')];
  app.post<{ Params: { projectId: string }; Body: { prompt: string; model: string } }>('/family/projects/:projectId/build-requests', {
    preHandler: write, schema: { params: { type: 'object', required: ['projectId'], properties: { projectId: id } },
      body: { type: 'object', required: ['prompt', 'model'], additionalProperties: false, properties: {
        prompt: { type: 'string', minLength: 1, maxLength: promptMaxLength, pattern: '^[^\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]+$' },
        model: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' },
      } } },
  }, async (request, reply) => reply.code(202).send(await family.requestBuild(authenticatedUser(request).uid, request.params.projectId, request.body)));
  app.get<{ Params: { childUid: string }; Querystring: Page }>('/family/children/:childUid/build-requests', {
    preHandler: read, schema: { querystring: pagination, params: { type: 'object', required: ['childUid'], properties: { childUid: id } } },
  }, async (request) => { const requests = await family.buildRequests(authenticatedUser(request), request.params.childUid, request.query.limit ?? 100, request.query.after); return { requests, nextCursor: requests.length === (request.query.limit ?? 100) ? requests.at(-1)!.projectId : null }; });
  app.post<{ Params: { childUid: string; projectId: string }; Body: { requestId: string; approved: boolean } }>('/family/children/:childUid/projects/:projectId/build-requests/decision', {
    preHandler: [app.requireAuth, app.enforceRateLimit('build')], schema: {
      params: { type: 'object', required: ['childUid', 'projectId'], properties: { childUid: id, projectId: id } },
      body: { type: 'object', required: ['requestId', 'approved'], additionalProperties: false, properties: { requestId: id, approved: { type: 'boolean' } } },
    },
  }, async (request) => family.decideBuild(authenticatedUser(request), request.params.childUid, request.params.projectId, request.body.requestId, request.body.approved, sessions));
  app.post<{ Body: { adultConfirmed: boolean; parentalResponsibilityConfirmed: boolean } }>('/family/invitations', {
    preHandler: write, schema: { body: { type: 'object', additionalProperties: false,
      required: ['adultConfirmed', 'parentalResponsibilityConfirmed'], properties: {
        adultConfirmed: { const: true }, parentalResponsibilityConfirmed: { const: true },
      } } },
  }, async (request, reply) => { reply.header('Cache-Control', 'no-store'); return reply.code(201).send(await family.invite(authenticatedUser(request), request.body)); });
  app.post<{ Body: { parentUid: string; token: string } }>('/family/accept', {
    preHandler: write, schema: { body: { type: 'object', additionalProperties: false, required: ['parentUid', 'token'],
      properties: { parentUid: id, token: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' } } } },
  }, async (request, reply) => reply.code(202).send(await family.accept(authenticatedUser(request), request.body.parentUid, request.body.token)));
  app.get<{ Querystring: Page }>('/family/children', { preHandler: read, schema: { querystring: pagination } }, async (request) => { const children = await family.children(authenticatedUser(request), request.query.limit ?? 100, request.query.after); return { children, nextCursor: children.length === (request.query.limit ?? 100) ? children.at(-1)!.childUid : null }; });
  app.patch<{ Params: { childUid: string }; Body: { approved: boolean } }>('/family/children/:childUid', {
    preHandler: write, schema: { params: { type: 'object', required: ['childUid'], properties: { childUid: id } },
      body: { type: 'object', additionalProperties: false, required: ['approved'], properties: { approved: { type: 'boolean' } } } },
  }, async (request, reply) => { await family.confirm(authenticatedUser(request), request.params.childUid, request.body.approved); return reply.code(204).send(); });
  app.patch<{ Params: { childUid: string; projectId: string }; Body: { enabled: boolean } }>('/family/children/:childUid/projects/:projectId', {
    preHandler: write, schema: { params: { type: 'object', required: ['childUid', 'projectId'], properties: { childUid: id, projectId: id } },
      body: { type: 'object', additionalProperties: false, required: ['enabled'], properties: { enabled: { type: 'boolean' } } } },
  }, async (request, reply) => { await family.grant(authenticatedUser(request), request.params.childUid, request.params.projectId, request.body.enabled); return reply.code(204).send(); });
  app.get<{ Params: { projectId: string } }>('/family/projects/:projectId', {
    preHandler: read, schema: { params: { type: 'object', required: ['projectId'], properties: { projectId: id } } },
  }, async (request) => {
    const parent = await family.parentForProject(authenticatedUser(request).uid, request.params.projectId);
    const project = await projects.readOwned(parent, request.params.projectId);
    return { id: project.id, name: project.name, platform: project.platform, access: 'parent-supervised', permissions: ['read', 'request-build'] };
  });
  app.get<{ Params: { projectId: string; sessionId: string } }>('/family/projects/:projectId/sessions/:sessionId/messages', {
    preHandler: read, schema: { params: { type: 'object', required: ['projectId', 'sessionId'], properties: { projectId: id, sessionId: id } } },
  }, async (request) => {
    const parent = await family.parentForProject(authenticatedUser(request).uid, request.params.projectId);
    const session = await sessions.readOwned(parent, request.params.sessionId);
    if (session.projectId !== request.params.projectId) {
      throw new AppError({ code: 'session/not-found', statusCode: 404, message: 'No such session.' });
    }
    return { messages: await sessions.listMessages(parent, session.id, 100) };
  });
}
