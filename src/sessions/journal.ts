import { timed } from '../diagnostics/timing.ts';
import { AppError } from '../http/errors.ts';
import type { SessionLease } from './repository.ts';
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { integerField, stringField } from '../support/documents.ts';
import type { SessionEvent } from './events.ts';

const entryId = (sequence: number) => String(sequence).padStart(16, '0');

/** A bounded durable log under the existing session, erased with its project. Redis only wakes readers. */
export class SessionJournal {
  readonly db: Firestore;
  readonly maximum: number;
  readonly retentionSeconds: number;
  constructor(db: Firestore, maximum: number, retentionSeconds: number) { this.db = db; this.maximum = maximum; this.retentionSeconds = retentionSeconds; }

  async append(sessionId: string, type: string, data: Readonly<Record<string, unknown>>, authority?: SessionLease): Promise<SessionEvent> {
    const parent = this.db.doc(`sessions/${sessionId}`);
    return this.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(parent);
      if (!snapshot.exists) throw new Error('Cannot journal an absent session.');
      const fields = snapshot.data() ?? {};
      if (authority !== undefined) {
        const expiresAt = fields['claimableAt'];
        const running = fields['status'] === 'RUNNING' && fields['claimedBy'] === authority.runnerId && fields['leaseToken'] === authority.token
          && expiresAt instanceof Timestamp && expiresAt.toMillis() > Date.now();
        const finished = ['session.idle', 'session.queued', 'session.failed'].includes(type) && fields['lastFinishedLeaseToken'] === authority.token;
        if (authority.sessionId !== sessionId || (!running && !finished)) throw new AppError({
          code: 'session/lease-lost', statusCode: 409, message: 'This worker no longer owns this session event.' });
      }
      const stateEvents: Record<string, string> = { 'session.queued': 'QUEUED', 'session.running': 'RUNNING', 'session.idle': 'IDLE', 'session.failed': 'FAILED' };
      if ((stateEvents[type] !== undefined && fields['status'] !== stateEvents[type]) ||
          (type === 'session.cancel_requested' && fields['cancelRequested'] !== true)) throw new Error('Obsolete session notification.');
      const previous = fields['eventSequence'] === undefined ? 0 : integerField(fields, 'eventSequence', parent.path, { min: 0 });
      const sequence = previous + 1;
      if (!Number.isSafeInteger(sequence)) throw new Error('Session event sequence exhausted.');
      const priorTime = fields['eventTime'] === undefined ? 0 : integerField(fields, 'eventTime', parent.path, { min: 0 });
      const time = Math.max(Date.now(), priorTime);
      const event = { id: `${time}-${sequence}`, type, data };
      tx.create(parent.collection('session_events').doc(entryId(sequence)), { ...event, data: JSON.stringify(data), sequence, expiresAt: Timestamp.fromMillis(time + this.retentionSeconds * 1000) });
      if (sequence > this.maximum) tx.delete(parent.collection('session_events').doc(entryId(sequence - this.maximum)));
      tx.update(parent, { eventSequence: sequence, eventTime: time, eventUpdatedAt: FieldValue.serverTimestamp() });
      return event;
    });
  }

  async assertReady(): Promise<void> {
    await this.db.collectionGroup('session_events').where('expiresAt', '<=', Timestamp.now()).limit(1).get();
  }

  async collectExpired(): Promise<void> {
    const page = await this.db.collectionGroup('session_events').where('expiresAt', '<=', Timestamp.now()).limit(100).get();
    if (page.empty) return;
    await this.db.runTransaction(async (tx) => {
      // Expiry is immutable; events are never updated or reused.
      for (const event of page.docs) tx.delete(event.ref);
    });
  }

  async sequence(sessionId: string, cursor: string): Promise<number | undefined> {
    const sequence = Number(cursor.split('-')[1]);
    if (!Number.isSafeInteger(sequence) || sequence < 1) return undefined;
    const entry = await this.db.doc(`sessions/${sessionId}/session_events/${entryId(sequence)}`).get();
    const fields = entry.data();
    return fields?.['id'] === cursor && fields['expiresAt'] instanceof Timestamp && fields['expiresAt'].toMillis() > Date.now() ? sequence : undefined;
  }

  async *replay(sessionId: string, cursor: string | undefined): AsyncGenerator<SessionEvent> {
    let sequence = cursor === undefined ? undefined : await this.sequence(sessionId, cursor);
    for (let count = 0; count < this.maximum; count++) {
      const collection = this.db.collection(`sessions/${sessionId}/session_events`);
      const query = sequence === undefined ? collection.orderBy('sequence') : collection.orderBy('sequence').startAfter(sequence);
      const page = await timed('events.replay', () => query.limit(1).get());
      const entry = page.docs[0];
      if (entry === undefined) return;
      const fields = entry.data();
      if (!(fields['expiresAt'] instanceof Timestamp)) throw new Error('Event expiry is missing.');
      const expired = fields['expiresAt'].toMillis() <= Date.now();
      const next = integerField(fields, 'sequence', entry.ref.path, { min: 1 });
      if (sequence !== undefined && next !== sequence + 1) throw new Error('Event history was trimmed during replay; reconnect to reconcile.');
      sequence = next;
      if (expired) continue;
      const data: unknown = JSON.parse(stringField(fields, 'data', entry.ref.path));
      if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid durable event data.');
      yield { id: stringField(fields, 'id', entry.ref.path), type: stringField(fields, 'type', entry.ref.path), data: data as Record<string, unknown> };
    }
  }
}
