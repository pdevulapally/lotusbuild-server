import type { FastifyInstance } from 'fastify';

import { authenticatedUser } from '../auth/plugin.ts';
import { mutation } from '../http/idempotency.ts';
import { skillLimits, skillNamePattern, type Skill, type SkillInput } from './model.ts';
import type { SkillRepository } from './repository.ts';

const documentId = '^[A-Za-z0-9_-]{1,128}$';

export function toSkillResponse(skill: Skill) {
  return {
    id: skill.id, name: skill.name, title: skill.title, description: skill.description, instructions: skill.instructions,
    enabled: skill.enabled, createdAt: skill.createdAt.toISOString(), updatedAt: skill.updatedAt.toISOString(),
  };
}

const skillProperties = {
  name: { type: 'string', minLength: 1, maxLength: 48, pattern: skillNamePattern },
  title: { type: 'string', minLength: 1, maxLength: skillLimits.title },
  description: { type: 'string', minLength: 1, maxLength: skillLimits.description },
  instructions: { type: 'string', minLength: 1, maxLength: skillLimits.instructions },
  enabled: { type: 'boolean' },
} as const;
const params = { type: 'object', required: ['skillId'], additionalProperties: false, properties: { skillId: { type: 'string', pattern: documentId } } } as const;

/** A user's skills: owner-scoped, plan-limited, and only ever read by their own agent runs. */
export function registerSkillRoutes(app: FastifyInstance, skills: Pick<SkillRepository, 'list' | 'create' | 'update' | 'delete'>): void {
  app.get('/skills', { preHandler: [app.requireAuth, app.enforceRateLimit('read')] }, async (request) => {
    const user = authenticatedUser(request);
    return { skills: (await skills.list(user.uid)).map(toSkillResponse) };
  });

  app.post<{ Body: SkillInput }>(
    '/skills',
    {
      preHandler: [app.requireAuth, app.requireVerifiedEmail, app.enforceRateLimit('write')],
      schema: { body: { type: 'object', required: ['name', 'title', 'description', 'instructions'], additionalProperties: false, properties: skillProperties } },
    },
    async (request, reply) => {
      const user = authenticatedUser(request);
      const skill = await skills.create(user.uid, request.body,
        mutation<Skill>(user.uid, 'POST /skills', request.headers['idempotency-key'], request.body, (value) => ({ statusCode: 201, body: toSkillResponse(value) })));
      return reply.code(201).send(toSkillResponse(skill));
    },
  );

  app.patch<{ Params: { skillId: string }; Body: Partial<SkillInput> }>(
    '/skills/:skillId',
    {
      preHandler: [app.requireAuth, app.requireVerifiedEmail, app.enforceRateLimit('write')],
      schema: { params, body: { type: 'object', minProperties: 1, additionalProperties: false, properties: skillProperties } },
    },
    async (request) => {
      const user = authenticatedUser(request);
      return toSkillResponse(await skills.update(user.uid, request.params.skillId, request.body));
    },
  );

  app.delete<{ Params: { skillId: string } }>(
    '/skills/:skillId',
    { preHandler: [app.requireAuth, app.requireVerifiedEmail, app.enforceRateLimit('write')], schema: { params } },
    async (request, reply) => {
      const user = authenticatedUser(request);
      await skills.delete(user.uid, request.params.skillId);
      return reply.code(204).send();
    },
  );
}
