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
type NotFoundMeaning = 'credentials' | 'installation';

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
    if (!Number.isInteger(installationId) || installationId <= 0) {
      throw new AppError({
        code: 'github/installation-invalid',
        statusCode: 400,
        message: 'An installation id must be a positive integer.',
      });
    }

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
