import type { FastifyInstance } from 'fastify';

import { authenticatedUser } from '../auth/plugin.ts';
import { AppError } from '../http/errors.ts';
import { type ConnectorKey, connectors, isConnectorKey } from './registry.ts';
import { type Connection, ConnectionInactiveError, ConnectionNotFoundError, type ConnectionRepository } from './service.ts';

export interface ConnectionRouteDependencies {
  /** Undefined until CONNECTION_KEK_V<n> is configured; every route then reports configuration_required. */
  readonly connections: ConnectionRepository | undefined;
  /** Connectors whose provider app credentials exist on this server. Empty in slice 0. */
  readonly configured: ReadonlySet<ConnectorKey>;
}

const documentId = '^[A-Za-z0-9_-]{1,128}$';
const idParams = { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', pattern: documentId } } } as const;
const connectorParams = { type: 'object', required: ['connector'], additionalProperties: false, properties: { connector: { type: 'string', pattern: '^[a-z]{1,16}$' } } } as const;
const grantsBody = { type: 'object', required: ['projectIds'], additionalProperties: false,
  properties: { projectIds: { type: 'array', maxItems: 200, items: { type: 'string', pattern: documentId } } } } as const;
type IdParams = { id: string };
type ConnectorParams = { connector: string };
type GrantsBody = { projectIds: string[] };

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
