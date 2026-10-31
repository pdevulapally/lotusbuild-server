import { type Firestore, Timestamp } from 'firebase-admin/firestore';

/**
 * Durable record of every external side effect a connection performs.
 *
 * Providers are not assumed to be idempotent: a lost response is not evidence
 * the action didn't happen. A worker must *claim* an operation id in a
 * transaction before calling out; if the result never arrives the operation is
 * left `uncertain`, and nothing with the same action may run again until an
 * operator or a provider lookup reconciles it to `succeeded` or `failed`.
 */
export const operationStatuses = ['claimed', 'succeeded', 'failed', 'uncertain'] as const;
export type OperationStatus = (typeof operationStatuses)[number];

export interface OperationRecord {
  readonly id: string;
  readonly connectionId: string;
  readonly action: string;
  readonly sessionId: string;
  readonly ownerUid: string;
  readonly status: OperationStatus;
  /** Provider-side identifier once known (deployment id, message ts, …). */
  readonly providerRef?: string;
  readonly claimedAt: Date;
  readonly settledAt?: Date;
  readonly outcome?: string;
}

export class OperationAlreadyClaimedError extends Error {
  readonly operationId: string;
  constructor(operationId: string) { super(`Operation ${operationId} was already claimed.`); this.operationId = operationId; }
}
export class ReconciliationRequiredError extends Error {
  readonly operationId: string;
  constructor(operationId: string) {
    super(`Operation ${operationId} has an uncertain outcome; reconcile it before running this action again.`);
    this.operationId = operationId;
  }
}

const collection = 'connection_operations';

export class OperationLedger {
  readonly #firestore: Firestore;
  constructor(firestore: Firestore) { this.#firestore = firestore; }

  /**
   * Claims `id` for `action` on a connection. Fails if the id is taken, or if
   * any earlier operation for the same connection+action is still claimed or
   * uncertain — the caller must reconcile first, never retry blind.
   */
  async claim(input: Omit<OperationRecord, 'status' | 'claimedAt' | 'settledAt' | 'outcome' | 'providerRef'>): Promise<OperationRecord> {
    const ref = this.#firestore.collection(collection).doc(input.id);
    const claimedAt = new Date();
    return this.#firestore.runTransaction(async (transaction) => {
      const existing = await transaction.get(ref);
      if (existing.exists) throw new OperationAlreadyClaimedError(input.id);
      const unsettled = await transaction.get(this.#firestore.collection(collection)
        .where('connectionId', '==', input.connectionId).where('action', '==', input.action)
        .where('status', 'in', ['claimed', 'uncertain']).limit(1));
      const blocker = unsettled.docs[0];
      if (blocker !== undefined) throw new ReconciliationRequiredError(blocker.id);
      const record: OperationRecord = { ...input, status: 'claimed', claimedAt };
      transaction.create(ref, { ...record, claimedAt: Timestamp.fromDate(claimedAt) });
      return record;
    });
  }

  /** Records the provider's identifier as soon as it is known, before the outcome. */
  async recordProviderRef(id: string, providerRef: string): Promise<void> {
    await this.#firestore.collection(collection).doc(id).update({ providerRef });
  }

  async settle(id: string, status: Exclude<OperationStatus, 'claimed'>, outcome?: string): Promise<void> {
    const ref = this.#firestore.collection(collection).doc(id);
    await this.#firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new Error(`Operation ${id} was never claimed.`);
      const current = (snapshot.data() ?? {})['status'] as OperationStatus;
      if (current === 'succeeded' || current === 'failed') throw new Error(`Operation ${id} is already ${current}.`);
      transaction.update(ref, { status, settledAt: Timestamp.now(), ...(outcome === undefined ? {} : { outcome }) });
    });
  }

  async uncertain(connectionId: string): Promise<readonly OperationRecord[]> {
    const snapshot = await this.#firestore.collection(collection)
      .where('connectionId', '==', connectionId).where('status', '==', 'uncertain').get();
    return snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id, connectionId: data['connectionId'] as string, action: data['action'] as string,
        sessionId: data['sessionId'] as string, ownerUid: data['ownerUid'] as string, status: 'uncertain',
        claimedAt: (data['claimedAt'] as Timestamp).toDate(),
        ...(typeof data['providerRef'] === 'string' ? { providerRef: data['providerRef'] } : {}),
        ...(typeof data['outcome'] === 'string' ? { outcome: data['outcome'] } : {}),
      };
    });
  }
}
