import { randomUUID } from 'node:crypto';
import { type Firestore, Timestamp } from 'firebase-admin/firestore';

/**
 * Durable record of every external side effect a connection performs.
 *
 * Providers are not assumed to be idempotent: a lost response is not evidence
 * the action didn't happen. A worker must *claim* an operation id in a
 * transaction before calling out; if the result never arrives the operation is
 * left `uncertain`, and nothing with the same action may run again until an
 * operator or a provider lookup reconciles it to `succeeded` or `failed`.
 *
 * Each claim carries a lease token. Only the worker holding the token may
 * record progress or settle, so a worker that lost its claim (restart, long
 * pause) cannot overwrite a later decision. Reconciling an uncertain
 * operation is a separate, explicitly attributed step without a token.
 */
export const operationStatuses = ['claimed', 'succeeded', 'failed', 'uncertain'] as const;
export type OperationStatus = (typeof operationStatuses)[number];

export interface OperationRecord {
  readonly id: string;
  readonly connectionId: string;
  readonly action: string;
  readonly projectId: string;
  /** Where the effect lands (site id, channel id, bucket/prefix …). */
  readonly destination: string;
  /** Canonical hash of the request, kept for reconciliation. Never an idempotency key. */
  readonly requestFingerprint: string;
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
export class StaleOperationLeaseError extends Error {
  readonly operationId: string;
  constructor(operationId: string) { super(`Operation ${operationId} is held by another worker or already settled.`); this.operationId = operationId; }
}
export class ReconciliationRequiredError extends Error {
  readonly operationId: string;
  constructor(operationId: string) {
    super(`Operation ${operationId} has an uncertain outcome; reconcile it before running this action again.`);
    this.operationId = operationId;
  }
}

const collection = 'connection_operations';
type ClaimInput = Omit<OperationRecord, 'status' | 'claimedAt' | 'settledAt' | 'outcome' | 'providerRef'>;
export interface OperationClaim { readonly record: OperationRecord; readonly leaseToken: string; }

export class OperationLedger {
  readonly #firestore: Firestore;
  constructor(firestore: Firestore) { this.#firestore = firestore; }

  /**
   * Claims `id` for `action` on a connection. Fails if the id is taken, or if
   * any earlier operation for the same connection+action is still claimed or
   * uncertain — the caller must reconcile first, never retry blind.
   */
  async claim(input: ClaimInput): Promise<OperationClaim> {
    const ref = this.#firestore.collection(collection).doc(input.id);
    const claimedAt = new Date();
    const leaseToken = randomUUID();
    return this.#firestore.runTransaction(async (transaction) => {
      const existing = await transaction.get(ref);
      if (existing.exists) throw new OperationAlreadyClaimedError(input.id);
      const unsettled = await transaction.get(this.#firestore.collection(collection)
        .where('connectionId', '==', input.connectionId).where('action', '==', input.action)
        .where('status', 'in', ['claimed', 'uncertain']).limit(1));
      const blocker = unsettled.docs[0];
      if (blocker !== undefined) throw new ReconciliationRequiredError(blocker.id);
      const record: OperationRecord = { ...input, status: 'claimed', claimedAt };
      transaction.create(ref, { ...record, leaseToken, claimedAt: Timestamp.fromDate(claimedAt) });
      return { record, leaseToken };
    });
  }

  /** Records the provider's identifier as soon as it is known, before the outcome. */
  async recordProviderRef(id: string, leaseToken: string, providerRef: string): Promise<void> {
    const ref = this.#firestore.collection(collection).doc(id);
    await this.#firestore.runTransaction(async (transaction) => {
      requireLease(await transaction.get(ref), id, leaseToken);
      transaction.update(ref, { providerRef });
    });
  }

  /** The claiming worker reports the outcome; `uncertain` releases the lease without resolving. */
  async settle(id: string, leaseToken: string, status: Exclude<OperationStatus, 'claimed'>, outcome?: string): Promise<void> {
    const ref = this.#firestore.collection(collection).doc(id);
    await this.#firestore.runTransaction(async (transaction) => {
      requireLease(await transaction.get(ref), id, leaseToken);
      transaction.update(ref, { status, leaseToken: null, settledAt: Timestamp.now(), ...(outcome === undefined ? {} : { outcome }) });
    });
  }

  /**
   * Resolves an uncertain operation from evidence: a provider lookup or an
   * explicit operator decision. Nothing here re-runs the action.
   */
  async reconcile(id: string, status: 'succeeded' | 'failed', input: { decidedBy: string; outcome: string; providerRef?: string }): Promise<void> {
    const ref = this.#firestore.collection(collection).doc(id);
    await this.#firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new Error(`Operation ${id} was never claimed.`);
      if ((snapshot.data() ?? {})['status'] !== 'uncertain') throw new Error(`Operation ${id} is not awaiting reconciliation.`);
      transaction.update(ref, {
        status, outcome: input.outcome, reconciledBy: input.decidedBy, settledAt: Timestamp.now(),
        ...(input.providerRef === undefined ? {} : { providerRef: input.providerRef }),
      });
    });
  }

  async uncertain(connectionId: string): Promise<readonly OperationRecord[]> {
    const snapshot = await this.#firestore.collection(collection)
      .where('connectionId', '==', connectionId).where('status', '==', 'uncertain').get();
    return snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id, connectionId: data['connectionId'] as string, action: data['action'] as string,
        projectId: data['projectId'] as string, destination: data['destination'] as string,
        requestFingerprint: data['requestFingerprint'] as string,
        sessionId: data['sessionId'] as string, ownerUid: data['ownerUid'] as string, status: 'uncertain',
        claimedAt: (data['claimedAt'] as Timestamp).toDate(),
        ...(typeof data['providerRef'] === 'string' ? { providerRef: data['providerRef'] } : {}),
        ...(typeof data['outcome'] === 'string' ? { outcome: data['outcome'] } : {}),
      };
    });
  }
}

function requireLease(snapshot: { exists: boolean; data(): Record<string, unknown> | undefined }, id: string, leaseToken: string): void {
  if (!snapshot.exists) throw new Error(`Operation ${id} was never claimed.`);
  const data = snapshot.data() ?? {};
  if (data['status'] !== 'claimed' || data['leaseToken'] !== leaseToken) throw new StaleOperationLeaseError(id);
}
