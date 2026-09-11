import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { FieldPath, FieldValue, Timestamp, type Firestore, type Transaction } from 'firebase-admin/firestore';
import type { AuthenticatedUser } from '../auth/plugin.ts';
import { AppError } from '../http/errors.ts';
import { stringField, timestampField } from '../support/documents.ts';
import type { SessionRepository } from '../sessions/repository.ts';

function denied() { return new AppError({ code: 'family/access-denied', statusCode: 403, message: 'This family access is not authorized.' }); }
function verified(user: AuthenticatedUser) { if (!user.emailVerified) throw new AppError({ code: 'family/email-verification-required', statusCode: 403, message: 'Verify your email before linking family accounts.' }); }

/** Family links grant access to specific projects, never the parent's identity or billing account. */
export class FamilyService {
  readonly #db: Firestore;
  readonly #invitationTtl: number;
  constructor(db: Firestore, invitationTtlSeconds: number) {
    if (!Number.isSafeInteger(invitationTtlSeconds) || invitationTtlSeconds <= 0) throw new Error('Invalid family invitation lifetime.');
    this.#db = db; this.#invitationTtl = invitationTtlSeconds;
  }
  async invite(parent: AuthenticatedUser, declarations: { adultConfirmed: boolean; parentalResponsibilityConfirmed: boolean }) {
    verified(parent);
    if (!declarations.adultConfirmed || !declarations.parentalResponsibilityConfirmed) throw denied();
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.#invitationTtl * 1000);
    // One outstanding invitation per parent bounds unused invitations; only the hash is retained.
    const ref = this.#db.doc(`familyInvitations/${parent.uid}`);
    await this.#db.runTransaction(async (tx) => {
      const ownLink = await tx.get(this.#db.doc(`familyLinks/${parent.uid}`));
      const erasure = await tx.get(this.#db.doc(`accountErasures/${parent.uid}`));
      if (erasure.exists) throw denied();
      if (ownLink.exists) throw denied();
      tx.set(ref, { tokenHash: createHash('sha256').update(token).digest('hex'), parentUid: parent.uid,
        status: 'PENDING', expiresAt: Timestamp.fromDate(expiresAt), adultDeclared: true, parentalResponsibilityDeclared: true,
        declaredAt: FieldValue.serverTimestamp() });
    });
    return { parentUid: parent.uid, token, expiresAt: expiresAt.toISOString(), assurance: 'declarations-and-verified-email' };
  }
  async accept(child: AuthenticatedUser, parentUid: string, token: string) {
    verified(child);
    if (parentUid === child.uid) throw denied();
    const invitation = this.#db.doc(`familyInvitations/${parentUid}`);
    const link = this.#db.doc(`familyLinks/${child.uid}`);
    await this.#db.runTransaction(async (tx) => {
      const invite = await tx.get(invitation);
      const old = await tx.get(link);
      const childAccount = await tx.get(this.#db.doc(`users/${child.uid}`));
      const priorParentDeclaration = await tx.get(this.#db.doc(`familyInvitations/${child.uid}`));
      const parentErasure = await tx.get(this.#db.doc(`accountErasures/${parentUid}`));
      const childErasure = await tx.get(this.#db.doc(`accountErasures/${child.uid}`));
      if (parentErasure.exists || childErasure.exists) throw denied();
      // A revoked link may still be a discoverable erasure job. Replacing it
      // before cleanup completes would orphan old data or erase the new link.
      const previous = old.data();
      if (previous?.['parentUid'] !== undefined) {
        const previousParent = stringField(previous, 'parentUid', link.path);
        const previousErasure = await tx.get(this.#db.doc(`accountErasures/${previousParent}`));
        if (previousErasure.exists) throw denied();
      }
      if ((childAccount.data()?.['projectCount'] ?? 0) !== 0 || childAccount.data()?.['stripeCustomerId'] !== undefined || priorParentDeclaration.exists) throw denied();
      const fields = invite.data() ?? {};
      if (fields['status'] !== 'PENDING' || fields['tokenHash'] !== createHash('sha256').update(token).digest('hex')
        || timestampField(fields, 'expiresAt', invitation.path).getTime() <= Date.now()
        || (old.exists && old.data()?.['status'] !== 'REVOKED')) throw denied();
      tx.set(link, { parentUid, childUid: child.uid, childEmail: child.email ?? '', status: 'PENDING', createdAt: FieldValue.serverTimestamp() });
      tx.update(invitation, { status: 'CONSUMED', tokenHash: FieldValue.delete() });
    });
    return { status: 'PENDING', message: 'The parent must confirm this link before you can access any project.' };
  }
  async confirm(parent: AuthenticatedUser, childUid: string, approve: boolean) {
    verified(parent);
    const ref = this.#db.doc(`familyLinks/${childUid}`);
    await this.#db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (snapshot.data()?.['parentUid'] !== parent.uid) throw denied();
      if (approve && snapshot.data()?.['status'] !== 'PENDING') throw denied();
      tx.update(ref, { status: approve ? 'ACTIVE' : 'REVOKED', updatedAt: FieldValue.serverTimestamp() });
    });
  }
  async #requireLink(tx: Transaction, childUid: string, parentUid?: string) {
    const ref = this.#db.doc(`familyLinks/${childUid}`);
    const snapshot = await tx.get(ref);
    const fields = snapshot.data() ?? {};
    if (fields['status'] !== 'ACTIVE' || (parentUid !== undefined && fields['parentUid'] !== parentUid)) throw denied();
    return stringField(fields, 'parentUid', ref.path);
  }
  async grant(parent: AuthenticatedUser, childUid: string, projectId: string, enabled: boolean) {
    verified(parent);
    await this.#db.runTransaction(async (tx) => {
      await this.#requireLink(tx, childUid, parent.uid);
      const project = await tx.get(this.#db.doc(`projects/${projectId}`));
      if (project.data()?.['ownerUid'] !== parent.uid || project.data()?.['status'] === 'deleting') throw denied();
      tx.set(this.#db.doc(`familyLinks/${childUid}/projects/${projectId}`), { enabled, updatedAt: FieldValue.serverTimestamp() });
    });
  }
  async parentForProject(childUid: string, projectId: string): Promise<string> {
    return this.#db.runTransaction(async (tx) => {
      const parentUid = await this.#requireLink(tx, childUid);
      const grant = await tx.get(this.#db.doc(`familyLinks/${childUid}/projects/${projectId}`));
      const project = await tx.get(this.#db.doc(`projects/${projectId}`));
      if (grant.data()?.['enabled'] !== true || project.data()?.['ownerUid'] !== parentUid || project.data()?.['status'] === 'deleting') throw denied();
      const erasure = await tx.get(this.#db.doc(`accountErasures/${parentUid}`));
      if (erasure.exists) throw denied();
      return parentUid;
    });
  }
  async children(parent: AuthenticatedUser, limit = 100, after?: string) {
    verified(parent);
    let query = this.#db.collection('familyLinks').where('parentUid', '==', parent.uid).orderBy(FieldPath.documentId());
    if (after !== undefined) query = query.startAfter(after);
    const page = await query.limit(limit).get();
    return page.docs.map((doc) => ({ childUid: doc.id, email: doc.data()['childEmail'], status: doc.data()['status'] }));
  }

  async requestBuild(childUid: string, projectId: string, input: { prompt: string; model: string }) {
    const ref = this.#db.doc(`familyLinks/${childUid}/buildRequests/${projectId}`);
    return this.#db.runTransaction(async (tx) => {
      const parentUid = await this.#requireLink(tx, childUid);
      const grant = await tx.get(this.#db.doc(`familyLinks/${childUid}/projects/${projectId}`));
      const project = await tx.get(this.#db.doc(`projects/${projectId}`));
      const old = await tx.get(ref);
      const erasure = await tx.get(this.#db.doc(`accountErasures/${parentUid}`));
      if (erasure.exists || grant.data()?.['enabled'] !== true || project.data()?.['ownerUid'] !== parentUid || project.data()?.['status'] === 'deleting') throw denied();
      // Retained requests keep their owner, including when legacy metadata is missing.
      if (old.exists && old.data()?.['parentUid'] !== parentUid) throw denied();
      if (old.data()?.['status'] === 'PENDING' || old.data()?.['status'] === 'APPROVING') {
        throw new AppError({ code: 'family/request-pending', statusCode: 409, message: 'A build request is already waiting for this project.' });
      }
      const requestId = randomUUID();
      tx.set(ref, { ...input, requestId, parentUid, status: 'PENDING', createdAt: FieldValue.serverTimestamp() });
      return { requestId, status: 'PENDING' };
    });
  }

  async buildRequests(parent: AuthenticatedUser, childUid: string, limit = 100, after?: string) {
    verified(parent);
    await this.#db.runTransaction((tx) => this.#requireLink(tx, childUid, parent.uid));
    // A current link does not transfer ownership of retained requests. Scope before paging.
    let query = this.#db.collection(`familyLinks/${childUid}/buildRequests`)
      .where('parentUid', '==', parent.uid).orderBy(FieldPath.documentId());
    if (after !== undefined) query = query.startAfter(after);
    const page = await query.limit(limit).get();
    return page.docs.map((doc) => ({ projectId: doc.id, requestId: doc.data()['requestId'], status: doc.data()['status'],
      prompt: doc.data()['prompt'], model: doc.data()['model'], sessionId: doc.data()['sessionId'] }));
  }

  async decideBuild(parent: AuthenticatedUser, childUid: string, projectId: string, requestId: string, approved: boolean, sessions: SessionRepository) {
    verified(parent);
    const ref = this.#db.doc(`familyLinks/${childUid}/buildRequests/${projectId}`);
    const request = await this.#db.runTransaction(async (tx) => {
      await this.#requireLink(tx, childUid, parent.uid);
      const grant = await tx.get(this.#db.doc(`familyLinks/${childUid}/projects/${projectId}`));
      const snapshot = await tx.get(ref);
      const fields = snapshot.data() ?? {};
      if (grant.data()?.['enabled'] !== true || fields['parentUid'] !== parent.uid || fields['requestId'] !== requestId) throw denied();
      if (!approved) {
        if (fields['status'] !== 'PENDING') throw denied();
        tx.update(ref, { status: 'REJECTED', prompt: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
        return undefined;
      }
      if (!['PENDING', 'APPROVING', 'FULFILLED'].includes(String(fields['status']))) throw denied();
      const sessionId = typeof fields['sessionId'] === 'string' ? fields['sessionId'] : `family-${randomUUID()}`;
      if (fields['status'] === 'PENDING') tx.update(ref, { status: 'APPROVING', sessionId, updatedAt: FieldValue.serverTimestamp() });
      return { sessionId, prompt: stringField(fields, 'prompt', ref.path), model: stringField(fields, 'model', ref.path) };
    });
    if (request === undefined) return { status: 'REJECTED' };
    // The session ID is fixed durably before dispatch. Retrying a lost response
    // cannot create or charge a second build, even if the first already ended.
    const session = await sessions.create(parent.uid, projectId, request, request.sessionId);
    await this.#db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (snapshot.data()?.['requestId'] !== requestId || snapshot.data()?.['sessionId'] !== session.id) throw new Error('Family build request changed during approval.');
      tx.update(ref, { status: 'FULFILLED', updatedAt: FieldValue.serverTimestamp() });
    });
    return { status: 'FULFILLED', sessionId: session.id };
  }
}
