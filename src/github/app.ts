import { createSign } from 'node:crypto';

import { AppError } from '../http/errors.ts';

/**
 * A credential for one installation, good for about an hour.
 *
 * `expiresAt` is carried so a caller holding one across a long piece of work can
 * tell whether it is still usable rather than discovering it isn't halfway
 * through a push.
 */
export interface InstallationToken {
  readonly token: string;
  readonly expiresAt: Date;
}

/**
 * What a 404 means for a given call. GitHub reuses it for "your credentials are
 * wrong" and "that installation is gone", which need opposite responses.
 */
type NotFoundMeaning = 'credentials' | 'installation' | 'repository';

export interface Installation {
  readonly id: number;
  readonly account: { readonly login: string; readonly id: number; readonly type: 'User' | 'Organization' };
  /** Permission names GitHub granted, e.g. `contents`, `pull_requests`. */
  readonly permissions: readonly string[];
}

export interface Repository {
  readonly id: number;
  readonly fullName: string;
  readonly name: string;
  readonly owner: string;
  readonly private: boolean;
  readonly defaultBranch: string;
  readonly htmlUrl: string;
  readonly pushedAt: Date | undefined;
}

export const repositoryFullName = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const repositoryPageSize = 100;
const maxRepositoryPages = 5;

function assertInstallationId(installationId: number): void {
  if (!Number.isInteger(installationId) || installationId <= 0) {
    throw new AppError({
      code: 'github/installation-invalid',
      statusCode: 400,
      message: 'An installation id must be a positive integer.',
    });
  }
}

const unexpected = (what: string): AppError =>
  new AppError({ code: 'github/unexpected-response', statusCode: 502, message: `GitHub returned ${what}.` });

function parseRepository(item: unknown): Repository {
  if (typeof item !== 'object' || item === null) throw unexpected('a repository this service cannot read');
  const fields = item as Record<string, unknown>;
  const owner = fields['owner'];
  const login = typeof owner === 'object' && owner !== null ? (owner as Record<string, unknown>)['login'] : undefined;
  if (
    typeof fields['id'] !== 'number' || typeof fields['full_name'] !== 'string' || typeof fields['name'] !== 'string'
    || typeof login !== 'string' || typeof fields['private'] !== 'boolean' || typeof fields['default_branch'] !== 'string'
    || typeof fields['html_url'] !== 'string'
  ) {
    throw unexpected('a repository this service cannot read');
  }
  const pushedAt = typeof fields['pushed_at'] === 'string' ? new Date(fields['pushed_at']) : undefined;
  return {
    id: fields['id'], fullName: fields['full_name'], name: fields['name'], owner: login, private: fields['private'],
    defaultBranch: fields['default_branch'], htmlUrl: fields['html_url'],
    pushedAt: pushedAt !== undefined && !Number.isNaN(pushedAt.getTime()) ? pushedAt : undefined,
  };
}

/** What the App itself is, as GitHub reports it. Read at startup to prove the key. */
export interface AppIdentity {
  readonly id: number;
  readonly slug: string;
  readonly permissions: Readonly<Record<string, string>>;
}

/**
 * Talks to GitHub as the LotusBuild App.
 *
 * Two credentials are involved and they are easy to confuse. A **JWT**, signed
 * with the App's private key, authenticates us *as the App* and can do almost
 * nothing except ask about installations. An **installation token**, minted with
 * that JWT, is what actually reaches a user's repositories, and only the ones
 * they selected.
 *
 * Installation tokens are deliberately **not cached**. The obvious cache is a map
 * keyed by installation, which grows with every user the process has ever served
 * — an unbounded cache on a box that also runs build sandboxes. A token is needed
 * two or three times in a session that lasts minutes, so the round trip is free
 * next to the work it precedes, and a credential that is never held longer than
 * the operation is the one we would rather leak. If minting ever becomes hot,
 * bound it by installation count rather than by time.
 */
export class GitHubApp {
  readonly #appId: string;
  readonly #privateKey: string;
  readonly #apiBaseUrl: URL;
  readonly #requestTimeoutMs: number;

  constructor(args: {
    readonly appId: string;
    readonly privateKey: string;
    readonly apiBaseUrl: URL;
    readonly requestTimeoutMs: number;
  }) {
    this.#appId = args.appId;
    this.#privateKey = args.privateKey;
    this.#apiBaseUrl = args.apiBaseUrl;
    this.#requestTimeoutMs = args.requestTimeoutMs;
  }

  /**
   * Proves the private key belongs to the App id, and reports what the App may
   * do. Worth calling at startup: a mismatched key is a configuration error that
   * would otherwise surface as an authentication failure on a user's first
   * import, long after the deploy that caused it.
   */
  async identity(): Promise<AppIdentity> {
    const body = await this.#request('GET', '/app', this.#jwt(), 'credentials');

    const id = body['id'];
    const slug = body['slug'];
    const permissions = body['permissions'];
    if (
      typeof id !== 'number' ||
      typeof slug !== 'string' ||
      typeof permissions !== 'object' ||
      permissions === null
    ) {
      throw new AppError({
        code: 'github/unexpected-response',
        statusCode: 502,
        message: 'GitHub described this App in a shape this service does not understand.',
      });
    }

    return { id, slug, permissions: permissions as Record<string, string> };
  }

  /**
   * Mints a token for one installation. This is the only credential that should
   * ever travel to a sandbox, and never in a form that outlives the command that
   * needs it.
   */
  async installationToken(installationId: number): Promise<InstallationToken> {
    assertInstallationId(installationId);

    const body = await this.#request(
      'POST',
      `/app/installations/${installationId}/access_tokens`,
      this.#jwt(),
      'installation',
    );

    const token = body['token'];
    const expiresAt = body['expires_at'];
    if (typeof token !== 'string' || token === '' || typeof expiresAt !== 'string') {
      throw new AppError({
        code: 'github/unexpected-response',
        statusCode: 502,
        message: 'GitHub returned an installation token this service cannot read.',
      });
    }

    const expiry = new Date(expiresAt);
    if (Number.isNaN(expiry.getTime())) {
      throw new AppError({
        code: 'github/unexpected-response',
        statusCode: 502,
        message: 'GitHub returned an installation token with an unreadable expiry.',
      });
    }

    return { token, expiresAt: expiry };
  }

  /**
   * The installation as GitHub sees it. A 404 here means the user removed the
   * app, which is the one answer the connect flow must not take on faith from
   * a query parameter.
   */
  async installation(installationId: number): Promise<Installation> {
    assertInstallationId(installationId);
    const body = await this.#request('GET', `/app/installations/${installationId}`, this.#jwt(), 'installation');
    const account = body['account'];
    const permissions = body['permissions'];
    if (
      typeof account !== 'object' || account === null || typeof (account as Record<string, unknown>)['login'] !== 'string'
      || typeof (account as Record<string, unknown>)['id'] !== 'number' || typeof (account as Record<string, unknown>)['type'] !== 'string'
    ) {
      throw unexpected('an installation this service cannot read');
    }
    const { login, id, type } = account as { login: string; id: number; type: string };
    return {
      id: installationId,
      account: { login, id, type: type === 'Organization' ? 'Organization' : 'User' },
      permissions: typeof permissions === 'object' && permissions !== null ? Object.keys(permissions).sort() : [],
    };
  }

  /** Every repository the installation may reach, newest push first as GitHub orders them. */
  async listRepositories(token: InstallationToken): Promise<readonly Repository[]> {
    const repositories: Repository[] = [];
    for (let page = 1; page <= maxRepositoryPages; page += 1) {
      const body = await this.#request('GET', `/installation/repositories?per_page=${repositoryPageSize}&page=${page}`, token.token, 'installation');
      const items = body['repositories'];
      if (!Array.isArray(items)) throw unexpected('a repository list this service cannot read');
      for (const item of items) repositories.push(parseRepository(item));
      if (items.length < repositoryPageSize) break;
    }
    return repositories;
  }

  /** One repository by `owner/name`; a 404 means the installation cannot reach it. */
  async repository(token: InstallationToken, fullName: string): Promise<Repository> {
    if (!repositoryFullName.test(fullName)) {
      throw new AppError({ code: 'github/repository-invalid', statusCode: 400, message: 'A repository is named owner/name.' });
    }
    return parseRepository(await this.#request('GET', `/repos/${fullName}`, token.token, 'repository'));
  }

  /**
   * A JWT is what GitHub accepts as proof we hold the App's private key. Its
   * lifetime is capped at ten minutes by GitHub and kept well under that here;
   * `iat` is backdated a minute because GitHub rejects a token whose clock looks
   * to be ahead of theirs, which is a failure that only appears in production.
   */
  #jwt(): string {
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: object): string =>
      Buffer.from(JSON.stringify(value)).toString('base64url');

    const signingInput =
      `${encode({ alg: 'RS256', typ: 'JWT' })}.` +
      `${encode({ iat: now - 60, exp: now + 540, iss: this.#appId })}`;

    let signature: string;
    try {
      signature = createSign('RSA-SHA256').update(signingInput).sign(this.#privateKey, 'base64url');
    } catch (cause) {
      // An unreadable key is ours, not the caller's, and every GitHub operation
      // will fail the same way until it is fixed.
      throw new AppError({
        code: 'github/key-unusable',
        statusCode: 500,
        message: 'The configured GitHub App private key could not sign a request.',
        cause,
      });
    }

    return `${signingInput}.${signature}`;
  }

  async #request(
    method: 'GET' | 'POST',
    path: string,
    bearer: string,
    notFound: NotFoundMeaning,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(new URL(path, this.#apiBaseUrl), {
        method,
        headers: {
          authorization: `Bearer ${bearer}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
        },
        signal: AbortSignal.timeout(this.#requestTimeoutMs),
      });
    } catch (cause) {
      // A hung call must not hold a runner open for the length of a build.
      throw new AppError({
        code: 'github/unreachable',
        statusCode: 502,
        message: 'GitHub could not be reached.',
        cause,
      });
    }

    if (!response.ok) {
      throw this.#failure(response.status, method, path, notFound);
    }

    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new AppError({
        code: 'github/unexpected-response',
        statusCode: 502,
        message: `GitHub answered ${method} ${path} with something that is not an object.`,
      });
    }
    return body as Record<string, unknown>;
  }

  /**
   * Which of these is the caller's problem and which is ours matters, because
   * they need opposite responses: a revoked installation is fixed by the user
   * reinstalling, and a rejected key is fixed by us and by nobody else.
   */
  #failure(
    status: number,
    method: string,
    path: string,
    notFound: NotFoundMeaning,
  ): AppError {
    // GitHub answers 404 rather than 401 when a JWT is signed with a key that
    // does not match the App id, so the status alone cannot say whose fault it
    // is. Only the call site knows: on an installation path a 404 means the user
    // uninstalled us, and on `/app` it means our own credentials are wrong.
    if (status === 401 || (status === 404 && notFound === 'credentials')) {
      return new AppError({
        code: 'github/credentials-rejected',
        statusCode: 500,
        message: 'GitHub rejected this service’s App credentials.',
        details: { status },
      });
    }
    if (status === 404 && notFound === 'repository') {
      return new AppError({
        code: 'github/repository-not-accessible',
        statusCode: 404,
        message: 'That repository is not one this installation can reach.',
      });
    }
    if (status === 404) {
      return new AppError({
        code: 'github/installation-gone',
        statusCode: 409,
        message: 'This GitHub installation no longer exists. Reinstall the app to reconnect it.',
      });
    }
    if (status === 403 || status === 429) {
      return new AppError({
        code: 'github/rate-limited',
        statusCode: 503,
        message: 'GitHub is refusing further requests from this service for now.',
        details: { status },
      });
    }
    return new AppError({
      code: 'github/request-failed',
      statusCode: 502,
      message: `GitHub answered ${method} ${path} with ${status}.`,
      details: { status },
    });
  }
}
