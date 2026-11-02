import { randomBytes } from 'node:crypto';

import { AppError } from '../http/errors.ts';
import type { GitHubApp, Repository } from '../github/app.ts';
import { OAuthStateError, type OAuthStateStore } from './oauth.ts';
import type { Connection, ConnectionRepository } from './service.ts';

/**
 * Connects a GitHub App installation as a connection.
 *
 * GitHub sends the browser to the App's setup URL — a frontend page — with the
 * installation id and the `state` the install was started with. The frontend,
 * signed in, posts both back here, so the installation is bound to the user who
 * started it by the same single-use state the OAuth connectors use, and the
 * installation id is never trusted from a query string: GitHub is asked what
 * it is before anything is written.
 *
 * The sealed credential is the installation id. The secret that reaches
 * repositories is minted from it per use (`GitHubApp.installationToken`) and
 * never stored.
 */
export class GitHubInstallations {
  readonly #app: GitHubApp;
  readonly #slug: string;
  readonly #states: OAuthStateStore;
  readonly #connections: ConnectionRepository;
  readonly #allowedOrigins: ReadonlySet<string>;

  constructor(args: {
    readonly app: GitHubApp;
    readonly slug: string;
    readonly states: OAuthStateStore;
    readonly connections: ConnectionRepository;
    readonly allowedOrigins: Iterable<string>;
  }) {
    this.#app = args.app;
    this.#slug = args.slug;
    this.#states = args.states;
    this.#connections = args.connections;
    this.#allowedOrigins = new Set(args.allowedOrigins);
  }

  /** Where the browser goes to install the app; `returnTo` is where GitHub must send it back. */
  async start(input: { ownerUid: string; projectIds: readonly string[]; returnTo: string; now?: Date }): Promise<{ url: string; expiresAt: Date }> {
    const returnTo = this.#returnTo(input.returnTo);
    const started = await this.#states.begin(
      { ownerUid: input.ownerUid, connector: 'github', redirectUri: returnTo, projectIds: input.projectIds },
      input.now,
    );
    const url = new URL(`https://github.com/apps/${this.#slug}/installations/new`);
    url.searchParams.set('state', started.state);
    return { url: url.toString(), expiresAt: started.expiresAt };
  }

  async complete(input: { ownerUid: string; state: string; installationId: number; returnTo: string; now?: Date }): Promise<Connection> {
    const returnTo = this.#returnTo(input.returnTo);
    let record;
    try {
      record = await this.#states.complete({ state: input.state, ownerUid: input.ownerUid, connector: 'github', redirectUri: returnTo, ...(input.now ? { now: input.now } : {}) });
    } catch (error) {
      if (error instanceof OAuthStateError) {
        throw new AppError({
          code: 'connections/state-rejected', statusCode: 400,
          message: 'This GitHub installation could not be matched to a connect attempt. Start again from Integrations.',
          details: { reason: error.reason },
        });
      }
      throw error;
    }
    const installation = await this.#app.installation(input.installationId);
    const id = randomBytes(16).toString('base64url');
    await this.#connections.begin({ id, ownerUid: input.ownerUid, connector: 'github', ...(input.now ? { now: input.now } : {}) });
    return this.#connections.activate({
      id, ownerUid: input.ownerUid,
      account: {
        id: String(installation.account.id), name: installation.account.login,
        ...(installation.account.type === 'Organization' ? { team: installation.account.login } : {}),
      },
      scopes: installation.permissions,
      secret: Buffer.from(String(installation.id), 'utf8'),
      projectIds: record.projectIds,
      ...(input.now ? { now: input.now } : {}),
    });
  }

  /** Repositories the connection can reach; the connection must be active and owned by the caller. */
  async repositories(input: { connectionId: string; ownerUid: string }): Promise<readonly Repository[]> {
    const token = await this.#token(input);
    return this.#app.listRepositories(token);
  }

  /** One repository, for binding to a project the connection is granted to. */
  async repository(input: { connectionId: string; ownerUid: string; projectId: string; fullName: string }): Promise<Repository> {
    const token = await this.#token(input);
    return this.#app.repository(token, input.fullName);
  }

  async #token(input: { connectionId: string; ownerUid: string; projectId?: string }) {
    const installationId = input.projectId === undefined
      ? await this.#connections.openOwnedCredential({ id: input.connectionId, ownerUid: input.ownerUid })
      : (await this.#connections.openCredential({ id: input.connectionId, ownerUid: input.ownerUid, projectId: input.projectId })).secret;
    const parsed = Number.parseInt(installationId.toString('utf8'), 10);
    return this.#app.installationToken(parsed);
  }

  #returnTo(value: string): string {
    let url: URL;
    try { url = new URL(value); } catch {
      throw new AppError({ code: 'connections/return-url-invalid', statusCode: 400, message: 'The return address must be an absolute URL.' });
    }
    if (!this.#allowedOrigins.has(url.origin) || url.username !== '' || url.password !== '') {
      throw new AppError({ code: 'connections/return-url-invalid', statusCode: 400, message: 'The return address must be a LotusBuild page.' });
    }
    url.hash = '';
    url.search = '';
    return url.toString();
  }
}
