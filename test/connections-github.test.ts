import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import type { Auth } from 'firebase-admin/auth';

import { registerAuth } from '../src/auth/plugin.ts';
import { CredentialKeyring } from '../src/connections/credentials.ts';
import { GitHubInstallations } from '../src/connections/github.ts';
import { OAuthStateStore } from '../src/connections/oauth.ts';
import { registerConnectionRoutes } from '../src/connections/routes.ts';
import { ConnectionRepository } from '../src/connections/service.ts';
import type { GitHubApp, InstallationToken, Repository } from '../src/github/app.ts';
import { registerErrorHandler } from '../src/http/errors.ts';
import type { ProjectRepository, ProjectSource } from '../src/projects/repository.ts';
import { ledger } from './support/ledger.ts';

const repo = (fullName: string, defaultBranch = 'main'): Repository => ({
  id: 7, fullName, name: fullName.split('/')[1]!, owner: fullName.split('/')[0]!, private: true,
  defaultBranch, htmlUrl: `https://github.com/${fullName}`, pushedAt: new Date('2026-01-01T00:00:00Z'),
});

function harness(options: { installationExists?: boolean } = {}) {
  const store = ledger();
  for (const id of ['p1', 'p2']) store.data.set(`projects/${id}`, { ownerUid: 'alice', status: 'draft' });
  const repository = new ConnectionRepository(store.db, new CredentialKeyring(new Map([[1, randomBytes(32)]])));
  const calls: string[] = [];
  const token: InstallationToken = { token: 'ghs_minted', expiresAt: new Date(Date.now() + 3_600_000) };
  const app = {
    installation: async (id: number) => {
      calls.push(`installation:${id}`);
      if (options.installationExists === false) throw new Error('gone');
      return { id, account: { login: 'alice-gh', id: 42, type: 'User' as const }, permissions: ['contents', 'pull_requests'] };
    },
    installationToken: async (id: number) => { calls.push(`token:${id}`); return token; },
    listRepositories: async (t: InstallationToken) => { calls.push(`list:${t.token}`); return [repo('alice-gh/site'), repo('alice-gh/api', 'develop')]; },
    repository: async (t: InstallationToken, fullName: string) => {
      calls.push(`repo:${t.token}:${fullName}`);
      if (fullName !== 'alice-gh/site') throw Object.assign(new Error('not accessible'), { statusCode: 404 });
      return repo(fullName);
    },
  } as unknown as GitHubApp;
  const bound: Array<{ projectId: string; source: ProjectSource }> = [];
  const projects = {
    bindSource: async (_uid: string, projectId: string, source: ProjectSource) => { bound.push({ projectId, source }); return { id: projectId, source }; },
    unbindSource: async (_uid: string, projectId: string) => { bound.splice(0, bound.length, ...bound.filter((b) => b.projectId !== projectId)); return { id: projectId }; },
  } as unknown as ProjectRepository;
  const github = new GitHubInstallations({ app, slug: 'lotusbuild', states: new OAuthStateStore(store.db), connections: repository, allowedOrigins: ['https://app.test'] });
  let uid = 'alice';
  const server = Fastify({ logger: false });
  registerErrorHandler(server);
  registerAuth(server, { verifyIdToken: async () => ({ uid, email: 'a@example.test', email_verified: true, auth_time: 1, exp: 4_000_000_000 }) } as unknown as Auth);
  server.decorate('enforceRateLimit', () => async () => {});
  registerConnectionRoutes(server, { connections: repository, configured: new Set(['github']), github, projects });
  return { server, store, repository, calls, bound, as: (next: string) => { uid = next; } };
}
const headers = { authorization: 'Bearer fixture' };
const returnTo = 'https://app.test/integrations/github/setup';
type ErrorBody = { error: { code: string } };

async function connect(h: ReturnType<typeof harness>, projectIds: string[] = ['p1']) {
  const start = await h.server.inject({ method: 'POST', url: '/connections/github/start', headers, payload: { returnTo, projectIds } });
  assert.equal(start.statusCode, 200, start.body);
  const url = new URL((start.json() as { authorizeUrl: string }).authorizeUrl);
  assert.equal(url.origin + url.pathname, 'https://github.com/apps/lotusbuild/installations/new');
  const state = url.searchParams.get('state')!;
  const complete = await h.server.inject({ method: 'POST', url: '/connections/github/complete', headers, payload: { state, installationId: 9001, returnTo } });
  return { state, complete };
}

describe('GitHub installations', () => {
  it('installs through a bound state and records the installation as an active connection', async (t) => {
    const h = harness();
    t.after(() => h.server.close());
    const { complete } = await connect(h);
    assert.equal(complete.statusCode, 200, complete.body);
    const { connection } = complete.json() as { connection: { id: string; connector: string; status: string; account: { name: string }; scopes: string[] } };
    assert.equal(connection.connector, 'github');
    assert.equal(connection.status, 'active');
    assert.equal(connection.account.name, 'alice-gh');
    assert.deepEqual(connection.scopes, ['contents', 'pull_requests']);
    assert.deepEqual(h.calls, ['installation:9001']);
    assert.deepEqual(await h.repository.grantedProjects(connection.id, 'alice'), ['p1']);
    assert.equal(complete.body.includes('9001'), false, 'the installation id is sealed, not served');
  });

  it('refuses a return address off the app, a replayed state, and another user\'s state', async (t) => {
    const h = harness();
    t.after(() => h.server.close());
    const elsewhere = await h.server.inject({ method: 'POST', url: '/connections/github/start', headers, payload: { returnTo: 'https://evil.test/x', projectIds: [] } });
    assert.equal(elsewhere.statusCode, 400);
    assert.equal((elsewhere.json() as ErrorBody).error.code, 'connections/return-url-invalid');

    const { state, complete } = await connect(h);
    assert.equal(complete.statusCode, 200);
    const replay = await h.server.inject({ method: 'POST', url: '/connections/github/complete', headers, payload: { state, installationId: 9001, returnTo } });
    assert.equal(replay.statusCode, 400);
    assert.equal((replay.json() as ErrorBody).error.code, 'connections/state-rejected');

    const start = await h.server.inject({ method: 'POST', url: '/connections/github/start', headers, payload: { returnTo, projectIds: [] } });
    const other = new URL((start.json() as { authorizeUrl: string }).authorizeUrl).searchParams.get('state')!;
    h.as('mallory');
    const stolen = await h.server.inject({ method: 'POST', url: '/connections/github/complete', headers, payload: { state: other, installationId: 9001, returnTo } });
    assert.equal(stolen.statusCode, 400);
    assert.equal(h.calls.filter((c) => c.startsWith('installation:')).length, 1, 'GitHub is only asked after the state is accepted');
  });

  it('writes nothing when GitHub does not know the installation', async (t) => {
    const h = harness({ installationExists: false });
    t.after(() => h.server.close());
    const { complete } = await connect(h);
    assert.equal(complete.statusCode, 500);
    assert.equal([...h.store.data.keys()].some((key) => key.startsWith('connections/')), false);
  });

  it('lists repositories with a token minted per request and binds one to a granted project', async (t) => {
    const h = harness();
    t.after(() => h.server.close());
    const { complete } = await connect(h, ['p1']);
    const id = (complete.json() as { connection: { id: string } }).connection.id;

    const list = await h.server.inject({ method: 'GET', url: `/connections/${id}/repositories`, headers });
    assert.equal(list.statusCode, 200, list.body);
    const { repositories } = list.json() as { repositories: Array<{ fullName: string; defaultBranch: string }> };
    assert.deepEqual(repositories.map((r) => [r.fullName, r.defaultBranch]), [['alice-gh/site', 'main'], ['alice-gh/api', 'develop']]);
    assert.equal(list.body.includes('ghs_minted'), false);

    const bind = await h.server.inject({ method: 'PUT', url: '/projects/p1/source', headers, payload: { connectionId: id, fullName: 'alice-gh/site' } });
    assert.equal(bind.statusCode, 200, bind.body);
    assert.deepEqual(h.bound.map((b) => [b.projectId, b.source.fullName, b.source.defaultBranch, b.source.connectionId]), [['p1', 'alice-gh/site', 'main', id]]);

    const ungranted = await h.server.inject({ method: 'PUT', url: '/projects/p2/source', headers, payload: { connectionId: id, fullName: 'alice-gh/site' } });
    assert.equal(ungranted.statusCode, 403);
    assert.equal((ungranted.json() as ErrorBody).error.code, 'connections/not-granted');
    assert.equal(h.bound.length, 1);

    const unbind = await h.server.inject({ method: 'DELETE', url: '/projects/p1/source', headers });
    assert.equal(unbind.statusCode, 200);
    assert.equal(h.bound.length, 0);

    h.as('mallory');
    assert.equal((await h.server.inject({ method: 'GET', url: `/connections/${id}/repositories`, headers })).statusCode, 404);
  });
});
