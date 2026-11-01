import { type Firestore, Timestamp, type Transaction } from 'firebase-admin/firestore';

import type { CredentialKeyring, SealedCredential } from './credentials.ts';
import { documentId, requireProject } from './access.ts';
import { type ConnectionStatus, type ConnectorKey, connectionStatuses, isConnectorKey } from './registry.ts';

/**
 * A user's connection to one external account. The connection document never
 * holds the secret: credentials live in `connection_credentials/{id}`, which
 * only the server reads (Firestore rules deny all client access) and which is
 * never returned by any route or placed in model context.
 */
export interface ConnectionAccount {
  readonly id: string;
  readonly name: string;
  readonly team?: string;
}

export interface ConnectionHealth {
  readonly checkedAt: Date;
  readonly ok: boolean;
  readonly detail?: string;
}

export interface Connection {
  readonly id: string;
  readonly ownerUid: string;
  readonly connector: ConnectorKey;
  readonly status: ConnectionStatus;
  readonly account?: ConnectionAccount;
  readonly scopes: readonly string[];
  readonly health?: ConnectionHealth;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class ConnectionNotFoundError extends Error {
  constructor(id: string) { super(`Connection ${id} was not found.`); }
}
export class ConnectionInactiveError extends Error {
  readonly status: ConnectionStatus;
  constructor(status: ConnectionStatus) { super(`Connection is ${status}.`); this.status = status; }
}
export class ConnectionNotGrantedError extends Error {
  constructor(projectId: string) { super(`Connection is not granted to project ${projectId}.`); }
}

const connections = 'connections';
const credentials = 'connection_credentials';
const grants = 'grants';

export class ConnectionRepository {
  readonly #firestore: Firestore;
  readonly #keyring: CredentialKeyring;

  constructor(firestore: Firestore, keyring: CredentialKeyring) {
    this.#firestore = firestore;
    this.#keyring = keyring;
  }

  /** Starts a connection in `connecting`; nothing is usable until `activate`. */
  async begin(input: { id: string; ownerUid: string; connector: ConnectorKey; now?: Date }): Promise<Connection> {
    const now = input.now ?? new Date();
    const record: Connection = { id: input.id, ownerUid: input.ownerUid, connector: input.connector, status: 'connecting', scopes: [], createdAt: now, updatedAt: now };
    const ref = this.#firestore.collection(connections).doc(input.id);
    await this.#firestore.runTransaction(async (transaction) => transaction.create(ref, serialise(record)));
    return record;
  }

  /**
   * Stores the verified account, scopes and sealed credential, and grants the
   * listed projects — and only those. Call this after a live provider probe
   * succeeded, never on the strength of a completed redirect alone.
   */
  async activate(input: { id: string; ownerUid: string; account: ConnectionAccount; scopes: readonly string[]; secret: Buffer; projectIds: readonly string[]; now?: Date }): Promise<Connection> {
    const now = input.now ?? new Date();
    const ref = this.#firestore.collection(connections).doc(input.id);
    const sealed = this.#keyring.seal(input.secret, credentialAad(input.id, input.ownerUid));
    return this.#firestore.runTransaction(async (transaction) => {
      const current = await this.#requireOwned(transaction, input.id, input.ownerUid);
      if (current.status !== 'connecting') throw new ConnectionInactiveError(current.status);
      if (input.projectIds.length > 200) throw new Error('Too many project grants.');
      for (const projectId of input.projectIds) await requireProject(transaction, this.#firestore, input.ownerUid, projectId);
      const next: Connection = { ...current, status: 'active', account: input.account, scopes: [...input.scopes], health: { checkedAt: now, ok: true }, updatedAt: now };
      transaction.set(ref, serialise(next));
      transaction.set(this.#firestore.collection(credentials).doc(input.id), { ownerUid: input.ownerUid, ...sealed, updatedAt: Timestamp.fromDate(now) });
      for (const projectId of input.projectIds) transaction.set(ref.collection(grants).doc(projectId), { projectId, grantedAt: Timestamp.fromDate(now) });
      return next;
    });
  }

  async setStatus(id: string, ownerUid: string, status: Exclude<ConnectionStatus, 'active' | 'connecting'>, detail?: string, now = new Date()): Promise<Connection> {
    const ref = this.#firestore.collection(connections).doc(id);
    return this.#firestore.runTransaction(async (transaction) => {
      const current = await this.#requireOwned(transaction, id, ownerUid);
      if (current.status === 'revoked') throw new ConnectionInactiveError(current.status);
      const next: Connection = { ...current, status, health: { checkedAt: now, ok: false, ...(detail === undefined ? {} : { detail }) }, updatedAt: now };
      transaction.set(ref, serialise(next));
      return next;
    });
  }

  /**
   * Revokes first (new executions are refused immediately) and deletes the
   * sealed credential; provider-side revocation is the adapter's job and its
   * result is recorded by the caller, never assumed.
   */
  async disconnect(id: string, ownerUid: string, now = new Date()): Promise<Connection> {
    const ref = this.#firestore.collection(connections).doc(id);
    return this.#firestore.runTransaction(async (transaction) => {
      const current = await this.#requireOwned(transaction, id, ownerUid);
      const next: Connection = { ...current, status: 'revoked', updatedAt: now };
      transaction.set(ref, serialise(next));
      transaction.delete(this.#firestore.collection(credentials).doc(id));
      return next;
    });
  }

  async read(id: string, ownerUid: string): Promise<Connection> {
    const snapshot = await this.#firestore.collection(connections).doc(id).get();
    const data = snapshot.data();
    if (!snapshot.exists || data === undefined || data['ownerUid'] !== ownerUid) throw new ConnectionNotFoundError(id);
    return parse(id, data);
  }

  async listForUser(ownerUid: string): Promise<readonly Connection[]> {
    const snapshot = await this.#firestore.collection(connections).where('ownerUid', '==', ownerUid).get();
    return snapshot.docs.map((doc) => parse(doc.id, doc.data()));
  }

  async grantedProjects(id: string, ownerUid: string): Promise<readonly string[]> {
    await this.read(id, ownerUid);
    const snapshot = await this.#firestore.collection(connections).doc(id).collection(grants).get();
    return snapshot.docs.map((doc) => doc.id);
  }

  async setGrants(id: string, ownerUid: string, projectIds: readonly string[], now = new Date()): Promise<void> {
    if (projectIds.length > 200) throw new Error('Too many project grants.');
    const ref = this.#firestore.collection(connections).doc(id);
    await this.#firestore.runTransaction(async (transaction) => {
      const connection = await this.#requireOwned(transaction, id, ownerUid);
      if (connection.status !== 'active') throw new ConnectionInactiveError(connection.status);
      const existing = await transaction.get(ref.collection(grants));
      for (const projectId of projectIds) await requireProject(transaction, this.#firestore, ownerUid, projectId);
      for (const doc of existing.docs) if (!projectIds.includes(doc.id)) transaction.delete(doc.ref);
      for (const projectId of projectIds) transaction.set(ref.collection(grants).doc(projectId), { projectId, grantedAt: Timestamp.fromDate(now) });
    });
  }

  /**
   * The only way to obtain a secret: the connection must be active, owned by
   * the caller and granted to the project the task runs in — checked on every
   * use, not just at connect time.
   */
  async openCredential(input: { id: string; ownerUid: string; projectId: string }): Promise<{ connection: Connection; secret: Buffer }> {
    const { connection, sealed } = await this.#firestore.runTransaction(async (transaction) => {
      const connection = await this.requireAccess(transaction, input);
      const snapshot = await transaction.get(this.#firestore.collection(credentials).doc(input.id));
      const sealed = snapshot.data();
      if (!snapshot.exists || sealed === undefined || sealed['ownerUid'] !== input.ownerUid) throw new ConnectionInactiveError('revoked');
      return { connection, sealed };
    });
    const secret = this.#keyring.open(
      { keyVersion: sealed['keyVersion'] as number, wrappedKey: sealed['wrappedKey'] as string, ciphertext: sealed['ciphertext'] as string } satisfies SealedCredential,
      credentialAad(input.id, input.ownerUid),
    );
    return { connection, secret };
  }

  async requireAccess(transaction: Transaction, input: { id: string; ownerUid: string; projectId: string }): Promise<Connection> {
    const connection = await this.#requireOwned(transaction, input.id, input.ownerUid);
    if (connection.status !== 'active') throw new ConnectionInactiveError(connection.status);
    await requireProject(transaction, this.#firestore, input.ownerUid, input.projectId);
    const grant = await transaction.get(this.#firestore.collection(connections).doc(input.id).collection(grants).doc(input.projectId));
    if (!grant.exists) throw new ConnectionNotGrantedError(input.projectId);
    return connection;
  }

  async #requireOwned(transaction: Transaction, id: string, ownerUid: string): Promise<Connection> {
    const snapshot = await transaction.get(this.#firestore.collection(connections).doc(documentId(id)));
    const data = snapshot.data();
    if (!snapshot.exists || data === undefined || data['ownerUid'] !== ownerUid) throw new ConnectionNotFoundError(id);
    return parse(id, data);
  }
}

const credentialAad = (id: string, ownerUid: string) => `connection_credentials/${id}#${ownerUid}`;

function serialise(connection: Connection): Record<string, unknown> {
  return {
    ownerUid: connection.ownerUid, connector: connection.connector, status: connection.status, scopes: [...connection.scopes],
    ...(connection.account === undefined ? {} : { account: { ...connection.account } }),
    ...(connection.health === undefined ? {} : { health: { ...connection.health, checkedAt: Timestamp.fromDate(connection.health.checkedAt) } }),
    createdAt: Timestamp.fromDate(connection.createdAt), updatedAt: Timestamp.fromDate(connection.updatedAt),
  };
}

function parse(id: string, data: Record<string, unknown>): Connection {
  const connector = data['connector'];
  const status = data['status'];
  if (!isConnectorKey(connector)) throw new Error(`Connection ${id} has an unknown connector.`);
  if (typeof status !== 'string' || !(connectionStatuses as readonly string[]).includes(status)) throw new Error(`Connection ${id} has an unknown status.`);
  const account = data['account'] as ConnectionAccount | undefined;
  const health = data['health'] as { checkedAt: Timestamp; ok: boolean; detail?: string } | undefined;
  return {
    id, ownerUid: data['ownerUid'] as string, connector, status: status as ConnectionStatus,
    scopes: [...((data['scopes'] as string[] | undefined) ?? [])],
    ...(account === undefined ? {} : { account }),
    ...(health === undefined ? {} : { health: { ...health, checkedAt: health.checkedAt.toDate() } }),
    createdAt: (data['createdAt'] as Timestamp).toDate(), updatedAt: (data['updatedAt'] as Timestamp).toDate(),
  };
}
