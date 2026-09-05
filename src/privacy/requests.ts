import { randomUUID } from 'node:crypto';
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import type { FastifyInstance } from 'fastify';
import { authenticatedUser } from '../auth/plugin.ts';
import { enumField, stringField, timestampField } from '../support/documents.ts';

export const privacyRequestKinds = ['access', 'erasure', 'rectification', 'complaint'] as const;
type Kind = (typeof privacyRequestKinds)[number];
const statuses = ['RECEIVED', 'IN_PROGRESS', 'COMPLETED'] as const;

/** One active request per kind/account prevents duplicate submissions becoming an unbounded queue. */
export class PrivacyRequests {
  readonly #firestore: Firestore;
  constructor(firestore: Firestore) { this.#firestore = firestore; }
  async submit(uid: string, kind: Kind) {
    const ref = this.#firestore.doc(`privacyRequests/${uid}/requests/${kind}`);
    return this.#firestore.runTransaction(async (tx) => {
      const old = await tx.get(ref);
      if (old.exists && old.data()?.['status'] !== 'COMPLETED') return this.#response(old.data()!, ref.path);
      const reference = randomUUID();
      const now = new Date();
      tx.set(ref, { reference, kind, status: 'RECEIVED', receivedAt: Timestamp.fromDate(now), updatedAt: FieldValue.serverTimestamp() });
      return { reference, kind, status: 'RECEIVED', receivedAt: now.toISOString() };
    });
  }
  async list(uid: string) {
    const page = await this.#firestore.collection(`privacyRequests/${uid}/requests`).limit(privacyRequestKinds.length).get();
    return page.docs.map((doc) => this.#response(doc.data(), doc.ref.path));
  }
  #response(fields: Record<string, unknown>, path: string) {
    return { reference: stringField(fields, 'reference', path), kind: enumField(fields, 'kind', path, privacyRequestKinds),
      status: enumField(fields, 'status', path, statuses), receivedAt: timestampField(fields, 'receivedAt', path).toISOString() };
  }
}

export function registerPrivacyRoutes(app: FastifyInstance, requests: PrivacyRequests) {
  app.post<{ Body: { kind: Kind } }>('/me/privacy-requests', {
    preHandler: [app.requireAuth, app.enforceRateLimit('write')],
    schema: { body: { type: 'object', required: ['kind'], additionalProperties: false,
      properties: { kind: { type: 'string', enum: privacyRequestKinds } } } },
  }, async (request, reply) => reply.code(202).send({
    request: await requests.submit(authenticatedUser(request).uid, request.body.kind),
    message: 'Your request has been recorded for review. This acknowledgement does not mean that your data has already been exported, changed or erased.',
  }));
  app.get('/me/privacy-requests', { preHandler: [app.requireAuth, app.enforceRateLimit('read')] },
    async (request) => ({ requests: await requests.list(authenticatedUser(request).uid) }));
}
