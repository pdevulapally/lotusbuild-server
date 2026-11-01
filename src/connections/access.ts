import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { AppError } from '../http/errors.ts';

export function documentId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('Invalid connection resource ID.');
  return value;
}

// The current project model is personal ownership, not workspace membership.
// Sharing must not be inferred from a client-provided workspace or editor list.
export async function requireProject(transaction: Transaction, db: Firestore, ownerUid: string, projectId: string): Promise<void> {
  const project = await transaction.get(db.doc(`projects/${documentId(projectId)}`));
  const erasure = await transaction.get(db.doc(`accountErasures/${documentId(ownerUid)}`));
  const data = project.data();
  if (!project.exists || data?.['ownerUid'] !== ownerUid || data['status'] !== 'draft' || erasure.exists) {
    throw new AppError({ code: 'project/not-found', statusCode: 404, message: 'No accessible project.' });
  }
}

export async function requireSession(transaction: Transaction, db: Firestore, input: {
  ownerUid: string; projectId: string; sessionId: string;
}): Promise<void> {
  await requireProject(transaction, db, input.ownerUid, input.projectId);
  const session = await transaction.get(db.doc(`sessions/${documentId(input.sessionId)}`));
  const data = session.data();
  if (!session.exists || data?.['ownerUid'] !== input.ownerUid || data['projectId'] !== input.projectId || data['cancelRequested'] === true) {
    throw new AppError({ code: 'session/not-found', statusCode: 404, message: 'No accessible session.' });
  }
}
