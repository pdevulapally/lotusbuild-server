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
 * Mutual exclusion per connection+action is a lock document read and written
 * inside the claim transaction, so two concurrent claims cannot both commit.
 * Each claim carries a lease token with an expiry: only the holder may record
 * progress or settle; a claim whose lease lapsed (worker crash) is treated as
 * uncertain — it never silently unblocks, and it can be reconciled.
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
const locks = 'connection_action_locks';
export const defaultLeaseMs = 10 * 60 * 1000;
type ClaimInput = Omit<OperationRecord, 'status' | 'claimedAt' | 'settledAt' | 'outcome' | 'providerRef'>;
export interface OperationClaim { readonly record: OperationRecord; readonly leaseToken: string; readonly leaseExpiresAt: Date; }
type Snapshot = { exists: boolean; data(): Record<string, unknown> | undefined };

export class OperationLedger {
  readonly #firestore: Firestore;
  readonly #leaseMs: number;
  constructor(firestore: Firestore, leaseMs = defaultLeaseMs) { this.#firestore = firestore; this.#leaseMs = leaseMs; }

  #lockRef(connectionId: string, action: string) {
    return this.#firestore.collection(locks).doc(`${connectionId}__${action.replaceAll('/', '_')}`);
  }

  /**
   * Claims `id` for `action` on a connection. Fails if the id is taken, or if
   * the connection+action lock points at an operation that is still claimed
   * (lease alive) or uncertain — the caller must reconcile first, never retry
   * blind. A claimed operation whose lease has lapsed is flipped to
   * `uncertain` here so it becomes reconcilable, and still blocks.
   */
  async claim(input: ClaimInput, now = new Date()): Promise<OperationClaim> {
    const ref = this.#firestore.collection(collection).doc(input.id);
    const lockRef = this.#lockRef(input.connectionId, input.action);
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + this.#leaseMs);
    const outcome = await this.#firestore.runTransaction(async (transaction): Promise<OperationClaim | { blockedBy: string }> => {
      const existing = await transaction.get(ref);
      if (existing.exists) throw new OperationAlreadyClaimedError(input.id);
      const lock = await transaction.get(lockRef);
      const activeId = (lock.data() ?? {})['activeOperationId'];
      if (typeof activeId === 'string') {
        const active = await transaction.get(this.#firestore.collection(collection).doc(activeId));
        const data = active.data() ?? {};
        if (data['status'] === 'claimed' && leaseLapsed(data, now)) {
          // Committed even though the claim is refused: the stranded claim must become reconcilable.
          transaction.update(active.ref, { status: 'uncertain', leaseToken: null, settledAt: Timestamp.fromDate(now), outcome: 'worker lease expired before the outcome was recorded' });
          return { blockedBy: activeId };
        }
        if (data['status'] === 'claimed' || data['status'] === 'uncertain') return { blockedBy: activeId };
      }
      const record: OperationRecord = { ...input, status: 'claimed', claimedAt: now };
      transaction.create(ref, { ...record, leaseToken, leaseExpiresAt: Timestamp.fromDate(leaseExpiresAt), claimedAt: Timestamp.fromDate(now) });
      transaction.set(lockRef, { connectionId: input.connectionId, action: input.action, activeOperationId: input.id, updatedAt: Timestamp.fromDate(now) });
      return { record, leaseToken, leaseExpiresAt };
    });
    if ('blockedBy' in outcome) throw new ReconciliationRequiredError(outcome.blockedBy);
    return outcome;
  }

  /** Records the provider's identifier as soon as it is known, before the outcome. */
  async recordProviderRef(id: string, leaseToken: string, providerRef: string, now = new Date()): Promise<void> {
    const ref = this.#firestore.collection(collection).doc(id);
    await this.#firestore.runTransaction(async (transaction) => {
      requireLease(await transaction.get(ref), id, leaseToken, now);
      transaction.update(ref, { providerRef });
    });
  }

  /** The claiming worker reports the outcome; `uncertain` releases the lease without resolving. */
  async settle(id: string, leaseToken: string, status: Exclude<OperationStatus, 'claimed'>, outcome?: string, now = new Date()): Promise<void> {
    const ref = this.#firestore.collection(collection).doc(id);
    await this.#firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      requireLease(snapshot, id, leaseToken, now);
      const data = snapshot.data() ?? {};
      const lockRef = this.#lockRef(data['connectionId'] as string, data['action'] as string);
      const lock = await transaction.get(lockRef);
      transaction.update(ref, { status, leaseToken: null, settledAt: Timestamp.fromDate(now), ...(outcome === undefined ? {} : { outcome }) });
      if (status !== 'uncertain' && (lock.data() ?? {})['activeOperationId'] === id) transaction.update(lockRef, { activeOperationId: null, updatedAt: Timestamp.fromDate(now) });
    });
  }

  /**
   * Resolves an uncertain operation (or a claimed one whose lease lapsed) from
   * evidence: a provider lookup or an explicit operator decision. Nothing here
   * re-runs the action.
   */
  async reconcile(id: string, status: 'succeeded' | 'failed', input: { decidedBy: string; outcome: string; providerRef?: string }, now = new Date()): Promise<void> {
    const ref = this.#firestore.collection(collection).doc(id);
    await this.#firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new Error(`Operation ${id} was never claimed.`);
      const data = snapshot.data() ?? {};
      const stranded = data['status'] === 'claimed' && leaseLapsed(data, now);
      if (data['status'] !== 'uncertain' && !stranded) throw new Error(`Operation ${id} is not awaiting reconciliation.`);
      const lockRef = this.#lockRef(data['connectionId'] as string, data['action'] as string);
      const lock = await transaction.get(lockRef);
      transaction.update(ref, {
        status, leaseToken: null, outcome: input.outcome, reconciledBy: input.decidedBy, settledAt: Timestamp.fromDate(now),
        ...(input.providerRef === undefined ? {} : { providerRef: input.providerRef }),
      });
      if ((lock.data() ?? {})['activeOperationId'] === id) transaction.update(lockRef, { activeOperationId: null, updatedAt: Timestamp.fromDate(now) });
    });
  }

  /** Operations awaiting reconciliation for a connection (composite index: connectionId asc, status asc). */
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

function leaseLapsed(data: Record<string, unknown>, now: Date): boolean {
  const expires = data['leaseExpiresAt'];
  return expires instanceof Timestamp && expires.toMillis() <= now.getTime();
}

function requireLease(snapshot: Snapshot, id: string, leaseToken: string, now: Date): void {
  if (!snapshot.exists) throw new Error(`Operation ${id} was never claimed.`);
  const data = snapshot.data() ?? {};
  if (data['status'] !== 'claimed' || data['leaseToken'] !== leaseToken || leaseLapsed(data, now)) throw new StaleOperationLeaseError(id);
}
