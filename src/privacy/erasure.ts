import type { Auth } from 'firebase-admin/auth';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import type { ProjectRepository } from '../projects/repository.ts';
import type { SessionRepository } from '../sessions/repository.ts';
import { AppError } from '../http/errors.ts';

export interface ErasureDecision {
  readonly requestReference: string;
  readonly billingReviewReference: string;
  readonly retentionDecisionReference: string;
}

/** Operator-only fulfillment after identity, billing and legal-retention review. No public destructive shortcut. */
export class AccountErasure {
  readonly #db: Firestore;
  readonly #auth: Auth;
  readonly #projects: ProjectRepository;
  readonly #clearCaches: (uid: string) => Promise<void>;
  readonly #sessions: SessionRepository;
  constructor(db: Firestore, auth: Auth, projects: ProjectRepository, sessions: SessionRepository, clearCaches: (uid: string) => Promise<void>) {
    this.#db = db; this.#auth = auth; this.#projects = projects; this.#clearCaches = clearCaches;
    this.#sessions = sessions;
  }
  async apply(uid: string, decision: ErasureDecision) {
    for (const value of Object.values(decision)) if (typeof value !== 'string' || value.trim() === '' || value.length > 500) throw new Error('Documented erasure, billing and retention decisions are required.');
    const ref = this.#db.doc(`accountErasures/${uid}`);
    await this.#db.runTransaction(async (tx) => {
      const old = await tx.get(ref);
      if (!old.exists) tx.create(ref, { status: 'PENDING', ...decision, requestedAt: FieldValue.serverTimestamp() });
    });
    await this.#ignoreAbsent(() => this.#auth.updateUser(uid, { disabled: true }));
    await this.#ignoreAbsent(() => this.#auth.revokeRefreshTokens(uid));
    const cancelling = await this.#db.collection('sessions').where('ownerUid', '==', uid).where('status', 'in', ['QUEUED', 'RUNNING']).limit(100).get();
    for (const session of cancelling.docs) {
      try { await this.#sessions.cancel(uid, session.id); }
      catch (error) { if ((error as { code?: string }).code !== 'session/not-cancellable') throw error; }
    }
    const active = await this.#db.collection('sessions').where('ownerUid', '==', uid).where('status', 'in', ['QUEUED', 'RUNNING']).limit(1).get();
    if (!active.empty) throw new AppError({ code: 'account/erasure-pending', statusCode: 409,
      message: 'Account access is disabled. Stop or reconcile active builds before retrying erasure.' });
    const open = await this.#db.collection(`users/${uid}/reservations`).where('status', '==', 'OPEN').limit(1).get();
    if (!open.empty) throw new AppError({ code: 'account/reconciliation-required', statusCode: 409,
      message: 'Resolve outstanding usage or resource reservations before completing account erasure.' });
    for (;;) {
      const page = await this.#db.collection('projects').where('ownerUid', '==', uid).limit(100).get();
      if (page.empty) break;
      for (const project of page.docs) await this.#projects.delete(uid, project.id);
    }
    // A parent's erasure revokes the child's link; it does not erase another person's Firebase identity.
    for (;;) {
      const links = await this.#db.collection('familyLinks').where('parentUid', '==', uid).limit(100).get();
      if (links.empty) break;
      for (const link of links.docs) {
        await link.ref.update({ status: 'REVOKED', parentUid: FieldValue.delete(), childEmail: FieldValue.delete() });
        await this.#db.recursiveDelete(link.ref.collection('projects'));
        await this.#db.recursiveDelete(link.ref.collection('buildRequests'));
      }
    }
    await this.#db.recursiveDelete(this.#db.doc(`familyLinks/${uid}`));
    await this.#db.doc(`familyInvitations/${uid}`).delete();
    await this.#clearCaches(uid);
    await this.#ignoreAbsent(() => this.#auth.deleteUser(uid));
    // Financial subcollections remain segregated from the removed account profile.
    // Their disposal follows the reviewed retention decision, not blanket account deletion.
    await this.#db.doc(`users/${uid}`).delete();
    await ref.update({ status: 'LIVE_CONTENT_ERASED_VENDOR_CONFIRMATION_PENDING', updatedAt: FieldValue.serverTimestamp() });
    return { status: 'LIVE_CONTENT_ERASED_VENDOR_CONFIRMATION_PENDING', retained: ['reviewed financial records', 'minimal erasure/rights record', 'provider copies pending verified deletion or expiry'] };
  }
  async #ignoreAbsent(work: () => Promise<unknown>) {
    try { await work(); } catch (error) { if ((error as { code?: string }).code !== 'auth/user-not-found') throw error; }
  }
}
