import { createHash } from 'node:crypto';
import { FieldValue, type DocumentReference, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { AppError } from '../http/errors.ts';

export function commandKey(value: unknown, required = false): string | undefined {
  if (value === undefined) {
    if (required) throw new AppError({ code: 'command/key-required', statusCode: 400, message: 'Send a stable Idempotency-Key so this command can be safely reconciled.' });
    return undefined; // Internal repository callers may not be HTTP commands.
  }
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) {
    throw new AppError({ code: 'command/invalid-key', statusCode: 400, message: 'Use a stable Idempotency-Key of 16 to 128 letters, digits, underscores or hyphens.' });
  }
  return value;
}

/** Acceptance and its receipt commit together. No process-local locks or expiring in-flight claims. */
export async function commandTransaction<T>(options: {
  db: Firestore; parent: DocumentReference; uid: string; key: string | undefined;
  input: readonly unknown[]; decode: (value: unknown, tx: Transaction) => T | Promise<T>; encode?: (value: T) => unknown;
  work: (tx: Transaction) => Promise<T>;
}): Promise<T> {
  const { db, parent, uid, input, decode, work } = options;
  const key = commandKey(options.key);
  if (key === undefined) return db.runTransaction(work);
  const ref = parent.collection('commands').doc(createHash('sha256').update(JSON.stringify([uid, key])).digest('hex'));
  const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  return db.runTransaction(async (tx) => {
    const scope = await tx.get(parent);
    if (!scope.exists || (scope.data()?.['ownerUid'] !== uid && !(parent.path === `users/${uid}` && scope.data()?.['uid'] === uid)) || scope.data()?.['status'] === 'deleting') {
      throw new AppError({ code: 'command/not-found', statusCode: 404, message: 'No such command scope.' });
    }
    const prior = await tx.get(ref);
    if (prior.exists) {
      const fields = prior.data();
      if (fields?.['fingerprint'] !== fingerprint) throw new AppError({
        code: 'command/conflict', statusCode: 409, message: 'This command identity was already used for a different request.',
      });
      if (typeof fields['result'] !== 'string') throw new Error('Invalid command receipt.');
      return decode(JSON.parse(fields['result']), tx);
    }
    const result = await work(tx);
    tx.create(ref, { fingerprint, result: JSON.stringify(options.encode === undefined ? result : options.encode(result)), createdAt: FieldValue.serverTimestamp() });
    return result;
  });
}
