import type { FastifyInstance } from 'fastify';

import { authenticatedUser } from '../auth/plugin.ts';
import { AppError } from '../http/errors.ts';
import { repositoryFullName, type Repository } from '../github/app.ts';
import { type ProjectRepository } from '../projects/repository.ts';
import { projectSourceResponse } from '../projects/routes.ts';
import type { GitHubInstallations } from './github.ts';
import { type ConnectorKey, connectors, isConnectorKey } from './registry.ts';
import { type Connection, ConnectionInactiveError, ConnectionNotFoundError, ConnectionNotGrantedError, type ConnectionRepository } from './service.ts';

export interface ConnectionRouteDependencies {
  /** Undefined until CONNECTION_KEK_V<n> is configured; every route then reports configuration_required. */
  readonly connections: ConnectionRepository | undefined;
  /** Connectors whose provider app credentials exist on this server. */
  readonly configured: ReadonlySet<ConnectorKey>;
  /** Present when GITHUB_APP_* is configured alongside the keyring. */
  readonly github?: GitHubInstallations;
  /** Needed to bind a repository to a project. */
  readonly projects?: ProjectRepository;
}

const documentId = '^[A-Za-z0-9_-]{1,128}$';
const idParams = { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', pattern: documentId } } } as const;
const connectorParams = { type: 'object', required: ['connector'], additionalProperties: false, properties: { connector: { type: 'string', pattern: '^[a-z]{1,16}$' } } } as const;
const grantsBody = { type: 'object', required: ['projectIds'], additionalProperties: false,
  properties: { projectIds: { type: 'array', maxItems: 200, items: { type: 'string', pattern: documentId } } } } as const;
const returnTo = { type: 'string', minLength: 8, maxLength: 2048 } as const;
const startBody = { type: 'object', required: ['returnTo'], additionalProperties: false,
  properties: { returnTo, projectIds: { type: 'array', maxItems: 200, items: { type: 'string', pattern: documentId } } } } as const;
const completeBody = { type: 'object', required: ['state', 'installationId', 'returnTo'], additionalProperties: false,
  properties: { state: { type: 'string', minLength: 16, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' }, installationId: { type: 'integer', minimum: 1 }, returnTo } } as const;
const projectParams = { type: 'object', required: ['projectId'], additionalProperties: false, properties: { projectId: { type: 'string', pattern: documentId } } } as const;
const sourceBody = { type: 'object', required: ['connectionId', 'fullName'], additionalProperties: false,
  properties: { connectionId: { type: 'string', pattern: documentId }, fullName: { type: 'string', minLength: 3, maxLength: 140, pattern: repositoryFullName.source } } } as const;
type IdParams = { id: string };
type ConnectorParams = { connector: string };
type GrantsBody = { projectIds: string[] };
type StartBody = { returnTo: string; projectIds?: string[] };
type CompleteBody = { state: string; installationId: number; returnTo: string };
type ProjectParams = { projectId: string };
type SourceBody = { connectionId: string; fullName: string };

export function publicRepository(repository: Repository) {
  return {
    id: repository.id, fullName: repository.fullName, name: repository.name, owner: repository.owner, private: repository.private,
    defaultBranch: repository.defaultBranch, htmlUrl: repository.htmlUrl,
    ...(repository.pushedAt === undefined ? {} : { pushedAt: repository.pushedAt.toISOString() }),
  };
}

/** What clients see: never the credential document, never raw provider payloads. */
export function publicConnection(connection: Connection, grantedProjectIds?: readonly string[]) {
  return {
    id: connection.id, connector: connection.connector, status: connection.status, scopes: connection.scopes,
    ...(connection.account === undefined ? {} : { account: {
      id: connection.account.id, name: connection.account.name,
      ...(connection.account.team === undefined ? {} : { team: connection.account.team }),
    } }),
    ...(connection.health === undefined ? {} : { health: { ok: connection.health.ok, checkedAt: connection.health.checkedAt.toISOString() } }),
    createdAt: connection.createdAt.toISOString(), updatedAt: connection.updatedAt.toISOString(),
    ...(grantedProjectIds === undefined ? {} : { grantedProjectIds }),
  };
}

export function registerConnectionRoutes(api: FastifyInstance, dependencies: ConnectionRouteDependencies): void {
  const read = [api.requireAuth, api.enforceRateLimit('read')];
  const write = [api.requireAuth, api.requireVerifiedEmail, api.enforceRateLimit('write')];

  const repository = () => {
    if (dependencies.connections === undefined) throw new AppError({
      code: 'connections/configuration-required', statusCode: 503,
      message: 'Integrations are not configured on this server yet.',
    });
    return dependencies.connections;
  };
  const notFound = (error: unknown) => {
    if (error instanceof ConnectionNotFoundError) throw new AppError({ code: 'connections/not-found', statusCode: 404, message: 'Connection not found.' });
    if (error instanceof ConnectionInactiveError) throw new AppError({ code: 'connections/inactive', statusCode: 409, message: 'This connection is not active.' });
    throw error;
  };

  api.get('/connections/catalogue', { preHandler: read }, async () => ({
    connectors: Object.values(connectors).map((definition) => ({
      ...definition,
      status: dependencies.connections === undefined || !dependencies.configured.has(definition.key) ? 'configuration_required' : 'available',
    })),
  }));

  api.get('/connections', { preHandler: read }, async (request) => {
    const user = authenticatedUser(request);
    const list = await repository().listForUser(user.uid);
    return { connections: list.map((connection) => publicConnection(connection)) };
  });

  api.get<{ Params: IdParams }>('/connections/:id', { preHandler: read, schema: { params: idParams } }, async (request) => {
    const user = authenticatedUser(request);
    const { id } = request.params;
    const connections = repository();
    const connection = await connections.read(id, user.uid).catch(notFound);
    const granted = await connections.grantedProjects(id, user.uid);
    return { connection: publicConnection(connection, granted) };
  });

  api.put<{ Params: IdParams; Body: GrantsBody }>('/connections/:id/grants', { preHandler: write, schema: { params: idParams, body: grantsBody } }, async (request) => {
    const user = authenticatedUser(request);
    const { id } = request.params;
    const { projectIds } = request.body;
    const connections = repository();
    await connections.setGrants(id, user.uid, [...new Set<string>(projectIds)]).catch(notFound);
    const connection = await connections.read(id, user.uid);
    return { connection: publicConnection(connection, await connections.grantedProjects(id, user.uid)) };
  });

  api.delete<{ Params: IdParams }>('/connections/:id', { preHandler: write, schema: { params: idParams } }, async (request) => {
    const user = authenticatedUser(request);
    const { id } = request.params;
    const connection = await repository().disconnect(id, user.uid).catch(notFound);
    // Provider-side revocation arrives with each adapter; until then the
    // response says exactly what happened: access is blocked here, not undone there.
    return { connection: publicConnection(connection), providerRevoked: false };
  });

  const github = () => {
    repository();
    if (dependencies.github === undefined || !dependencies.configured.has('github')) throw new AppError({
      code: 'connections/configuration-required', statusCode: 503,
      message: 'GitHub is not set up on this server yet.', details: { connector: 'github' },
    });
    return dependencies.github;
  };
  const projects = () => {
    if (dependencies.projects === undefined) throw new AppError({ code: 'connections/configuration-required', statusCode: 503, message: 'Repository binding is not available on this server.' });
    return dependencies.projects;
  };

  // The static GitHub route below takes precedence over this parametric one.
  api.post<{ Params: ConnectorParams }>('/connections/:connector/start', { preHandler: write, schema: { params: connectorParams } }, async (request) => {
    authenticatedUser(request);
    const { connector } = request.params;
    if (!isConnectorKey(connector)) throw new AppError({ code: 'connections/unknown-connector', statusCode: 404, message: 'Unknown connector.' });
    repository();
    if (!dependencies.configured.has(connector)) throw new AppError({
      code: 'connections/configuration-required', statusCode: 503,
      message: `${connectors[connector].name} is not set up on this server yet.`, details: { connector },
    });
    throw new AppError({ code: 'connections/not-implemented', statusCode: 501, message: `${connectors[connector].name} connections are not available yet.` });
  });

  api.post<{ Body: StartBody }>('/connections/github/start', { preHandler: write, schema: { body: startBody } }, async (request) => {
    const { uid } = authenticatedUser(request);
    const started = await github().start({ ownerUid: uid, projectIds: request.body.projectIds ?? [], returnTo: request.body.returnTo });
    return { url: started.url, expiresAt: started.expiresAt.toISOString() };
  });

  // GitHub sends the browser back to the App's setup URL, a signed-in frontend
  // page, which posts the installation and the state here. The state binds it to
  // the user who started the install; the installation is verified with GitHub.
  api.post<{ Body: CompleteBody }>('/connections/github/complete', { preHandler: write, schema: { body: completeBody } }, async (request) => {
    const { uid } = authenticatedUser(request);
    const connection = await github().complete({ ownerUid: uid, ...request.body });
    return { connection: publicConnection(connection, []) };
  });

  api.get<{ Params: IdParams }>('/connections/:id/repositories', { preHandler: read, schema: { params: idParams } }, async (request) => {
    const { uid } = authenticatedUser(request);
    const connection = await repository().read(request.params.id, uid).catch(notFound);
    if (connection.connector !== 'github') throw new AppError({ code: 'connections/not-supported', statusCode: 404, message: 'This connection has no repositories.' });
    const repositories = await github().repositories({ connectionId: connection.id, ownerUid: uid }).catch(notFound);
    return { repositories: repositories.map(publicRepository) };
  });

  // The connection must be granted to the project; the repository must be one
  // the installation reaches. Re-binding replaces the source and the next
  // session clones the new repository.
  api.put<{ Params: ProjectParams; Body: SourceBody }>('/projects/:projectId/source', { preHandler: write, schema: { params: projectParams, body: sourceBody } }, async (request) => {
    const { uid } = authenticatedUser(request);
    const { projectId } = request.params;
    const found = await github().repository({ connectionId: request.body.connectionId, ownerUid: uid, projectId, fullName: request.body.fullName }).catch((error: unknown) => {
      if (error instanceof ConnectionNotGrantedError) throw new AppError({ code: 'connections/not-granted', statusCode: 403, message: 'Grant this connection to the project first.' });
      return notFound(error);
    });
    const project = await projects().bindSource(uid, projectId, {
      kind: 'github', connectionId: request.body.connectionId, fullName: found.fullName, defaultBranch: found.defaultBranch, boundAt: new Date(),
    });
    return { source: project.source === undefined ? null : projectSourceResponse(project.source) };
  });

  api.delete<{ Params: ProjectParams }>('/projects/:projectId/source', { preHandler: write, schema: { params: projectParams } }, async (request) => {
    const { uid } = authenticatedUser(request);
    await projects().unbindSource(uid, request.params.projectId);
    return { source: null };
  });

  // Reserved at the actual API root. No token exchange or state write until
  // an adapter supplies secure browser binding and verified account discovery.
  api.get<{ Params: ConnectorParams }>('/connections/:connector/callback', {
    schema: { params: connectorParams }, logLevel: 'silent',
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    if (!['netlify', 'vercel', 'slack'].includes(request.params.connector)) {
      throw new AppError({ code: 'connections/unknown-connector', statusCode: 404, message: 'Unknown OAuth connector.' });
    }
    return reply.code(503).send({ error: { code: 'connections/configuration-required', message: 'This integration is not available yet.' } });
  });
}
