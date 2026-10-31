import { mutation, readMutationRecord, writeMutation, type Mutation } from '../http/idempotency.ts';
import { type DocumentReference, type Firestore, type Transaction } from 'firebase-admin/firestore';
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

const replayedCommand = Symbol('replayed-command');
export function commandWasReplayed(value: unknown): boolean {
  return value !== null && typeof value === 'object' && Reflect.get(value, replayedCommand) === true;
}
/** Transient provenance from a durable receipt, never a process-local deduplication cache. */
export function reconciledCommand<T>(accepted: unknown, current: T): T {
  if (commandWasReplayed(accepted) && current !== null && typeof current === 'object') Object.defineProperty(current, replayedCommand, { value: true });
  return current;
}

/** Domain acceptance uses the shared mutation ledger, with current-state reconciliation on replay. */
export async function commandTransaction<T>(options: {
  db: Firestore; parent: DocumentReference; uid: string; key: string | Mutation<T> | undefined;
  input: readonly unknown[]; decode: (value: unknown, tx: Transaction) => T | Promise<T>; encode?: (value: T) => unknown;
  work: (tx: Transaction) => Promise<T>;
}): Promise<T> {
  const { db, parent, uid, input, decode, work } = options;
  const operation = typeof options.key === 'object' ? options.key : mutation<T>(uid, `command ${parent.path}`, commandKey(options.key), input,
    value => ({ statusCode: 200, body: options.encode === undefined ? value : options.encode(value) }));
  if (operation === undefined) return db.runTransaction(work);
  if (operation.uid !== uid) throw new Error('Command owner disagrees.');
  return db.runTransaction(async (tx) => {
    const scope = await tx.get(parent);
    if (!scope.exists || (scope.data()?.['ownerUid'] !== uid && !(parent.path === `users/${uid}` && scope.data()?.['uid'] === uid)) || scope.data()?.['status'] === 'deleting') {
      throw new AppError({ code: 'command/not-found', statusCode: 404, message: 'No such command scope.' });
    }
    const prior = await readMutationRecord(tx, db, operation);
    if (prior !== undefined) {
      // Both legacy HTTP receipts and new acceptance receipts reconcile without re-executing.
      const result = await decode(Object.hasOwn(prior, 'acceptance') ? prior.acceptance : prior.response.body, tx);
      if (result !== null && typeof result === 'object') Object.defineProperty(result, replayedCommand, { value: true });
      return result;
    }
    const result = await work(tx);
    writeMutation(tx, db, operation, result, options.encode === undefined ? result : options.encode(result));
    return result;
  });
}
