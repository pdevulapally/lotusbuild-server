import { runnerRecoveryProtocol } from './recovery-protocol.ts';
import {
  type DocumentReference,
  FieldPath,
  FieldValue,
  type Firestore,
  Timestamp,
  type Transaction,
} from 'firebase-admin/firestore';

import type { EntitlementService, UserEntitlements } from '../entitlements/service.ts';
import {
  aiEfforts,
  assertBuildAllowed,
  resolveAiEffort,
  type AiEffort,
} from '../entitlements/build-admission.ts';
import type { ConfigurationStore } from '../entitlements/store.ts';
import { AppError } from '../http/errors.ts';
import { readMutation, writeMutation, type Mutation } from '../http/idempotency.ts';
import type { MeteringService, Reservation } from '../metering/service.ts';
import { randomUUID } from 'node:crypto';

import {
  type Project,
  type ProjectRepository,
  projectSessionActiveError,
  projectSessionGuardUnmigratedError,
} from '../projects/repository.ts';
import type { StoredSnapshot, UploadedSnapshot } from '../storage/snapshots.ts';
import {
  type Fields,
  booleanField,
  enumField,
  integerField,
  optionalStringField,
  optionalTimestampField,
  stringArrayField,
  stringField,
  timestampField,
} from '../support/documents.ts';

export const sessionsCollectionPath = 'sessions';
export const messagesCollectionName = 'messages';
export const queuedMessagesCollectionName = 'queued_messages';
export const sessionModes = ['build', 'plan'] as const;
export type SessionMode = (typeof sessionModes)[number];

/**
 * Recovered from the previous schema. IDLE is not "finished": a session that has
 * answered is waiting for the next thing the user asks, which is what makes a
 * build a conversation rather than a job.
 */
export const buildSessionStatuses = ['QUEUED', 'RUNNING', 'IDLE', 'FAILED'] as const;
export type BuildSessionStatus = (typeof buildSessionStatuses)[number];

function isActiveSessionStatus(status: BuildSessionStatus): status is 'QUEUED' | 'RUNNING' {
  return status === 'QUEUED' || status === 'RUNNING';
}

export const messageRoles = ['user', 'assistant'] as const;
export type MessageRole = (typeof messageRoles)[number];

/**
 * Bounded so one prompt cannot approach Firestore's 1 MiB document ceiling, and
 * so the model's context is not spent on a payload nobody typed by hand.
 */
export const promptMaxLength = 8000;

export interface WorkspaceRecovery {
  readonly protocol?: number;
  readonly status: 'REQUIRED' | 'COMPLETED' | 'UNRECOVERABLE';
  readonly sandboxId: string;
  readonly reason?: string;
}

function workspaceRecovery(fields: Fields, where: string): WorkspaceRecovery | undefined {
  const value = fields['workspaceRecovery'];
  if (value === undefined) return undefined; // Legacy/ordinary resource recovery.
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid recovery state.');
    const record = value as Fields;
    if (Object.keys(record).some((key) => !['protocol', 'status', 'sandboxId', 'reason'].includes(key))
      || (record['protocol'] !== undefined && record['protocol'] !== runnerRecoveryProtocol())) throw new Error('Unsupported recovery protocol.');
    return { status: enumField(record, 'status', where, ['REQUIRED', 'COMPLETED', 'UNRECOVERABLE']),
      sandboxId: stringField(record, 'sandboxId', where),
      ...(record['protocol'] === undefined ? {} : { protocol: runnerRecoveryProtocol() }),
      ...(record['reason'] === undefined ? {} : { reason: stringField(record, 'reason', where) }) };
  } catch {
    throw new AppError({ code: 'session/recovery-protocol-incompatible', statusCode: 503, message: 'Workspace recovery metadata is invalid or unsupported. Execution is blocked.' });
  }
}

export interface BuildSession {
  readonly id: string;
  readonly projectId: string;
  readonly ownerUid: string;
  readonly status: BuildSessionStatus;
  readonly model: string;
  readonly effort: AiEffort;
  readonly mode: SessionMode;
  readonly sandboxId: string | undefined;
  readonly claimedBy: string | undefined;
  readonly leaseToken: string | undefined;
  readonly heartbeatAt: Date | undefined;
  readonly error: string | undefined;
  readonly cancelRequested?: boolean | undefined;
  readonly workspaceRecovery?: WorkspaceRecovery | undefined;
  /** A late follow-up has not yet been appended or charged as a new turn. */
  readonly queuedTurnPending?: boolean | undefined;
  /** Latest accepted steering instruction, consumed under the runner lease. */
  readonly pendingSteer?: string | undefined;
  /**
   * Meter holds the claiming runner took out. Recorded on the session so that
   * whoever inherits an expired lease can give them back: a hold nobody returns
   * is a concurrency slot the user never gets to use again. An unrecoverable
   * terminal session may retain these references for independent accounting.
   */
  readonly reservationIds: readonly string[];
  /**
   * Open specialist token holds this session has taken out.
   *
   * Recorded before the model call they pay for and cleared only once the hold
   * has reached a terminal accounting outcome, so a runner that dies mid-review
   * leaves the hold findable by whoever inherits the session. Absent on a
   * document written before specialists existed, which is the same thing as
   * none: such a session cannot have consulted anyone.
   */
  readonly specialistReservationIds: readonly string[];
  readonly messageCount: number;
  readonly createdAt: Date;
}

export interface ClaimedSession extends BuildSession {
  readonly status: 'RUNNING';
  readonly claimedBy: string;
  readonly leaseToken: string;
}

export interface SessionLease {
  readonly sessionId: string;
  readonly runnerId: string;
  readonly token: string;
}

export interface SessionMessage {
  readonly seq: number;
  readonly role: MessageRole;
  readonly content: string;
  readonly createdAt: Date;
}

export interface QueuedMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly prompt: string;
  readonly createdAt: Date;
}

/**
 * Messages are ordered by document id, which costs nothing: Firestore indexes
 * ids automatically, so a fixed-width sequence number sorts correctly without a
 * composite index and without a `seq` field to keep consistent with the id.
 */
const messageIdWidth = 6;

function messageId(seq: number): string {
  const id = String(seq).padStart(messageIdWidth, '0');
  if (id.length > messageIdWidth) {
    throw new Error(`Session message ${seq} exceeds the ${messageIdWidth}-digit ordering width.`);
  }
  return id;
}

function parseSession(id: string, fields: Fields, where: string): BuildSession {
  return {
    id,
    projectId: stringField(fields, 'projectId', where),
    ownerUid: stringField(fields, 'ownerUid', where),
    status: enumField(fields, 'status', where, buildSessionStatuses),
    model: stringField(fields, 'model', where),
    effort: enumField(fields, 'effort', where, aiEfforts),
    mode: fields['mode'] === undefined ? 'build' : enumField(fields, 'mode', where, sessionModes),
    sandboxId: optionalStringField(fields, 'sandboxId'),
    claimedBy: optionalStringField(fields, 'claimedBy'),
    leaseToken: optionalStringField(fields, 'leaseToken'),
    heartbeatAt: optionalTimestampField(fields, 'heartbeatAt', where),
    error: optionalStringField(fields, 'error'),
    cancelRequested: fields['cancelRequested'] === true ? true : undefined,
    workspaceRecovery: workspaceRecovery(fields, where),
    queuedTurnPending: fields['queuedTurnPending'] === undefined ? undefined : booleanField(fields, 'queuedTurnPending', where),
    pendingSteer: fields['pendingSteer'] === undefined ? undefined : stringField(fields, 'pendingSteer', where),
    reservationIds: stringArrayField(fields, 'reservationIds', where),
    specialistReservationIds: stringArrayField(fields, 'specialistReservationIds', where),
    messageCount: integerField(fields, 'messageCount', where, { min: 1 }),
    createdAt: timestampField(fields, 'createdAt', where),
  };
}

function parseMessage(id: string, fields: Fields, where: string): SessionMessage {
  return {
    seq: Number(id),
    role: enumField(fields, 'role', where, messageRoles),
    content: stringField(fields, 'content', where),
    createdAt: timestampField(fields, 'createdAt', where),
  };
}

function parseQueuedMessage(id: string, sessionId: string, fields: Fields, where: string): QueuedMessage {
  return {
    id,
    sessionId,
    prompt: stringField(fields, 'prompt', where),
    createdAt: timestampField(fields, 'createdAt', where),
  };
}


export interface NewSession {
  readonly prompt: string;
  readonly model: string;
  readonly effort?: AiEffort;
  readonly mode?: SessionMode;
}

/** What a runner reports when it stops working on a session. */
export type SessionOutcome =
  | { readonly status: 'IDLE' }
  | { readonly status: 'FAILED'; readonly error: string };

export class SessionRepository {
  readonly #firestore: Firestore;
  readonly #projects: ProjectRepository;
  readonly #entitlements: EntitlementService;
  readonly #configuration: ConfigurationStore;
  readonly #metering: MeteringService;
  readonly #leaseSeconds: number;

  constructor(
    firestore: Firestore,
    projects: ProjectRepository,
    entitlements: EntitlementService,
    configuration: ConfigurationStore,
    metering: MeteringService,
    leaseSeconds: number,
  ) {
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds <= 0) {
      throw new Error(`The session lease must be a positive number of seconds, got ${leaseSeconds}.`);
    }
    this.#firestore = firestore;
    this.#projects = projects;
    this.#entitlements = entitlements;
    this.#configuration = configuration;
    this.#metering = metering;
    this.#leaseSeconds = leaseSeconds;
  }

  #ref(sessionId: string) {
    return this.#firestore.doc(`${sessionsCollectionPath}/${sessionId}`);
  }

  #leaseExpiry(now: Date): Timestamp {
    return Timestamp.fromMillis(now.getTime() + this.#leaseSeconds * 1000);
  }

  #assertProjectGuard(project: Project, session: BuildSession): void {
    if (project.activeSessionId !== session.id) {
      throw new AppError({
        code: 'session/project-guard-lost',
        statusCode: 409,
        message: 'This session no longer owns the project workspace.',
        details: {
          sessionId: session.id,
          projectId: session.projectId,
          status: session.status,
        },
      });
    }
  }

  #assertProjectCanActivate(project: Project, sessionId?: string): void {
    if (project.activeSessionId === undefined) {
      throw projectSessionGuardUnmigratedError();
    }
    if (project.activeSessionId !== null) {
      if (sessionId !== undefined && project.activeSessionId === sessionId) {
        throw new AppError({
          code: 'session/project-state-inconsistent',
          statusCode: 409,
          message: 'This session and its project are in an inconsistent state.',
          details: { sessionId, projectId: project.id },
        });
      }
      throw projectSessionActiveError();
    }
  }

  /**
   * Starts a session against a project the caller owns.
   *
   * Every gate is re-checked here even though the project passed them at
   * creation: a plan can be downgraded, and a mobile project created on pro must
   * not keep building after the subscription lapses.
   */
  async create(uid: string, projectId: string, input: NewSession, idempotencyId?: string, operation?: Mutation<BuildSession>): Promise<BuildSession> {
    this.#validatePrompt(input.prompt);
    if (idempotencyId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(idempotencyId)) throw new Error('Invalid internal session id.');
    const project = await this.#projects.readOwned(uid, projectId);
    const entitlements = await this.#entitlements.forUser(uid);

    assertBuildAllowed(entitlements, project.platform, input.model);

    const effort = resolveAiEffort(entitlements, input.effort);
    const mode = input.mode ?? 'build';
    const { registry } = await this.#configuration.get();

    const now = new Date();
    const collection = this.#firestore.collection(sessionsCollectionPath);
    const ref = idempotencyId === undefined ? collection.doc() : collection.doc(idempotencyId);
    const firstMessage = ref.collection(messagesCollectionName).doc(messageId(0));
    const result: BuildSession = {
      id: ref.id, projectId: project.id, ownerUid: uid, status: 'QUEUED',
      model: input.model, effort, mode, sandboxId: undefined, claimedBy: undefined,
      leaseToken: undefined, heartbeatAt: undefined, error: undefined,
      reservationIds: [], specialistReservationIds: [], messageCount: 1, createdAt: now,
    };

    const existing = await this.#firestore.runTransaction(async (transaction) => {
      if (idempotencyId !== undefined) {
        const prior = await transaction.get(ref);
        if (prior.exists) {
          const parsed = parseSession(prior.id, prior.data() ?? {}, ref.path);
          if (parsed.ownerUid !== uid || parsed.projectId !== projectId) throw new Error('Idempotent session scope disagrees.');
          return parsed;
        }
      }
      const currentProject = await this.#projects.readOwnedInTransaction(transaction, uid, project.id);
      await readMutation(transaction, this.#firestore, operation);
      this.#assertProjectCanActivate(currentProject);

      await this.#metering.consumeIn(transaction, {
        uid,
        entitlements,
        meterKey: registry.buildMeterKey,
        quantity: 1,
        now,
      });

      transaction.create(ref, {
        projectId: project.id,
        ownerUid: uid,
        status: 'QUEUED',
        model: input.model,
        effort,
        mode,
        messageCount: 1,
        // The single field a runner queries on. See `claim`.
        claimableAt: Timestamp.fromDate(now),
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      transaction.create(firstMessage, {
        role: 'user',
        content: input.prompt,
        createdAt: FieldValue.serverTimestamp(),
      });
      transaction.update(this.#projects.refFor(project.id), {
        activeSessionId: ref.id,
        updatedAt: FieldValue.serverTimestamp(),
      });
      writeMutation(transaction, this.#firestore, operation, result);
    });

    if (existing !== undefined) return existing;

    return result;
  }

  /** A session owned by someone else is reported as missing, as projects are. */
  async readOwned(ownerUid: string, sessionId: string): Promise<BuildSession> {
    const ref = this.#ref(sessionId);
    const snapshot = await ref.get();

    const missing = new AppError({
      code: 'session/not-found',
      statusCode: 404,
      message: 'No such session.',
    });

    if (!snapshot.exists) {
      throw missing;
    }
    const session = parseSession(snapshot.id, snapshot.data() ?? {}, ref.path);
    if (session.ownerUid !== ownerUid) {
      throw missing;
    }
    await this.#projects.readOwned(ownerUid, session.projectId);
    return session;
  }

  async listForProject(
    ownerUid: string,
    projectId: string,
    limit: number,
  ): Promise<readonly BuildSession[]> {
    // Ownership of the project is what grants sight of its sessions, so it is
    // proven before the query rather than filtered afterwards.
    const project = await this.#projects.readOwned(ownerUid, projectId);

    const snapshot = await this.#firestore
      .collection(sessionsCollectionPath)
      .where('projectId', '==', project.id)
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();

    return snapshot.docs.map((doc) => parseSession(doc.id, doc.data(), doc.ref.path));
  }

  /**
   * The most recent `limit` messages, in chronological order.
   *
   * Every caller — the primary agent's context and the message-history route
   * alike — wants the current state of the conversation, not a window fixed
   * at its beginning. `orderBy(..., 'desc')` bounds the query to the newest
   * `limit` documents before anything is fetched, so a long session is never
   * read past that; the result is reversed only after it comes back, which
   * reorders at most `limit` items, never the collection.
   */
  async listMessages(
    ownerUid: string,
    sessionId: string,
    limit: number,
  ): Promise<readonly SessionMessage[]> {
    const session = await this.readOwned(ownerUid, sessionId);
    const snapshot = await this.#ref(session.id)
      .collection(messagesCollectionName)
      .orderBy(FieldPath.documentId(), 'desc')
      .limit(limit)
      .get();

    return snapshot.docs.map((doc) => parseMessage(doc.id, doc.data(), doc.ref.path)).reverse();
  }

  /**
   * Adds the user's next turn and puts the session back in the queue.
   *
   * Refused while a runner holds it: a prompt arriving mid-build would either be
   * silently dropped or race the agent's own message into the transcript, and
   * neither is something the user can see happening.
   */
  async appendPrompt(uid: string, sessionId: string, prompt: string, operation?: Mutation<BuildSession>): Promise<BuildSession> {
    this.#validatePrompt(prompt);
    const session = await this.readOwned(uid, sessionId);
    const entitlements = await this.#entitlements.forUser(uid);
    const { registry } = await this.#configuration.get();
    const now = new Date();
    const ref = this.#ref(session.id);

    return this.#firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) {
        throw new AppError({
          code: 'session/not-found',
          statusCode: 404,
          message: 'No such session.',
        });
      }
      const current = parseSession(snapshot.id, snapshot.data() ?? {}, ref.path);
      if (current.ownerUid !== uid) {
        throw new AppError({
          code: 'session/not-found',
          statusCode: 404,
          message: 'No such session.',
        });
      }
      const project = await this.#projects.readOwnedInTransaction(transaction, uid, current.projectId);
      await readMutation(transaction, this.#firestore, operation);
      this.#assertPromptRecoveryEligible(current);
      if (current.status === 'QUEUED' || current.status === 'RUNNING') {
        throw new AppError({
          code: 'session/busy',
          statusCode: 409,
          message: 'This session is still working. Wait for it to finish before sending more.',
          details: { status: current.status },
        });
      }

      this.#assertProjectCanActivate(project, current.id);
      assertBuildAllowed(entitlements, project.platform, current.model);

      // A follow-up turn is another build, and is charged as one.
      await this.#metering.consumeIn(transaction, {
        uid,
        entitlements,
        meterKey: registry.buildMeterKey,
        quantity: 1,
        now,
      });

      const seq = current.messageCount;
      transaction.create(ref.collection(messagesCollectionName).doc(messageId(seq)), {
        role: 'user',
        content: prompt,
        createdAt: FieldValue.serverTimestamp(),
      });
      transaction.update(ref, {
        status: 'QUEUED',
        messageCount: FieldValue.increment(1),
        claimableAt: Timestamp.fromDate(now),
        cancelRequested: FieldValue.delete(),
        error: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      transaction.update(this.#projects.refFor(current.projectId), {
        activeSessionId: current.id,
        updatedAt: FieldValue.serverTimestamp(),
      });

      const result = { ...current, status: 'QUEUED' as const, error: undefined, cancelRequested: undefined, messageCount: seq + 1 };
      writeMutation(transaction, this.#firestore, operation, result);
      return result;
    });
  }

  /**
   * Staging a prompt in the session queue while a turn is active.
   */
  async enqueueMessage(uid: string, sessionId: string, prompt: string, operation?: Mutation<QueuedMessage>): Promise<QueuedMessage> {
    this.#validatePrompt(prompt);
    const entitlements = await this.#entitlements.forUser(uid);
    const limit = await this.#queueLimit(entitlements);
    const parent = this.#ref(sessionId);
    const ref = parent.collection(queuedMessagesCollectionName).doc();
    const result = { id: ref.id, sessionId, prompt, createdAt: new Date() };
    await this.#firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(parent);
      if (!snapshot.exists || snapshot.data()?.['ownerUid'] !== uid) {
        throw new AppError({ code: 'session/not-found', statusCode: 404, message: 'No such session.' });
      }
      const session = parseSession(snapshot.id, snapshot.data() ?? {}, parent.path);
      const project = await this.#projects.readOwnedInTransaction(transaction, uid, session.projectId);
      await readMutation(transaction, this.#firestore, operation);
      this.#assertPromptRecoveryEligible(session);
      if (!isActiveSessionStatus(session.status) || session.cancelRequested === true) {
        throw new AppError({ code: 'session/not-active', statusCode: 409, message: 'This session is no longer accepting queued messages.' });
      }
      this.#assertProjectGuard(project, session);
      assertBuildAllowed(entitlements, project.platform, session.model);
      const queued = await transaction.get(parent.collection(queuedMessagesCollectionName).limit(limit + 1));
      if (queued.size >= limit) {
        throw new AppError({ code: 'session/queue-full', statusCode: 429, message: 'The session message queue is full.' });
      }
      transaction.create(ref, { prompt, createdAt: FieldValue.serverTimestamp() });
      // Enqueue and deletion/dequeue share this parent conflict boundary.
      transaction.update(parent, { updatedAt: FieldValue.serverTimestamp() });
      writeMutation(transaction, this.#firestore, operation, result);
    });
    return result;
  }

  // There is no reason to stage more builds than the plan permits in a whole
  // billing window. Reuse that configured bound rather than invent a new plan rule.
  async #queueLimit(entitlements: UserEntitlements): Promise<number> {
    const { registry } = await this.#configuration.get();
    const limit = entitlements.meterLimits.get(registry.buildMeterKey);
    if (limit === undefined) throw new Error('The build meter limit is missing.');
    return limit.hardLimit;
  }

  async listQueuedMessages(uid: string, sessionId: string, limit = 100, after?: string): Promise<readonly QueuedMessage[]> {
    const session = await this.readOwned(uid, sessionId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid queue page size.');
    let query = this.#ref(session.id).collection(queuedMessagesCollectionName)
      .orderBy('createdAt', 'asc').orderBy(FieldPath.documentId(), 'asc');
    if (after !== undefined) {
      const cursor = await this.#ref(session.id).collection(queuedMessagesCollectionName).doc(after).get();
      if (!cursor.exists) throw new AppError({ code: 'session/cursor-missing', statusCode: 400, message: 'Queue cursor no longer exists; restart pagination.' });
      query = query.startAfter(cursor);
    }
    const snapshot = await query.limit(limit).get();
    return snapshot.docs.map((doc) => parseQueuedMessage(doc.id, session.id, doc.data(), doc.ref.path));
  }

  /**
   * Deletes a queued message from the session queue.
   */
  async deleteQueuedMessage(uid: string, sessionId: string, queuedMessageId: string): Promise<void> {
    const session = await this.readOwned(uid, sessionId);
    const ref = this.#ref(session.id)
      .collection(queuedMessagesCollectionName)
      .doc(queuedMessageId);

    const snapshot = await ref.get();
    if (!snapshot.exists) {
      throw new AppError({
        code: 'session/queued-message-not-found',
        statusCode: 404,
        message: 'No such queued message.',
      });
    }

    await ref.delete();
  }

  /**
   * Dequeues the next message in the queue under the runner's lease,
   * charges the build quota, and appends it to the messages collection.
   */
  async dequeueNextMessage(sessionId: string, authority: SessionLease, signal?: AbortSignal): Promise<QueuedMessage | undefined> {
    signal?.throwIfAborted();
    const ref = this.#ref(sessionId);
    const now = new Date();
    return this.#firestore.runTransaction(async (transaction) => {
      const session = await this.#requireLease(transaction, ref, authority);
      const queuedSnapshot = await transaction.get(ref.collection(queuedMessagesCollectionName)
        .orderBy('createdAt', 'asc').limit(1));
      const nextDoc = queuedSnapshot.docs[0];
      if (nextDoc === undefined) return undefined;
      const nextData = parseQueuedMessage(nextDoc.id, sessionId, nextDoc.data(), nextDoc.ref.path);
      const entitlements = await this.#entitlements.forUser(session.ownerUid);
      const { registry } = await this.#configuration.get();
      const project = await this.#projects.readOwnedInTransaction(transaction, session.ownerUid, session.projectId);
      assertBuildAllowed(entitlements, project.platform, session.model);

      // Deduct build meter for this turn
      await this.#metering.consumeIn(transaction, {
        uid: session.ownerUid,
        entitlements,
        meterKey: registry.buildMeterKey,
        quantity: 1,
        now,
      });

      const seq = session.messageCount;
      signal?.throwIfAborted();
      transaction.create(ref.collection(messagesCollectionName).doc(messageId(seq)), {
        role: 'user',
        content: nextData.prompt,
        createdAt: FieldValue.serverTimestamp(),
      });
      transaction.delete(nextDoc.ref);
      transaction.update(ref, {
        messageCount: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return nextData;
    });
  }

  #assertPromptRecoveryEligible(session: BuildSession): void {
    if (session.workspaceRecovery?.status === 'UNRECOVERABLE') {
      throw new AppError({
        code: 'session/workspace-unrecoverable',
        statusCode: 409,
        message: 'The latest unsaved workspace state could not be recovered. This session cannot accept new work.',
      });
    }
  }

  #validatePrompt(prompt: string): void {
    if (prompt.trim() === '' || prompt.length > promptMaxLength) {
      throw new AppError({ code: 'session/invalid-prompt', statusCode: 400, message: 'Prompt must contain text within the permitted length.' });
    }
  }

  /** Redis is only a notification: acceptance commits before the API acknowledges. */
  async queueSteerMessage(uid: string, sessionId: string, prompt: string, operation?: Mutation<void>): Promise<void> {
    this.#validatePrompt(prompt);
    const entitlements = await this.#entitlements.forUser(uid);
    const ref = this.#ref(sessionId);
    await this.#firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists || snapshot.data()?.['ownerUid'] !== uid) {
        throw new AppError({ code: 'session/not-found', statusCode: 404, message: 'No such session.' });
      }
      const session = parseSession(snapshot.id, snapshot.data() ?? {}, ref.path);
      const project = await this.#projects.readOwnedInTransaction(transaction, uid, session.projectId);
      await readMutation(transaction, this.#firestore, operation);
      this.#assertPromptRecoveryEligible(session);
      if (session.status !== 'RUNNING' || session.cancelRequested === true) {
        throw new AppError({ code: 'session/not-running', statusCode: 409, message: 'This session is no longer accepting steering instructions.' });
      }
      this.#assertProjectGuard(project, session);
      assertBuildAllowed(entitlements, project.platform, session.model);
      transaction.update(ref, { pendingSteer: prompt, updatedAt: FieldValue.serverTimestamp() });
      writeMutation(transaction, this.#firestore, operation, undefined);
    });
  }

  /** Consume the latest steering instruction and persist its conversation position atomically. */
  async drainSteerMessage(sessionId: string, authority: SessionLease): Promise<string | undefined> {
    const ref = this.#ref(sessionId);
    return this.#firestore.runTransaction(async (transaction) => {
      const session = await this.#requireLease(transaction, ref, authority);
      const prompt = session.pendingSteer;
      if (prompt === undefined) return undefined;
      const seq = session.messageCount;
      transaction.create(ref.collection(messagesCollectionName).doc(messageId(seq)), {
        role: 'user',
        content: prompt,
        createdAt: FieldValue.serverTimestamp(),
      });
      transaction.update(ref, {
        pendingSteer: FieldValue.delete(),
        messageCount: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return prompt;
    });
  }

  /** Start work accepted during finalization, after claiming and recovering old resources. */
  async startPendingTurn(sessionId: string, authority: SessionLease, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    const ref = this.#ref(sessionId);
    return this.#firestore.runTransaction(async (transaction) => {
      const session = await this.#requireLease(transaction, ref, authority);
      if (session.queuedTurnPending !== true) throw new Error('Session has no pending turn to start.');
      const queued = await transaction.get(ref.collection(queuedMessagesCollectionName).orderBy('createdAt', 'asc').limit(1));
      const next = queued.docs[0];
      const prompt = session.pendingSteer ?? (next === undefined ? undefined : parseQueuedMessage(next.id, sessionId, next.data(), next.ref.path).prompt);
      if (prompt === undefined) return false; // The owner removed the last queued message.
      const entitlements = await this.#entitlements.forUser(session.ownerUid);
      const project = await this.#projects.readOwnedInTransaction(transaction, session.ownerUid, session.projectId);
      assertBuildAllowed(entitlements, project.platform, session.model);
      if (session.pendingSteer === undefined) {
        if (next === undefined) throw new Error('Pending message disappeared inside the transaction.');
        const { registry } = await this.#configuration.get();
        await this.#metering.consumeIn(transaction, { uid: session.ownerUid, entitlements,
          meterKey: registry.buildMeterKey, quantity: 1, now: new Date() });
        transaction.delete(next.ref);
      }
      signal?.throwIfAborted();
      transaction.create(ref.collection(messagesCollectionName).doc(messageId(session.messageCount)), {
        role: 'user', content: prompt, createdAt: FieldValue.serverTimestamp(),
      });
      transaction.update(ref, { queuedTurnPending: FieldValue.delete(), pendingSteer: FieldValue.delete(),
        messageCount: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() });
      return true;
    });
  }

  /**
   * Cancels a queued or running session.

   *
   * If the session is QUEUED, it is immediately marked FAILED with 'Cancelled by user',
   * claimableAt is deleted so no runner will claim it. A prepaid turn is refunded;
   * late follow-ups awaiting admission have no new charge to refund.
   * If the session is RUNNING, cancelRequested is set to true so the active runner halts on its
   * next step, tears down resources, and transitions the session to FAILED.
   */
  async cancel(uid: string, sessionId: string, operation?: Mutation<BuildSession>): Promise<BuildSession> {
    const session = await this.readOwned(uid, sessionId);
    const entitlements = await this.#entitlements.forUser(uid);
    const { registry } = await this.#configuration.get();
    const ref = this.#ref(sessionId);
    const now = new Date();

    return this.#firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) {
        throw new AppError({
          code: 'session/not-found',
          statusCode: 404,
          message: 'No such session.',
        });
      }
      const current = parseSession(snapshot.id, snapshot.data() ?? {}, ref.path);
      if (current.ownerUid !== uid) {
        throw new AppError({
          code: 'session/not-found',
          statusCode: 404,
          message: 'No such session.',
        });
      }

      const project = await this.#projects.readOwnedInTransaction(transaction, uid, current.projectId, true);
      await readMutation(transaction, this.#firestore, operation);
      if (current.status === 'IDLE' || current.status === 'FAILED') {
        throw new AppError({
          code: 'session/not-cancellable',
          statusCode: 409,
          message: `Cannot cancel a session that is already ${current.status}.`,
          details: { status: current.status },
        });
      }


      this.#assertProjectGuard(project, current);

      if (current.status === 'QUEUED') {
        if (current.queuedTurnPending !== true) await this.#metering.refundIn(transaction, {
          uid,
          entitlements,
          meterKey: registry.buildMeterKey,
          quantity: 1,
          chargedAt: timestampField(snapshot.data() ?? {}, 'claimableAt', ref.path),
          now,
        });

        transaction.update(ref, {
          status: 'FAILED',
          error: 'Cancelled by user',
          leaseToken: FieldValue.delete(),
          claimableAt: FieldValue.delete(),
          queuedTurnPending: FieldValue.delete(),
          pendingSteer: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        transaction.update(this.#projects.refFor(current.projectId), {
          activeSessionId: null,
          updatedAt: FieldValue.serverTimestamp(),
        });

        const result = {
          ...current,
          status: 'FAILED' as const,
          error: 'Cancelled by user',
          cancelRequested: undefined,
        };
        writeMutation(transaction, this.#firestore, operation, result);
        return result;
      }

      transaction.update(ref, {
        cancelRequested: true,
        updatedAt: FieldValue.serverTimestamp(),
      });

      const result = {
        ...current,
        cancelRequested: true,
      };
      writeMutation(transaction, this.#firestore, operation, result);
      return result;
    });
  }

  /**
   * Takes the session that has been waiting longest, if there is one.

   *
   * `claimableAt` is the whole scheduler. Queued sessions carry the instant they
   * were queued; a running session carries the instant its lease expires, so a
   * runner that dies is picked up by the next one without a reaper watching for
   * corpses. A finished session has the field removed, and Firestore excludes
   * documents missing a field from a range query — so one automatic single-field
   * index answers "what should I work on", with no composite index to create and
   * no second query for stale leases.
   *
   * Redis is deliberately not the queue. It can be lost, and a queue that can be
   * lost is a build the user paid for that never runs.
   *
   * Every write of `claimableAt` uses the writer's own clock, never a server
   * timestamp. Mixing the two makes the field incomparable with itself: a
   * session queued at the server's instant but leased against the caller's
   * would be invisible or claimable early by however far the two clocks differ.
   * One clock domain, and skew between machines is absorbed by the lease being
   * far longer than any skew NTP allows.
   */
  async claim(runnerId: string, now: Date = new Date(), signal?: AbortSignal): Promise<ClaimedSession | undefined> {
    signal?.throwIfAborted();
    const candidates = await this.#firestore
      .collection(sessionsCollectionPath)
      .where('claimableAt', '<=', Timestamp.fromDate(now))
      .orderBy('claimableAt', 'asc')
      .limit(1)
      .get();

    const candidate = candidates.docs[0];
    if (candidate === undefined) {
      return undefined;
    }
    const ref = candidate.ref;
    const leaseToken = randomUUID();

    return this.#firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) {
        return undefined;
      }
      const fields = snapshot.data() ?? {};
      const claimableAt = optionalTimestampField(fields, 'claimableAt', ref.path);
      // Another runner won the race between the query and this transaction.
      if (claimableAt === undefined || claimableAt.getTime() > now.getTime()) {
        return undefined;
      }

      // Returned as it was found, holds included: the caller inherits the mess.
      const session = parseSession(snapshot.id, fields, ref.path);
      if (!isActiveSessionStatus(session.status)) {
        throw new AppError({
          code: 'session/project-state-inconsistent',
          statusCode: 409,
          message: 'This queued session is in an inconsistent state.',
          details: { sessionId: session.id, projectId: session.projectId, status: session.status },
        });
      }
      let project: Project;
      try {
        project = await this.#projects.readOwnedInTransaction(transaction, session.ownerUid, session.projectId, session.status === 'RUNNING');
      } catch (error) {
        if (session.workspaceRecovery?.status !== 'REQUIRED' || !(error instanceof AppError)
          || !['project/not-found', 'project/deleting'].includes(error.code)) throw error;
        // No publication lease is granted when destructive user intent revoked
        // project access. The existing erasure/deletion workflow owns disposal.
        transaction.update(ref, { workspaceRecovery: { ...session.workspaceRecovery, status: 'UNRECOVERABLE', reason: 'persistence-revoked' },
          error: 'Workspace recovery is unrecoverable: persistence-revoked', updatedAt: FieldValue.serverTimestamp() });
        return undefined;
      }
      this.#assertProjectGuard(project, session);
      signal?.throwIfAborted();
      transaction.update(ref, {
        status: 'RUNNING',
        claimedBy: runnerId,
        leaseToken,
        heartbeatAt: Timestamp.fromDate(now),
        claimableAt: this.#leaseExpiry(now),
        error: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      return {
        ...session,
        status: 'RUNNING' as const,
        claimedBy: runnerId,
        leaseToken,
        heartbeatAt: now,
        error: undefined,
      };
    });
  }

  async assertPersistenceLease(authority: SessionLease, cleanup = false): Promise<void> {
    const ref = this.#ref(authority.sessionId);
    await this.#firestore.runTransaction(async (transaction) => {
      await this.#requirePersistenceLease(transaction, ref, authority, cleanup);
    });
  }

  async reserveSnapshotUpload(authority: SessionLease, entitlements: UserEntitlements,
    input: { id: string; objectName: string; bytes: number; expiresAt: Date }, cleanup = false): Promise<void> {
    const { registry } = await this.#configuration.get();
    await this.#firestore.runTransaction(async (transaction) => {
      const { session, project } = await this.#requirePersistenceLease(transaction, this.#ref(authority.sessionId), authority, cleanup);
      if (input.objectName !== `projects/${project.id}/snapshots/${input.id}.tar.gz` || input.expiresAt.getTime() <= Date.now()) {
        throw new Error('Invalid snapshot upload admission.');
      }
      const reservation = await this.#metering.reserveIn(transaction, { uid: session.ownerUid, entitlements,
        meterKey: registry.storageMeterKey, quantity: input.bytes, operationId: `snapshot:${input.id}`, now: new Date() });
      transaction.create(this.#firestore.doc(`snapshotUploads/${input.id}`), {
        ownerUid: session.ownerUid, projectId: project.id, leaseToken: authority.token,
        objectName: input.objectName, bytes: input.bytes, expiresAt: Timestamp.fromDate(input.expiresAt),
        status: 'CANDIDATE', reservationId: reservation.id, createdAt: FieldValue.serverTimestamp(),
      });
    });
  }

  async publishSnapshot(
    authority: SessionLease,
    entitlements: UserEntitlements,
    snapshot: UploadedSnapshot,
    uploadId: string,
    cleanup = false,
  ): Promise<{ readonly projectId: string; readonly previous: StoredSnapshot }> {
    const { registry } = await this.#configuration.get();
    const ref = this.#ref(authority.sessionId);

    return this.#firestore.runTransaction(async (transaction) => {
      const { session, project } = await this.#requirePersistenceLease(
        transaction,
        ref,
        authority,
        cleanup,
      );
      const uploadRef = this.#firestore.doc(`snapshotUploads/${uploadId}`);
      const upload = await transaction.get(uploadRef);
      const fields = upload.data() ?? {};
      if (fields['status'] !== 'CANDIDATE' || fields['leaseToken'] !== authority.token
        || fields['objectName'] !== snapshot.objectName || fields['bytes'] !== snapshot.bytes
        || timestampField(fields, 'expiresAt', uploadRef.path).getTime() <= Date.now()) {
        throw new Error('Snapshot does not match its live upload admission.');
      }
      await this.#metering.commitStorageIn(transaction, session.ownerUid,
        stringField(fields, 'reservationId', uploadRef.path), snapshot.bytes);
      transaction.update(uploadRef, { status: 'CURRENT', generation: snapshot.generation });
      if (project.snapshotUploadId !== undefined) {
        transaction.update(this.#firestore.doc(`snapshotUploads/${project.snapshotUploadId}`), { status: 'OBSOLETE' });
      } else if (project.snapshot.kind !== 'none') {
        transaction.create(this.#firestore.collection('snapshotUploads').doc(), {
          ownerUid: session.ownerUid, projectId: project.id, bytes: project.snapshotBytes,
          status: 'OBSOLETE', expiresAt: Timestamp.fromMillis(0), legacy: project.snapshot.kind === 'legacy',
          ...(project.snapshot.kind === 'immutable' ? { objectName: project.snapshot.objectName, generation: project.snapshot.generation } : {}),
        });
      }
      transaction.update(this.#projects.refFor(project.id), {
        snapshotBytes: snapshot.bytes,
        snapshotObjectName: snapshot.objectName,
        snapshotObjectGeneration: snapshot.generation,
        snapshotUploadId: uploadId,
        snapshotUpdatedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      // Publication and salvage completion are one commit: a lost acknowledgement
      // cannot leave a published workspace looking like an unsaved orphan.
      if (session.workspaceRecovery?.status === 'REQUIRED') {
        if (session.workspaceRecovery.sandboxId !== session.sandboxId) throw new Error('Workspace recovery identity mismatch.');
        transaction.update(ref, { workspaceRecovery: { ...session.workspaceRecovery, status: 'COMPLETED' } });
      }
      return { projectId: project.id, previous: project.snapshot };
    });
  }

  /**
   * Extends the lease. Throwing when the lease is gone is the point: a runner
   * whose session was taken while it was busy must stop, or two runners write
   * the same transcript.
   */
  async heartbeat(sessionId: string, authority: SessionLease, now: Date = new Date(), cleanup = false): Promise<void> {
    await this.#withLease(sessionId, authority, (transaction, ref) => {
      transaction.update(ref, {
        heartbeatAt: Timestamp.fromDate(now),
        claimableAt: this.#leaseExpiry(now),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }, cleanup);
  }

  /**
   * Records what the runner is now holding, so a successor can clean it up.
   *
   * Written before the sandbox is used rather than after, because the window
   * that matters is the one where a runner dies mid-build: an unrecorded
   * sandbox keeps running and an unrecorded hold is never given back.
   */
  async attachSandbox(
    sessionId: string,
    authority: SessionLease,
    held: { readonly sandboxId: string; readonly reservationIds: readonly string[] },
  ): Promise<void> {
    await this.#withLease(sessionId, authority, (transaction, ref, session) => {
      if (session.workspaceRecovery?.status === 'REQUIRED') throw new Error('Unsaved workspace must be recovered before replacement.');
      transaction.update(ref, {
        sandboxId: held.sandboxId,
        reservationIds: [...held.reservationIds],
        workspaceRecovery: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
  }

  /**
   * Adds what the agent said to the transcript, under the runner's lease.
   *
   * Separate from `appendPrompt` because the rules are opposite: a user may only
   * speak when the session is idle, and a runner may only speak while it holds
   * it. Sharing one method would mean a check that means different things to
   * different callers.
   */
  async appendAssistantMessage(
    sessionId: string,
    authority: SessionLease,
    content: string,
  ): Promise<void> {
    const ref = this.#ref(sessionId);
    await this.#firestore.runTransaction(async (transaction) => {
      const session = await this.#requireLease(transaction, ref, authority);
      transaction.create(
        ref.collection(messagesCollectionName).doc(messageId(session.messageCount)),
        { role: 'assistant', content, createdAt: FieldValue.serverTimestamp() },
      );
      transaction.update(ref, {
        messageCount: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
  }

  /**
   * Takes a specialist token hold and records it on the session, in one commit.
   *
   * The two used to be separate transactions, which left a window where a hold
   * existed and nothing pointed at it: a process that died in between stranded
   * capacity nobody could find. Here the usage decrement, the reservation
   * document and the session pointer are one atomic write, so a hold that is
   * spendable is always a hold that is recoverable.
   *
   * The lease is validated inside the same transaction, so a runner that has
   * already lost the session cannot take a hold against it at all.
   */
  async reserveSpecialistTokens(
    sessionId: string,
    runnerId: string,
    input: {
      readonly leaseToken: string;
      readonly entitlements: UserEntitlements;
      readonly meterKey: string;
      readonly quantity: number;
      readonly operationId: string;
      readonly now: Date;
    },
  ): Promise<Reservation> {
    const ref = this.#ref(sessionId);
    return this.#firestore.runTransaction(async (transaction) => {
      // Reads first, and all of them: the lease and project guard, then the
      // usage document inside reserveIn. Firestore forbids reading after
      // writing, so nothing may be written before this point.
      const { session, project } = await this.#requirePersistenceLease(transaction, ref,
        { sessionId, runnerId, token: input.leaseToken });
      assertBuildAllowed(input.entitlements, project.platform, session.model);
      const reservation = await this.#metering.reserveIn(transaction, {
        uid: session.ownerUid,
        entitlements: input.entitlements,
        meterKey: input.meterKey,
        quantity: input.quantity,
        operationId: input.operationId,
        now: input.now,
      });
      transaction.update(ref, {
        specialistReservationIds: FieldValue.arrayUnion(reservation.id),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return reservation;
    });
  }

  /**
   * Forgets one specialist hold, once it has reached a terminal accounting
   * outcome. Allowed on a cancelled session: the hold is already closed by the
   * time this runs, and leaving the id behind would strand a record of a
   * reservation that no longer needs recovering.
   */
  async forgetSpecialistReservation(
    sessionId: string,
    authority: SessionLease,
    reservationId: string,
  ): Promise<void> {
    await this.#withLease(
      sessionId,
      authority,
      (transaction, ref) => {
        transaction.update(ref, {
          specialistReservationIds: FieldValue.arrayRemove(reservationId),
          updatedAt: FieldValue.serverTimestamp(),
        });
      },
      true,
    );
  }

  /** Operational shutdown preserves the current turn, queue, guard and any recovery evidence. */
  async yieldForRecovery(sessionId: string, authority: SessionLease): Promise<void> {
    await this.#withLease(sessionId, authority, (transaction, ref) => {
      transaction.update(ref, {
        claimableAt: Timestamp.now(), claimedBy: FieldValue.delete(), leaseToken: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }, true);
  }

  /** Write-ahead evidence, before a primary workspace mutation can be dispatched. */
  async requireWorkspaceSalvage(authority: SessionLease, sandboxId: string): Promise<void> {
    await this.#withLease(authority.sessionId, authority, (tx, ref, session) => {
      if (session.sandboxId !== sandboxId) throw new Error('Workspace recovery identity mismatch.');
      tx.update(ref, { workspaceRecovery: { protocol: runnerRecoveryProtocol(), status: 'REQUIRED', sandboxId }, updatedAt: FieldValue.serverTimestamp() });
    });
  }

  async workspaceRecoveryState(authority: SessionLease): Promise<WorkspaceRecovery | undefined> {
    return this.#firestore.runTransaction(async (tx) =>
      (await this.#requireRunnerLease(tx, this.#ref(authority.sessionId), authority, true)).workspaceRecovery);
  }

  /** Resource bookkeeping only. Does not grant access to snapshot publication. */
  async markWorkspaceUnrecoverable(authority: SessionLease,
    reason: 'sandbox-absent' | 'invalid-attachment' | 'persistence-revoked'): Promise<void> {
    await this.#firestore.runTransaction(async (tx) => {
      const ref = this.#ref(authority.sessionId);
      const session = await this.#requireRunnerLease(tx, ref, authority, true);
      if (session.workspaceRecovery?.status !== 'REQUIRED') throw new Error('No pending workspace salvage.');
      tx.update(ref, { workspaceRecovery: { ...session.workspaceRecovery, status: 'UNRECOVERABLE', reason },
        error: 'Workspace recovery is unrecoverable: ' + reason, updatedAt: FieldValue.serverTimestamp() });
    });
  }

  /** Forgets the sandbox and holds once they have actually been given back. */
  async detachSandbox(sessionId: string, authority: SessionLease): Promise<void> {
    await this.#withLease(sessionId, authority, (transaction, ref, session) => {
      if (session.workspaceRecovery?.status === 'REQUIRED') throw new Error('Unsaved workspace must be recovered before detachment.');
      transaction.update(ref, {
        sandboxId: FieldValue.delete(),
        reservationIds: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }, true);
  }

  /** End lost-workspace execution without discarding or settling unresolved accounting. */
  async finishUnrecoverable(authority: SessionLease): Promise<void> {
    const ref = this.#ref(authority.sessionId);
    await this.#firestore.runTransaction(async (transaction) => {
      const { session } = await this.#requireLeaseState(transaction, ref, authority, true);
      if (session.workspaceRecovery?.status !== 'UNRECOVERABLE') throw new Error('Workspace loss is not confirmed.');
      await this.#metering.assertSandboxesStoppedIn(transaction, session.ownerUid,
        [...new Set([...session.reservationIds, ...session.specialistReservationIds])],
        [...new Set([session.workspaceRecovery.sandboxId, ...(session.sandboxId === undefined ? [] : [session.sandboxId])])]);
      // The reservation documents and both ID lists remain discoverable. Their
      // OPEN/SETTLED/RELEASED status, not this session's status, governs accounting.
      transaction.update(ref, {
        status: 'FAILED', error: 'The latest unsaved workspace changes could not be recovered.',
        sandboxId: FieldValue.delete(), claimedBy: FieldValue.delete(), leaseToken: FieldValue.delete(),
        claimableAt: FieldValue.delete(), queuedTurnPending: FieldValue.delete(), pendingSteer: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      transaction.update(this.#projects.refFor(session.projectId), {
        activeSessionId: null, updatedAt: FieldValue.serverTimestamp(),
      });
    });
  }

  /**
   * Releases the current lease. Successful completion with accepted pending work
   * stays queued under the same project guard; otherwise scheduling is removed.
  */
  async finish(
    sessionId: string,
    authority: SessionLease,
    outcome: SessionOutcome,
    now: Date = new Date(),
  ): Promise<'IDLE' | 'FAILED' | 'QUEUED'> {
    const ref = this.#ref(sessionId);
    return this.#firestore.runTransaction(async (transaction) => {
      const { session } = await this.#requireLeaseState(transaction, ref, authority, true);
      if (session.workspaceRecovery?.status === 'REQUIRED') throw new Error('Unsaved workspace prevents finalization.');
      if (session.cancelRequested === true && outcome.status === 'IDLE') {
        throw new AppError({
          code: 'session/cancelled',
          statusCode: 409,
          message: 'Cancelled by user',
          details: { sessionId: session.id },
        });
      }

      // Enqueue and steering both write this session document, so a concurrent
      // acceptance forces a retry before the scheduler/guard can be cleared.
      const queued = outcome.status === 'IDLE'
        ? await transaction.get(ref.collection(queuedMessagesCollectionName).limit(1)) : undefined;
      const pending = outcome.status === 'IDLE' && (session.pendingSteer !== undefined || (queued !== undefined && queued.size > 0));
      const status = pending ? 'QUEUED' : outcome.status;

      // Terminal means `claimableAt` is deleted, and a session without it is
      // never claimed again by anyone — so this is the last moment any hold it
      // still owns can be given back. Closing them here, in the same commit,
      // makes ordinary terminal completion require settled holds. The separate
      // finishUnrecoverable path retains accounting only after resource-stop proof. A
      // contradictory ledger throws, the whole finalisation is refused, and the
      // session stays claimable for another runner to try again.
      if (session.specialistReservationIds.length > 0) {
        await this.#metering.releaseIn(
          transaction,
          session.ownerUid,
          session.specialistReservationIds,
          now,
        );
      }

      transaction.update(ref, {
        status,
        error: outcome.status === 'FAILED' ? outcome.error : FieldValue.delete(),
        claimedBy: FieldValue.delete(),
        leaseToken: FieldValue.delete(),
        claimableAt: pending ? Timestamp.fromDate(now) : FieldValue.delete(),
        queuedTurnPending: pending ? true : FieldValue.delete(),
        ...(!pending ? { pendingSteer: FieldValue.delete() } : {}),
        specialistReservationIds: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      transaction.update(this.#projects.refFor(session.projectId), {
        activeSessionId: pending ? session.id : null,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return status;
    });
  }

  /**
   * Proves the runner still holds the session, inside the transaction that is
   * about to act on it. Checking outside would leave a window in which the lease
   * expires between the check and the write.
   */
  async #requireLease(
    transaction: Transaction,
    ref: DocumentReference,
    authority: SessionLease,
    allowCancelled = false,
  ): Promise<BuildSession> {
    return (await this.#requireLeaseState(transaction, ref, authority, allowCancelled)).session;
  }

  async #requireLeaseState(
    transaction: Transaction,
    ref: DocumentReference,
    authority: SessionLease,
    allowCancelled = false,
  ): Promise<{ readonly session: BuildSession; readonly project: Project }> {
    const session = await this.#requireRunnerLease(transaction, ref, authority, allowCancelled);
    const project = await this.#projects.readOwnedInTransaction(
      transaction, session.ownerUid, session.projectId, allowCancelled,
    );
    this.#assertProjectGuard(project, session);
    return { session, project };
  }

  async #requireRunnerLease(transaction: Transaction, ref: DocumentReference, authority: SessionLease,
    allowCancelled = false): Promise<BuildSession> {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) {
      throw new AppError({
        code: 'session/not-found',
        statusCode: 404,
        message: 'No such session.',
      });
    }
    const session = parseSession(snapshot.id, snapshot.data() ?? {}, ref.path);
    if (session.cancelRequested === true && !allowCancelled) {
      throw new AppError({
        code: 'session/cancelled',
        statusCode: 409,
        message: 'Cancelled by user',
        details: { sessionId: session.id },
      });
    }
    const expiresAt = optionalTimestampField(snapshot.data() ?? {}, 'claimableAt', ref.path);
    if (session.id !== authority.sessionId || session.status !== 'RUNNING' ||
        session.claimedBy !== authority.runnerId || session.leaseToken !== authority.token ||
        expiresAt === undefined || expiresAt.getTime() <= Date.now()) {
      throw new AppError({
        code: 'session/lease-lost',
        statusCode: 409,
        message: `This session is ${session.status} and is not held by ${authority.runnerId}.`,
        details: { status: session.status, claimedBy: session.claimedBy },
      });
    }
    return session;
  }

  async #requirePersistenceLease(
    transaction: Transaction,
    ref: DocumentReference,
    authority: SessionLease,
    cleanup = false,
  ): Promise<{ readonly session: BuildSession; readonly project: Project }> {
    const state = await this.#requireLeaseState(transaction, ref, authority, cleanup);
    // Cancellation permits saving already-written work, not bypassing project access.
    if (cleanup) await this.#projects.readOwnedInTransaction(transaction, state.session.ownerUid, state.session.projectId);
    const { session } = state;
    if (session.leaseToken !== authority.token) {
      throw new AppError({
        code: 'session/lease-lost',
        statusCode: 409,
        message: 'This runner no longer owns the persistence lease for the session.',
        details: { sessionId: session.id, claimedBy: session.claimedBy },
      });
    }
    return state;
  }

  async #withLease(
    sessionId: string,
    authority: SessionLease,
    write: (transaction: Transaction, ref: DocumentReference, session: BuildSession) => void,
    allowCancelled = false,
  ): Promise<void> {
    const ref = this.#ref(sessionId);
    await this.#firestore.runTransaction(async (transaction) => {
      const session = await this.#requireLease(transaction, ref, authority, allowCancelled);
      write(transaction, ref, session);
    });
  }
}
