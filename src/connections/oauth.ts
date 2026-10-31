import { createHash, randomBytes } from 'node:crypto';
import { type Firestore, Timestamp } from 'firebase-admin/firestore';

import type { ConnectorKey } from './registry.ts';

/**
 * One-time OAuth state, bound to the LotusBuild user who started the flow,
 * the connector, the exact callback URL and the projects to grant. Consumed
 * atomically in the callback; a replay, a mismatch or a different user fails.
 */
export interface OAuthStart {
  readonly state: string;
  readonly codeVerifier: string;
  readonly codeChallenge: string;
  readonly expiresAt: Date;
}

export interface OAuthStateRecord {
  readonly ownerUid: string;
  readonly connector: ConnectorKey;
  readonly redirectUri: string;
  readonly projectIds: readonly string[];
  readonly codeVerifier: string;
}

export type OAuthStateRejection = 'unknown' | 'expired' | 'used' | 'wrong-user' | 'wrong-connector' | 'redirect-mismatch';
export class OAuthStateError extends Error {
  readonly reason: OAuthStateRejection;
  constructor(reason: OAuthStateRejection) { super(`OAuth state rejected: ${reason}.`); this.reason = reason; }
}

const collection = 'oauth_states';
export const defaultOAuthStateTtlMs = 10 * 60 * 1000;

export const pkceChallenge = (verifier: string): string =>
  createHash('sha256').update(verifier).digest('base64url');

export class OAuthStateStore {
  readonly #firestore: Firestore;
  readonly #ttlMs: number;
  constructor(firestore: Firestore, ttlMs = defaultOAuthStateTtlMs) { this.#firestore = firestore; this.#ttlMs = ttlMs; }

  async begin(record: Omit<OAuthStateRecord, 'codeVerifier'>, now = new Date()): Promise<OAuthStart> {
    const state = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(48).toString('base64url');
    const expiresAt = new Date(now.getTime() + this.#ttlMs);
    const ref = this.#firestore.collection(collection).doc(state);
    await this.#firestore.runTransaction(async (transaction) => transaction.create(ref, {
      ...record, projectIds: [...record.projectIds], codeVerifier,
      createdAt: Timestamp.fromDate(now), expiresAt: Timestamp.fromDate(expiresAt), usedAt: null,
    }));
    return { state, codeVerifier, codeChallenge: pkceChallenge(codeVerifier), expiresAt };
  }

  /** Single use: marks the state consumed in the same transaction that validates it. */
  async complete(input: { state: string; ownerUid: string; connector: ConnectorKey; redirectUri: string; now?: Date }): Promise<OAuthStateRecord> {
    const ref = this.#firestore.collection(collection).doc(input.state);
    const now = input.now ?? new Date();
    return this.#firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new OAuthStateError('unknown');
      const data = snapshot.data() ?? {};
      if (data['usedAt'] !== null) throw new OAuthStateError('used');
      if ((data['expiresAt'] as Timestamp).toMillis() <= now.getTime()) throw new OAuthStateError('expired');
      if (data['ownerUid'] !== input.ownerUid) throw new OAuthStateError('wrong-user');
      if (data['connector'] !== input.connector) throw new OAuthStateError('wrong-connector');
      if (data['redirectUri'] !== input.redirectUri) throw new OAuthStateError('redirect-mismatch');
      transaction.update(ref, { usedAt: Timestamp.fromDate(now) });
      return {
        ownerUid: data['ownerUid'] as string, connector: data['connector'] as ConnectorKey,
        redirectUri: data['redirectUri'] as string, projectIds: [...(data['projectIds'] as string[])],
        codeVerifier: data['codeVerifier'] as string,
      };
    });
  }
}
