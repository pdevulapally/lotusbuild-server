import { Timestamp } from 'firebase-admin/firestore';

export interface HoldDecision {
  readonly id: string;
  readonly meterKey: string;
  readonly estimatedQuantity: number | undefined;
  /** Why this hold is (or is not) one the closure may settle. */
  readonly verdict: 'settle' | 'already-closed' | 'not-in-flight' | 'has-usage' | 'resource-hold' | 'not-a-token-meter';
}

export interface ClosurePlan {
  readonly sessionId: string;
  readonly ownerUid: string;
  readonly holds: readonly HoldDecision[];
}

const field = (record: Readonly<Record<string, unknown>>, key: string): unknown => record[key];

/**
 * Decides which holds of a session the user stopped may be closed by an
 * operator. A session qualifies only when it is still RUNNING with the user's
 * cancellation recorded and its lease long expired: that is the shape left
 * behind when a cut-off model call never reported usage, which recovery
 * refuses to guess at. Each hold is judged by the same rule
 * `MeteringService.settleUnobserved` enforces, so the dry run shows exactly
 * what applying would do and nothing the service would refuse.
 */
export function planCancelledHoldClosure(input: {
  readonly sessionId: string;
  readonly session: Readonly<Record<string, unknown>> | undefined;
  readonly reservations: ReadonlyMap<string, Readonly<Record<string, unknown>> | undefined>;
  readonly tokenMeterKeys: ReadonlySet<string>;
  readonly now: Date;
}): ClosurePlan {
  const { session } = input;
  if (session === undefined) throw new Error(`Session ${input.sessionId} does not exist.`);
  const ownerUid = field(session, 'ownerUid');
  if (typeof ownerUid !== 'string' || ownerUid === '') throw new Error(`Session ${input.sessionId} has no owner.`);
  if (field(session, 'status') !== 'RUNNING' || field(session, 'cancelRequested') !== true) {
    throw new Error(`Session ${input.sessionId} is ${String(field(session, 'status'))} without a pending cancellation; nothing to close.`);
  }
  // A running session becomes claimable again when its lease lapses, so a
  // future claimableAt means a worker may still be finishing it.
  const claimableAt = field(session, 'claimableAt');
  if (claimableAt instanceof Timestamp && claimableAt.toMillis() > input.now.getTime()) {
    throw new Error(`Session ${input.sessionId} still has a live lease; a worker may be finishing it.`);
  }

  const ids = [...new Set([
    ...(Array.isArray(field(session, 'reservationIds')) ? (field(session, 'reservationIds') as unknown[]) : []),
    ...(Array.isArray(field(session, 'specialistReservationIds')) ? (field(session, 'specialistReservationIds') as unknown[]) : []),
  ].filter((id): id is string => typeof id === 'string'))];

  const holds = ids.map((id): HoldDecision => {
    const record = input.reservations.get(id);
    if (record === undefined) throw new Error(`Reservation ${id} of session ${input.sessionId} does not exist.`);
    const meterKey = String(field(record, 'meterKey') ?? '');
    const estimated = field(record, 'estimatedQuantity');
    const base = { id, meterKey, estimatedQuantity: typeof estimated === 'number' ? estimated : undefined };
    if (field(record, 'status') !== 'OPEN') return { ...base, verdict: 'already-closed' };
    if (field(record, 'inFlight') !== true) return { ...base, verdict: 'not-in-flight' };
    if (typeof field(record, 'observedQuantity') === 'number') return { ...base, verdict: 'has-usage' };
    if (field(record, 'sandboxExternalId') !== undefined) return { ...base, verdict: 'resource-hold' };
    if (!input.tokenMeterKeys.has(meterKey)) return { ...base, verdict: 'not-a-token-meter' };
    return { ...base, verdict: 'settle' };
  });

  return { sessionId: input.sessionId, ownerUid, holds };
}
