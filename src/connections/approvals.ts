import { createHash } from 'node:crypto';
import { type Firestore, Timestamp } from 'firebase-admin/firestore';

/**
 * An approval authorises exactly one execution of one concrete action: the
 * tool, the connection, the destination and the inputs are hashed when the
 * user is asked, and the executor presents the same hash to consume it. Any
 * change to those facts, a second use, or expiry means asking again.
 */
export interface ActionDescriptor {
  readonly tool: string;
  readonly connectionId: string;
  /** The LotusBuild project the action runs for; the grant is checked against it. */
  readonly projectId: string;
  readonly destination: string;
  readonly inputs: Readonly<Record<string, unknown>>;
}

export const hashAction = (action: ActionDescriptor): string =>
  createHash('sha256').update(canonical(action)).digest('hex');

export type ApprovalRejection = 'missing' | 'consumed' | 'expired' | 'mismatch' | 'wrong-session' | 'wrong-user';
export class ApprovalRejectedError extends Error {
  readonly reason: ApprovalRejection;
  constructor(reason: ApprovalRejection) { super(`Approval cannot be used: ${reason}.`); this.reason = reason; }
}

const collection = 'action_approvals';
export const defaultApprovalTtlMs = 15 * 60 * 1000;

export class ActionApprovals {
  readonly #firestore: Firestore;
  readonly #ttlMs: number;
  constructor(firestore: Firestore, ttlMs = defaultApprovalTtlMs) { this.#firestore = firestore; this.#ttlMs = ttlMs; }

  async issue(input: { id: string; sessionId: string; ownerUid: string; action: ActionDescriptor; now?: Date }): Promise<{ actionHash: string; expiresAt: Date }> {
    const now = input.now ?? new Date();
    const expiresAt = new Date(now.getTime() + this.#ttlMs);
    const actionHash = hashAction(input.action);
    const ref = this.#firestore.collection(collection).doc(input.id);
    await this.#firestore.runTransaction(async (transaction) => transaction.create(ref, {
      sessionId: input.sessionId, ownerUid: input.ownerUid, actionHash,
      tool: input.action.tool, connectionId: input.action.connectionId, projectId: input.action.projectId,
      destination: input.action.destination,
      issuedAt: Timestamp.fromDate(now), expiresAt: Timestamp.fromDate(expiresAt), consumedAt: null,
    }));
    return { actionHash, expiresAt };
  }

  /**
   * Atomically marks the approval used; the action may run only after this
   * resolves. The caller's identity is checked independently of the action
   * hash, so a leaked approval id is useless to another user or session.
   */
  async consume(input: { id: string; sessionId: string; ownerUid: string; action: ActionDescriptor; now?: Date }): Promise<void> {
    const ref = this.#firestore.collection(collection).doc(input.id);
    const now = input.now ?? new Date();
    await this.#firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new ApprovalRejectedError('missing');
      const data = snapshot.data() ?? {};
      if (data['ownerUid'] !== input.ownerUid) throw new ApprovalRejectedError('wrong-user');
      if (data['sessionId'] !== input.sessionId) throw new ApprovalRejectedError('wrong-session');
      if (data['consumedAt'] !== null) throw new ApprovalRejectedError('consumed');
      if ((data['expiresAt'] as Timestamp).toMillis() <= now.getTime()) throw new ApprovalRejectedError('expired');
      if (data['actionHash'] !== hashAction(input.action)) throw new ApprovalRejectedError('mismatch');
      transaction.update(ref, { consumedAt: Timestamp.fromDate(now) });
    });
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
