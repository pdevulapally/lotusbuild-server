import { createHash } from 'node:crypto';
import { FieldValue, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { AppError } from './errors.ts';
import { MutationReplay, type MutationResponse } from './mutation-response.ts';

export interface Mutation<T> {
  readonly uid: string;
  readonly scope: string;
  readonly id: string;
  readonly fingerprint: string;
  readonly response: (value: T) => MutationResponse;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

/** Optional for existing callers. New clients retain one key per intentional action. */
export function mutation<T>(uid: string, scope: string, key: string | string[] | undefined,
  payload: unknown, response: (value: T) => MutationResponse): Mutation<T> | undefined {
  if (key === undefined) return undefined;
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) {
    throw new AppError({ code: 'request/invalid-idempotency-key', statusCode: 400,
      message: 'Idempotency-Key must contain 16–128 letters, digits, hyphens or underscores.' });
  }
  const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return { uid, scope, id: digest([uid, scope, key]), fingerprint: digest(canonical(payload)), response };
}

/** Must run after current ownership/erasure checks and before transaction writes. */
export async function readMutation<T>(tx: Transaction, db: Firestore, operation: Mutation<T> | undefined): Promise<void> {
  if (operation === undefined) return;
  const snap = await tx.get(db.doc(`mutationReceipts/${operation.id}`));
  if (!snap.exists) return;
  const fields = snap.data()!;
  if (fields['uid'] !== operation.uid || fields['scope'] !== operation.scope) throw new Error('Mutation receipt scope disagrees.');
  if (fields['fingerprint'] !== operation.fingerprint) {
    throw new AppError({ code: 'request/idempotency-conflict', statusCode: 409,
      message: 'This Idempotency-Key was already used for a different request.' });
  }
  const statusCode = fields['statusCode'];
  if (!Number.isInteger(statusCode) || statusCode < 200 || statusCode > 299 || !Object.hasOwn(fields, 'body')) {
    throw new Error('Invalid mutation receipt.');
  }
  throw new MutationReplay({ statusCode, body: fields['body'] });
}

/** Commit the response in the SAME transaction as the mutation, never afterwards. */
export function writeMutation<T>(tx: Transaction, db: Firestore, operation: Mutation<T> | undefined, value: T): void {
  if (operation === undefined) return;
  const result = operation.response(value);
  tx.create(db.doc(`mutationReceipts/${operation.id}`), {
    uid: operation.uid, scope: operation.scope, fingerprint: operation.fingerprint,
    statusCode: result.statusCode, body: JSON.parse(JSON.stringify(result.body)),
    createdAt: FieldValue.serverTimestamp(),
  });
}
