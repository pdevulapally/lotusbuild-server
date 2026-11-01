import { parseTaskContext, type TaskContext } from '../runner/task-context.ts';
import { parseFallbackState, requireFallbackPolicy, quotaMetadata, type FallbackState } from './fallback.ts';
import { policyFingerprint } from '../entitlements/fallback.ts';
import { parseCheckpoint, serializeCheckpoint, continuationProtocolMaxBytes, type ContinuationCheckpoint } from '../runner/continuation.ts';
import { commandTransaction, reconciledCommand } from './commands.ts';
import { runnerRecoveryProtocol } from './recovery-protocol.ts';
import { validateAttachmentRefs, maxAttachmentsPerMessage, type AttachmentRef } from '../attachments/store.ts';
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
import { mapMutation, type Mutation } from '../http/idempotency.ts';
import type { MeteringService, Reservation } from '../metering/service.ts';
import { createHash, randomUUID } from 'node:crypto';

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

export interface PendingInput {
  readonly id: string;
  readonly kind: 'question' | 'approval';
  readonly prompt: string;
}
export interface InputResponse { readonly id: string; readonly answer: string }

export interface BuildSession {
  readonly entrypoint?: 'voice';
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
  readonly pendingInput?: PendingInput | undefined;
  readonly fallback?: FallbackState | undefined;
  readonly inputContext?: string | undefined;
  readonly executionStarted?: boolean | undefined;
  readonly discardQueuedBefore?: Date | undefined;
  readonly workspaceRecovery?: WorkspaceRecovery | undefined;
  /** Consecutive failed resource recoveries by successor runners; cleared when recovery completes. */
  readonly recoveryAttempts?: number | undefined;
  /** A late follow-up has not yet been appended or charged as a new turn. */
  readonly queuedTurnPending?: boolean | undefined;
  /** Latest accepted steering instruction, consumed under the runner lease. */
  readonly pendingSteer?: string | undefined;
  readonly pendingSteerAttachments?: readonly AttachmentRef[] | undefined;
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
  readonly taskContext?: TaskContext;
  readonly messageCount: number;
  /** Conversational notes do not change execution/checkpoint authority. */
  readonly voiceMessageCount?: number | undefined;
  readonly createdAt: Date;
}

export interface ClaimedSession extends BuildSession {
  readonly status: 'RUNNING';
  readonly recovered?: boolean;
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
  /** Images the user attached; the bytes live in `AttachmentStore` under the owner. */
  readonly attachments: readonly AttachmentRef[];
  readonly createdAt: Date;
  /** Conversation context, never runner/tool evidence or approval authority. */
  readonly voiceSpeaker?: 'user' | 'assistant' | undefined;
}

export interface SteerMessage {
  readonly prompt: string;
  readonly attachments: readonly AttachmentRef[];
}

export interface QueuedMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly prompt: string;
  readonly attachments: readonly AttachmentRef[];
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

function continuationSource(project: Project, session: BuildSession): string {
  const executionMessages = session.messageCount - (session.voiceMessageCount ?? 0);
  if (!Number.isSafeInteger(executionMessages) || executionMessages < 1) throw new Error('Invalid execution message count.');
  return createHash('sha256').update(JSON.stringify([project.snapshot, session.model, session.mode, executionMessages])).digest('hex');
}
function continuationQueued(session: BuildSession): boolean {
  return session.fallback?.checkpointId !== undefined && ['QUEUED', 'CAPACITY_WAIT', 'RUNNING'].includes(session.fallback.status);
}

function inputContext(project: Project, session: BuildSession): string {
  return createHash('sha256').update(JSON.stringify([project.snapshot, session.model, session.mode])).digest('hex');
}

function parsePendingInput(value: unknown): PendingInput | undefined {
  if (value === undefined) return undefined;
  const fields = receiptFields(value);
  return { id: stringField(fields, 'id', 'pendingInput'), kind: enumField(fields, 'kind', 'pendingInput', ['question', 'approval']),
    prompt: stringField(fields, 'prompt', 'pendingInput') };
}

const RECOVERY_RETRY_CAP_SECONDS = 3600;

function parseSession(id: string, fields: Fields, where: string): BuildSession {
  const entrypoint = fields['entrypoint'] === undefined ? undefined : enumField(fields, 'entrypoint', where, ['voice']);
  const messageCount = integerField(fields, 'messageCount', where, { min: entrypoint === 'voice' ? 0 : 1 });
  return {
    ...(entrypoint === undefined ? {} : { entrypoint }),
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
    pendingInput: parsePendingInput(fields['pendingInput']),
    inputContext: optionalStringField(fields, 'inputContext'),
    fallback: parseFallbackState(fields['fallback']),
    ...(fields['taskContext'] === undefined ? {} : { taskContext: parseTaskContext(fields['taskContext']) }),
    discardQueuedBefore: optionalTimestampField(fields, 'discardQueuedBefore', where),
    executionStarted: fields['executionStarted'] === true ? true : undefined,
    cancelRequested: fields['cancelRequested'] === true ? true : undefined,
    workspaceRecovery: workspaceRecovery(fields, where),
    recoveryAttempts: fields['recoveryAttempts'] === undefined ? undefined : integerField(fields, 'recoveryAttempts', where, { min: 1 }),
    queuedTurnPending: fields['queuedTurnPending'] === undefined ? undefined : booleanField(fields, 'queuedTurnPending', where),
    pendingSteer: fields['pendingSteer'] === undefined ? undefined : stringField(fields, 'pendingSteer', where),
    pendingSteerAttachments: fields['pendingSteerAttachments'] === undefined ? undefined : attachmentRefsField(fields, 'pendingSteerAttachments', where),
    reservationIds: stringArrayField(fields, 'reservationIds', where),
    specialistReservationIds: stringArrayField(fields, 'specialistReservationIds', where),
    messageCount,
    ...(fields['voiceMessageCount'] === undefined ? {} : { voiceMessageCount: integerField(fields, 'voiceMessageCount', where, { min: 0, max: messageCount - (entrypoint === 'voice' ? 0 : 1) }) }),
    createdAt: timestampField(fields, 'createdAt', where),
  };
}

function parseMessage(id: string, fields: Fields, where: string): SessionMessage {
  return {
    seq: Number(id),
    role: enumField(fields, 'role', where, messageRoles),
    content: stringField(fields, 'content', where),
    attachments: attachmentRefsField(fields, 'attachments', where),
    createdAt: timestampField(fields, 'createdAt', where),
    ...(fields['voiceSpeaker'] === undefined ? {} : { voiceSpeaker: enumField(fields, 'voiceSpeaker', where, ['user', 'assistant']) }),
  };
}

function attachmentRefsField(fields: Fields, name: string, where: string): readonly AttachmentRef[] {
  const value = fields[name];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${where}: "${name}" must be an array.`);
  try {
    return validateAttachmentRefs(value as readonly AttachmentRef[]);
  } catch (error) {
    throw new Error(`${where}: "${name}" holds an invalid attachment reference.`, { cause: error });
  }
}

/** Only written when present, so documents without images stay exactly as they were. */
function attachmentsField(refs: readonly AttachmentRef[]): { attachments?: AttachmentRef[] } {
  return refs.length === 0 ? {} : { attachments: refs.map((ref) => ({ id: ref.id, mediaType: ref.mediaType })) };
}

function parseQueuedMessage(id: string, sessionId: string, fields: Fields, where: string): QueuedMessage {
  return {
    id,
    sessionId,
    prompt: stringField(fields, 'prompt', where),
    attachments: attachmentRefsField(fields, 'attachments', where),
    createdAt: timestampField(fields, 'createdAt', where),
  };
}


export type MessageAcceptance =
  | { readonly kind: 'steered'; readonly sessionId: string }
  | { readonly kind: 'queued'; readonly message: QueuedMessage }
  | { readonly kind: 'prompt'; readonly session: BuildSession };

function receiptFields(value: unknown): Fields {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid command result.');
  return value as Fields;
}
function receiptSession(value: unknown): BuildSession {
  const fields = receiptFields(value);
  const date = (key: string) => {
    const text = stringField(fields, key, 'command');
    const date = new Date(text);
    if (!Number.isFinite(date.getTime())) throw new Error('Invalid command timestamp.');
    return Timestamp.fromDate(date);
  };
  return parseSession(stringField(fields, 'id', 'command'), { ...fields, createdAt: date('createdAt'),
    ...(fields['heartbeatAt'] === undefined ? {} : { heartbeatAt: date('heartbeatAt') }),
    ...(fields['discardQueuedBefore'] === undefined ? {} : { discardQueuedBefore: date('discardQueuedBefore') }) }, 'command');
}
function receiptMessage(value: unknown): MessageAcceptance {
  const fields = receiptFields(value);
  if (fields['kind'] === 'steered') return { kind: 'steered', sessionId: stringField(fields, 'sessionId', 'command') };
  if (fields['kind'] === 'prompt') return { kind: 'prompt', session: receiptSession(fields['session']) };
  if (fields['kind'] !== 'queued') throw new Error('Invalid message receipt.');
  const message = receiptFields(fields['message']);
  return { kind: 'queued', message: parseQueuedMessage(stringField(message, 'id', 'command'),
    stringField(message, 'sessionId', 'command'), { ...message,
      createdAt: Timestamp.fromDate(new Date(stringField(message, 'createdAt', 'command'))) }, 'command') };
}

export type NewSession = {
  readonly model: string;
  readonly effort?: AiEffort;
  readonly mode?: SessionMode;
} & (
  | { readonly entrypoint?: undefined; readonly prompt: string; readonly attachments?: readonly AttachmentRef[] }
  | { readonly entrypoint: 'voice'; readonly mode: 'plan'; readonly prompt?: never; readonly attachments?: never }
);

/** What a runner reports when it stops working on a session. */
export type SessionOutcome =
  | { readonly status: 'IDLE' }
  | { readonly status: 'FAILED'; readonly error: string; readonly fallback?: FallbackState };

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
  async create(uid: string, projectId: string, input: NewSession, idempotencyId?: string, commandId?: string | Mutation<BuildSession>): Promise<BuildSession> {
    const attachments = validateAttachmentRefs(input.attachments);

    const voice = input.entrypoint === 'voice';
    if (voice) {
      if (input.mode !== 'plan' || input.prompt !== undefined || input.attachments !== undefined) throw new AppError({ code: 'session/invalid-voice-session', statusCode: 400, message: 'A new voice session must use Plan mode without a prompt or attachments.' });
    } else this.#validatePrompt(input.prompt);
    if (idempotencyId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(idempotencyId)) throw new Error('Invalid internal session id.');
    const project = await this.#projects.readOwned(uid, projectId);
    const entitlements = await this.#entitlements.forUser(uid);

    const mode = input.mode ?? 'build';
    const { registry } = await this.#configuration.get();

    const now = new Date();
    const collection = this.#firestore.collection(sessionsCollectionPath);
    const ref = idempotencyId === undefined ? collection.doc() : collection.doc(idempotencyId);
    const firstMessage = ref.collection(messagesCollectionName).doc(messageId(0));
    const existing = await commandTransaction<BuildSession>({ db: this.#firestore, parent: this.#projects.refFor(projectId), uid, key: commandId,
      input: voice ? ['create-voice-session', input.model, input.effort ?? null, input.mode ?? null]
        : ['create-session', input.prompt, input.model, input.effort ?? null, input.mode ?? null, attachments],
      encode: (session) => ({ id: session.id }),
      decode: async (value, transaction) => {
        const id = stringField(receiptFields(value), 'id', 'command');
        const snapshot = await transaction.get(this.#ref(id));
        if (!snapshot.exists) throw new AppError({ code: 'session/not-found', statusCode: 404, message: 'No such session.' });
        const current = parseSession(id, snapshot.data() ?? {}, snapshot.ref.path);
        if (current.ownerUid !== uid || current.projectId !== projectId) throw new Error('Session receipt scope disagrees.');
        await this.#projects.readOwnedInTransaction(transaction, uid, current.projectId);
        return current;
      }, work: async (transaction): Promise<BuildSession> => {
      if (idempotencyId !== undefined) {
        const prior = await transaction.get(ref);
        if (prior.exists) {
          const parsed = parseSession(prior.id, prior.data() ?? {}, ref.path);
          if (parsed.ownerUid !== uid || parsed.projectId !== projectId) throw new Error('Idempotent session scope disagrees.');
          return parsed;
        }
      }
      const currentProject = await this.#projects.readOwnedInTransaction(transaction, uid, project.id);
      this.#assertProjectCanActivate(currentProject);
      assertBuildAllowed(entitlements, currentProject.platform, input.model);
      const effort = resolveAiEffort(entitlements, input.effort);

      if (!voice) await this.#metering.consumeIn(transaction, {
        uid,
        entitlements,
        meterKey: registry.buildMeterKey,
        quantity: 1,
        now,
      });

      transaction.create(ref, {
        ...(voice ? { entrypoint: 'voice' } : {}),
        projectId: project.id,
        ownerUid: uid,
        status: voice ? 'IDLE' : 'QUEUED',
        model: input.model,
        effort,
        mode,
        messageCount: voice ? 0 : 1,
        // The single field a runner queries on. See `claim`.
        ...(voice ? {} : { claimableAt: Timestamp.fromDate(now) }),
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      if (!voice) transaction.create(firstMessage, {
        role: 'user',
        content: input.prompt,
        ...attachmentsField(attachments),
        createdAt: FieldValue.serverTimestamp(),
      });
      transaction.update(this.#projects.refFor(project.id), {
        activeSessionId: voice ? null : ref.id,
        updatedAt: FieldValue.serverTimestamp(),
      });
    return {
      ...(voice ? { entrypoint: 'voice' as const } : {}),
      id: ref.id,
      projectId: project.id,
      ownerUid: uid,
      status: voice ? 'IDLE' : 'QUEUED',
      model: input.model,
      effort,
      mode,
      sandboxId: undefined,
      claimedBy: undefined,
      leaseToken: undefined,
      heartbeatAt: undefined,
      error: undefined,
      reservationIds: [],
      specialistReservationIds: [],
      messageCount: voice ? 0 : 1,
      createdAt: now,
    };
    } });

    return reconciledCommand(existing, await this.readOwned(uid, existing.id));

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
    const project = await this.#projects.readOwned(ownerUid, session.projectId);
    if (session.fallback?.imageExpiresAt !== undefined && Date.parse(session.fallback.imageExpiresAt) <= Date.now() && session.fallback.resumable === true) return { ...session, fallback: { ...session.fallback, status: 'UNAVAILABLE', resumable: false, reason: 'Saved screenshot context expired. Fresh context is required before continuing.' } };
    if (session.status === 'IDLE' && session.fallback?.resumable === true && session.fallback.sourceVersion !== continuationSource(project, session)) {
      return { ...session, fallback: { ...session.fallback, status: 'UNAVAILABLE', resumable: false, reason: 'The project changed while this task was paused. Cancel this continuation and review the updated project before starting different work.' } };
    }
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
   * The owner's newest sessions across all projects, for the activity inbox.
   * Equality-only on `ownerUid` so no composite index is needed; ordering is
   * done in memory over a bounded read.
   */
  async listRecentForOwner(ownerUid: string, limit: number): Promise<readonly BuildSession[]> {
    const snapshot = await this.#firestore
      .collection(sessionsCollectionPath)
      .where('ownerUid', '==', ownerUid)
      .limit(500)
      .get();
    return snapshot.docs
      .map((doc) => parseSession(doc.id, doc.data(), doc.ref.path))
      .filter((session) => session.ownerUid === ownerUid)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
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
   * The latest session's transcript for a project the caller has already been
   * authorised to read through `ProjectRepository.readShared`. Never call it
   * without that check: it does not prove ownership itself.
   */
  async sharedTranscript(projectId: string, limit: number): Promise<readonly SessionMessage[]> {
    const latest = await this.#firestore
      .collection(sessionsCollectionPath)
      .where('projectId', '==', projectId)
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();
    const session = latest.docs[0];
    if (session === undefined) return [];
    const messages = await this.#ref(session.id)
      .collection(messagesCollectionName)
      .orderBy(FieldPath.documentId(), 'desc')
      .limit(limit)
      .get();
    return messages.docs.map((doc) => parseMessage(doc.id, doc.data(), doc.ref.path)).reverse();
  }

  /**
   * Adds the user's next turn and puts the session back in the queue.
   *
   * Refused while a runner holds it: a prompt arriving mid-build would either be
   * silently dropped or race the agent's own message into the transcript, and
   * neither is something the user can see happening.
   */
  async appendPrompt(uid: string, sessionId: string, prompt: string, mode?: SessionMode, operation?: Mutation<BuildSession>, attachmentRefs?: readonly AttachmentRef[]): Promise<BuildSession> {
    const accepted = mapMutation<BuildSession, MessageAcceptance>(operation, value => {
      if (value.kind !== 'prompt') throw new Error('Unexpected prompt result.'); return value.session;
    });
    const result = await this.submitMessage(uid, sessionId, prompt, false, accepted, 'append', undefined, mode, attachmentRefs);
    if (result.kind !== 'prompt') throw new Error('Unexpected prompt result.');
    return result.session;
  }

  async enqueueMessage(uid: string, sessionId: string, prompt: string, operation?: Mutation<QueuedMessage>, attachmentRefs?: readonly AttachmentRef[]): Promise<QueuedMessage> {
    const accepted = mapMutation<QueuedMessage, MessageAcceptance>(operation, value => {
      if (value.kind !== 'queued') throw new Error('Unexpected queue result.'); return value.message;
    });
    const result = await this.submitMessage(uid, sessionId, prompt, false, accepted, 'enqueue', undefined, undefined, attachmentRefs);
    if (result.kind !== 'queued') throw new Error('Unexpected queue result.');
    return result.message;
  }

  /** Choose the submission path inside the same transaction as its receipt, not from a stale HTTP read. */
  async submitMessage(uid: string, sessionId: string, prompt: string, steer = false, commandId?: string | Mutation<MessageAcceptance>,
    strategy?: 'append' | 'enqueue' | 'steer', inputResponse?: InputResponse, mode?: SessionMode, attachmentRefs?: readonly AttachmentRef[]): Promise<MessageAcceptance> {
    const attachments = validateAttachmentRefs(attachmentRefs);
    this.#validatePrompt(prompt);
    await this.readOwned(uid, sessionId);
    const entitlements = await this.#entitlements.forUser(uid);
    const limit = await this.#queueLimit(entitlements);
    const { registry } = await this.#configuration.get();
    const ref = this.#ref(sessionId);
    const queuedRef = ref.collection(queuedMessagesCollectionName).doc();
    const now = new Date();
    const accepted = await commandTransaction<MessageAcceptance>({ db: this.#firestore, parent: ref, uid, key: commandId,
      input: ['message', prompt, steer, inputResponse ?? null, mode ?? null, attachments],
      decode: async (value, transaction) => {
        const snapshot = await transaction.get(ref);
        const current = parseSession(sessionId, snapshot.data() ?? {}, ref.path);
        await this.#projects.readOwnedInTransaction(transaction, uid, current.projectId);
        const fields = receiptFields(value);
        if (fields['kind'] !== undefined) return receiptMessage(value);
        if (fields['steered'] === true) return { kind: 'steered', sessionId: stringField(fields, 'sessionId', 'receipt') };
        if (fields['queued'] === true) return receiptMessage({ kind: 'queued', message: fields['queuedMessage'] });
        if (fields['queued'] === false) return { kind: 'prompt', session: current };
        throw new Error('Invalid message acceptance receipt.');
      }, work: async (transaction): Promise<MessageAcceptance> => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists || snapshot.data()?.['ownerUid'] !== uid) {
        throw new AppError({ code: 'session/not-found', statusCode: 404, message: 'No such session.' });
      }
      const current = parseSession(snapshot.id, snapshot.data() ?? {}, ref.path);
      this.#assertPromptRecoveryEligible(current);
      const pendingInput = current.pendingInput;
      if (pendingInput !== undefined && (inputResponse?.id !== pendingInput.id || current.status !== 'IDLE')) {
        throw new AppError({ code: 'session/input-required', statusCode: 409, message: 'Answer the current request before starting more work.' });
      }
      if (inputResponse !== undefined && pendingInput === undefined) throw new AppError({
        code: 'session/input-stale', statusCode: 409, message: 'This request is no longer awaiting an answer.' });
      if (pendingInput?.kind === 'approval' && !['approve', 'reject'].includes(inputResponse?.answer ?? '')) throw new AppError({
        code: 'session/invalid-decision', statusCode: 400, message: 'Choose approve or reject for this request.' });
      const active = isActiveSessionStatus(current.status);
      if (strategy === 'append' && active) throw new AppError({ code: 'session/busy', statusCode: 409,
        message: 'This session is still working. Wait for it to finish before sending more.', details: { status: current.status } });
      if (active && mode !== undefined) throw new AppError({ code: 'session/mode-change-busy', statusCode: 409, message: 'Wait for the current turn before changing mode.' });
      if ((active && current.cancelRequested === true) || (strategy === 'enqueue' && !active)) {
        throw new AppError({ code: 'session/not-active', statusCode: 409, message: 'This session is no longer accepting queued messages.' });
      }
      if (strategy === 'steer' && current.status !== 'RUNNING') throw new AppError({ code: 'session/not-running', statusCode: 409,
        message: 'This session is no longer accepting steering instructions.' });
      const project = await this.#projects.readOwnedInTransaction(transaction, uid, current.projectId);
      if (pendingInput !== undefined && ((mode !== undefined && mode !== current.mode) || current.inputContext !== inputContext(project, current))) throw new AppError({
        code: 'session/input-context-changed', statusCode: 409, message: 'The project changed while this request was waiting. Cancel this request and review the updated project before continuing.' });
      if (active) this.#assertProjectGuard(project, current);
      else this.#assertProjectCanActivate(project, current.id);
      assertBuildAllowed(entitlements, project.platform, current.model);
      if ((steer || strategy === 'steer') && current.status === 'RUNNING') {
        // Several spoken or typed clarifications can arrive before the next safe point.
        // Preserve every accepted instruction rather than overwriting an acknowledged one.
        const pendingSteer = current.pendingSteer === undefined ? prompt : `${current.pendingSteer}\n\n${prompt}`;
        const pendingAttachments = [...(current.pendingSteerAttachments ?? []), ...attachments];
        if (pendingSteer.length > promptMaxLength || pendingAttachments.length > maxAttachmentsPerMessage) throw new AppError({
          code: 'session/steer-full', statusCode: 409, message: 'Wait for the current clarification to be read before adding more.',
        });
        transaction.update(ref, { pendingSteer, pendingSteerAttachments: pendingAttachments, updatedAt: FieldValue.serverTimestamp() });
        return { kind: 'steered', sessionId };
      }
      if (active) {
        const queued = await transaction.get(this.#queuedMessages(ref, current).limit(limit + 1));
        if (queued.size >= limit) throw new AppError({ code: 'session/queue-full', statusCode: 429, message: 'The session message queue is full.' });
        transaction.create(queuedRef, { prompt, ...attachmentsField(attachments), createdAt: FieldValue.serverTimestamp() });
        transaction.update(ref, { updatedAt: FieldValue.serverTimestamp() });
        return { kind: 'queued', message: { id: queuedRef.id, sessionId, prompt, attachments, createdAt: now } };
      }
      await this.#metering.consumeIn(transaction, { uid, entitlements, meterKey: registry.buildMeterKey, quantity: 1, now });
      if (current.fallback?.checkpointId !== undefined) transaction.delete(ref.collection('continuations').doc('active'));
      let content = prompt;
      if (pendingInput !== undefined) {
        if (inputResponse === undefined) throw new Error('A current input response is required.');
        transaction.update(ref.collection('input_requests').doc(pendingInput.id), { answer: inputResponse.answer, answeredAt: FieldValue.serverTimestamp() });
        content = `Response to ${pendingInput.kind} ${pendingInput.id}: ${inputResponse.answer}\nRequest: ${pendingInput.prompt}`;
      }
      transaction.create(ref.collection(messagesCollectionName).doc(messageId(current.messageCount)), {
        role: 'user', content, ...attachmentsField(attachments), createdAt: FieldValue.serverTimestamp(),
      });
      transaction.update(ref, { status: 'QUEUED', ...(mode === undefined ? {} : { mode }), pendingInput: FieldValue.delete(), inputContext: FieldValue.delete(), fallback: FieldValue.delete(), executionStarted: FieldValue.delete(), messageCount: FieldValue.increment(1), claimableAt: Timestamp.fromDate(now),
        cancelRequested: FieldValue.delete(), error: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
      transaction.update(this.#projects.refFor(current.projectId), { activeSessionId: current.id, updatedAt: FieldValue.serverTimestamp() });
      return { kind: 'prompt', session: { ...current, status: 'QUEUED', ...(mode === undefined ? {} : { mode }), pendingInput: undefined, inputContext: undefined, fallback: undefined, executionStarted: undefined, error: undefined, cancelRequested: undefined, messageCount: current.messageCount + 1 } };
    } });
    return accepted.kind === 'prompt' ? reconciledCommand(accepted, { ...accepted, session: await this.readOwned(uid, sessionId) }) : accepted;

  }

  // There is no reason to stage more builds than the plan permits in a whole
  // billing window. Reuse that configured bound rather than invent a new plan rule.
  #queuedMessages(ref: DocumentReference, session: BuildSession) {
    const collection = ref.collection(queuedMessagesCollectionName);
    return session.discardQueuedBefore === undefined ? collection
      : collection.where('createdAt', '>', Timestamp.fromDate(session.discardQueuedBefore));
  }

  async #queueLimit(entitlements: UserEntitlements): Promise<number> {
    const { registry } = await this.#configuration.get();
    const limit = entitlements.meterLimits.get(registry.buildMeterKey);
    if (limit === undefined) throw new Error('The build meter limit is missing.');
    return limit.hardLimit;
  }

  async listQueuedMessages(uid: string, sessionId: string, limit = 100, after?: string): Promise<readonly QueuedMessage[]> {
    const session = await this.readOwned(uid, sessionId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid queue page size.');
    let query = this.#queuedMessages(this.#ref(session.id), session)
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
      if (session.pendingInput !== undefined || continuationQueued(session)) return undefined;
      const queuedSnapshot = await transaction.get(this.#queuedMessages(ref, session)
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
        ...attachmentsField(nextData.attachments),
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
    if (session.fallback !== undefined && (session.fallback.resumable === true || ['AWAITING_CONSENT', 'EXHAUSTED', 'SHARED_LIMIT', 'CAPACITY_WAIT'].includes(session.fallback.status))) throw new AppError({ code: 'fallback/decision-required', statusCode: 409, message: 'Review the paused task, wait for its allowance to reset, or cancel before starting different work.' });
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
  async queueSteerMessage(uid: string, sessionId: string, prompt: string, operation?: Mutation<void>, attachmentRefs?: readonly AttachmentRef[]): Promise<void> {
    await this.submitMessage(uid, sessionId, prompt, true, mapMutation<void, MessageAcceptance>(operation, () => undefined), 'steer', undefined, undefined, attachmentRefs);
  }

  /** Consume the latest steering instruction and persist its conversation position atomically. */
  async drainSteerMessage(sessionId: string, authority: SessionLease): Promise<SteerMessage | undefined> {
    const ref = this.#ref(sessionId);
    return this.#firestore.runTransaction(async (transaction) => {
      const session = await this.#requireLease(transaction, ref, authority);
      const prompt = session.pendingSteer;
      if (prompt === undefined) return undefined;
      const attachments = session.pendingSteerAttachments ?? [];
      const seq = session.messageCount;
      transaction.create(ref.collection(messagesCollectionName).doc(messageId(seq)), {
        role: 'user',
        content: prompt,
        ...attachmentsField(attachments),
        createdAt: FieldValue.serverTimestamp(),
      });
      transaction.update(ref, {
        pendingSteer: FieldValue.delete(),
        pendingSteerAttachments: FieldValue.delete(),
        messageCount: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { prompt, attachments };
    });
  }

  /** Start work accepted during finalization, after claiming and recovering old resources. */
  async startPendingTurn(sessionId: string, authority: SessionLease, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    const ref = this.#ref(sessionId);
    return this.#firestore.runTransaction(async (transaction) => {
      const session = await this.#requireLease(transaction, ref, authority);
      if (session.queuedTurnPending !== true) throw new Error('Session has no pending turn to start.');
      const queued = await transaction.get(this.#queuedMessages(ref, session).orderBy('createdAt', 'asc').limit(1));
      const next = queued.docs[0];
      const pending: SteerMessage | undefined = session.pendingSteer !== undefined
        ? { prompt: session.pendingSteer, attachments: session.pendingSteerAttachments ?? [] }
        : next === undefined ? undefined : parseQueuedMessage(next.id, sessionId, next.data(), next.ref.path);
      const prompt = pending?.prompt;
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
        role: 'user', content: prompt, ...attachmentsField(pending?.attachments ?? []), createdAt: FieldValue.serverTimestamp(),
      });
      transaction.update(ref, { queuedTurnPending: FieldValue.delete(), fallback: FieldValue.delete(), pendingSteer: FieldValue.delete(),

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
  async cancel(uid: string, sessionId: string, commandId?: string | Mutation<BuildSession>): Promise<BuildSession> {

    const session = await this.readOwned(uid, sessionId);
    const entitlements = await this.#entitlements.forUser(uid);
    const { registry } = await this.#configuration.get();
    const ref = this.#ref(sessionId);
    const now = new Date();

    const accepted = await commandTransaction({ db: this.#firestore, parent: ref, uid, key: commandId, input: ['cancel'], decode: async (_value, transaction) => {
      const snapshot = await transaction.get(ref); const current = parseSession(sessionId, snapshot.data() ?? {}, ref.path);
      await this.#projects.readOwnedInTransaction(transaction, uid, current.projectId, true); return current;
    }, work: async (transaction) => {
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
      if (current.status === 'IDLE' && (current.pendingInput !== undefined || (current.fallback !== undefined && current.fallback.status !== 'COMPLETED'))) {
        await this.#projects.readOwnedInTransaction(transaction, uid, current.projectId);
        transaction.delete(ref.collection('continuations').doc('active'));
        if (current.pendingInput !== undefined) transaction.update(ref.collection('input_requests').doc(current.pendingInput.id), { cancelledAt: FieldValue.serverTimestamp() });
        transaction.update(ref, { status: 'FAILED', error: 'Cancelled by user', discardQueuedBefore: FieldValue.serverTimestamp(), pendingInput: FieldValue.delete(), fallback: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
        return { ...current, status: 'FAILED' as const, error: 'Cancelled by user', pendingInput: undefined };
      }

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
        if (current.queuedTurnPending !== true && !continuationQueued(current)) await this.#metering.refundIn(transaction, {
          uid,
          entitlements,
          meterKey: registry.buildMeterKey,
          quantity: 1,
          chargedAt: timestampField(snapshot.data() ?? {}, 'claimableAt', ref.path),
          now,
        });

        transaction.delete(ref.collection('continuations').doc('active'));
        transaction.update(ref, {
          status: 'FAILED',
          discardQueuedBefore: FieldValue.serverTimestamp(),
          error: 'Cancelled by user',
          leaseToken: FieldValue.delete(),
          claimableAt: FieldValue.delete(),
          fallbackClaimableAt: FieldValue.delete(),
          fallback: FieldValue.delete(),
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
        return result;
      }

      transaction.delete(ref.collection('continuations').doc('active'));
      transaction.update(ref, {
        cancelRequested: true,
        discardQueuedBefore: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      return { ...current, cancelRequested: true };
    } });
    return reconciledCommand(accepted, await this.readOwned(uid, sessionId));

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

    const fallbackCandidates = await this.#firestore.collection(sessionsCollectionPath)
      .where('fallbackClaimableAt', '<=', Timestamp.fromDate(now)).orderBy('fallbackClaimableAt', 'asc').limit(1).get();
    const premiumCandidate = candidates.docs[0]; const fallbackCandidate = fallbackCandidates.docs[0];
    if (premiumCandidate === undefined && fallbackCandidate === undefined) return undefined;
    const { registry } = await this.#configuration.get();
    const scheduler = this.#firestore.doc('scheduler/fallback_dispatch');
    const leaseToken = randomUUID();
    return this.#firestore.runTransaction(async (transaction) => {
      const scheduling = fallbackCandidate === undefined ? undefined : await transaction.get(scheduler);
      const count = scheduling?.exists ? integerField(scheduling.data() ?? {}, 'premiumDispatches', scheduler.path, { min: 0 }) : 0;
      const recovering = premiumCandidate?.data()?.['status'] === 'RUNNING';
      const fallbackTurn = !recovering && fallbackCandidate !== undefined && (premiumCandidate === undefined || registry.fallback === undefined || count >= registry.fallback.maxPremiumDispatches);
      const candidate = fallbackTurn ? fallbackCandidate : premiumCandidate;
      if (candidate === undefined) return undefined;
      const ref = candidate.ref;
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) {
        return undefined;
      }
      const fields = snapshot.data() ?? {};
      if (!fallbackTurn && recovering && fields['status'] !== 'RUNNING') return undefined;
      const claimableAt = optionalTimestampField(fields, fallbackTurn ? 'fallbackClaimableAt' : 'claimableAt', ref.path);
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
      if (fallbackTurn && (!continuationQueued(session) || session.fallback === undefined)) throw new Error('Fallback scheduler state disagrees.');
      signal?.throwIfAborted();
      transaction.update(ref, {
        status: 'RUNNING',
        ...(continuationQueued(session) ? { fallback: { ...session.fallback, status: 'RUNNING', reason: session.fallback?.lane === 'fallback' ? 'Running with the approved free-to-user model.' : 'Continuing with the original model.' } } : {}),
        fallbackClaimableAt: FieldValue.delete(),
        claimedBy: runnerId,
        leaseToken,
        heartbeatAt: Timestamp.fromDate(now),
        claimableAt: this.#leaseExpiry(now),
        error: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      if (fallbackCandidate !== undefined && !recovering) transaction.set(scheduler, { premiumDispatches: fallbackTurn ? 0 : count + 1, updatedAt: FieldValue.serverTimestamp() });
      return {
        ...session,
        ...(continuationQueued(session) && session.fallback !== undefined ? { fallback: { ...session.fallback, status: 'RUNNING' as const, reason: session.fallback?.lane === 'fallback' ? 'Running with the approved free-to-user model.' : 'Continuing with the original model.' } } : {}),
        status: 'RUNNING' as const,
        recovered: session.status === 'RUNNING',
        claimedBy: runnerId,
        leaseToken,
        heartbeatAt: now,
        error: undefined,
      };
    });
  }

  /** Verify the expiry query before claiming work; no client is needed for retention cleanup. */
  async assertContinuationRetentionReady(): Promise<void> {
    await this.#firestore.collectionGroup('continuations').where('imageExpiresAt', '<=', Timestamp.now()).limit(1).get();
  }

  async collectExpiredContinuations(now = new Date()): Promise<void> {
    const page = await this.#firestore.collectionGroup('continuations').where('imageExpiresAt', '<=', Timestamp.fromDate(now)).limit(100).get();
    for (const entry of page.docs) await this.#firestore.runTransaction(async (transaction) => {
      const checkpoint = await transaction.get(entry.ref);
      const deadline = checkpoint.data()?.['imageExpiresAt'];
      if (!(deadline instanceof Timestamp) || deadline.toMillis() > now.getTime()) return;
      const parts = entry.ref.path.split('/');
      if (parts.length !== 4 || parts[0] !== 'sessions' || parts[2] !== 'continuations') throw new Error('Invalid continuation parent.');
      const ref = this.#firestore.doc(parts.slice(0, 2).join('/'));
      const saved = await transaction.get(ref);
      const fields = saved.data();
      if (fields === undefined) { transaction.delete(entry.ref); return; }
      const session = parseSession(saved.id, fields, ref.path);
      const projectRef = this.#projects.refFor(session.projectId);
      const project = await transaction.get(projectRef);
      transaction.delete(entry.ref);
      if (session.fallback?.checkpointId !== checkpoint.data()?.['version']) return;
      const running = session.status === 'RUNNING';
      transaction.update(ref, {
        fallback: { ...session.fallback, status: 'UNAVAILABLE', resumable: false, reason: 'Saved screenshot context expired. Fresh context is required before continuing.' },
        ...(!running ? { status: 'IDLE', claimableAt: FieldValue.delete(), fallbackClaimableAt: FieldValue.delete() } : {}),
        updatedAt: FieldValue.serverTimestamp(),
      });
      if (!running && project.data()?.['activeSessionId'] === session.id) transaction.update(projectRef, { activeSessionId: null, updatedAt: FieldValue.serverTimestamp() });
    });
  }

  /** Save a portable admission checkpoint only after workspace publication and resource disposal. */
  async pauseContinuation(authority: SessionLease, checkpoint: ContinuationCheckpoint, state: FallbackState, retryAt?: Date): Promise<void> {
    const { registry } = await this.#configuration.get();
    const policy = registry.fallback;
    if (policy === undefined) throw new Error('Fallback checkpoint storage is not configured.');
    const payload = serializeCheckpoint(checkpoint, policy.maxCheckpointBytes);
    const id = randomUUID(); const ref = this.#ref(authority.sessionId);
    await this.#firestore.runTransaction(async (transaction) => {
      const { session, project } = await this.#requireLeaseState(transaction, ref, authority);
      if (session.workspaceRecovery?.status === 'REQUIRED' || session.sandboxId !== undefined || session.reservationIds.length > 0) throw new Error('Continuation requires saved workspace and disposed resources.');
      if (session.specialistReservationIds.length > 0) await this.#metering.releaseIn(transaction, session.ownerUid, session.specialistReservationIds, new Date());
      transaction.set(ref.collection('continuations').doc('active'), { version: id, payload, source: continuationSource(project, session), policy: policyFingerprint(policy), status: 'READY', ...(checkpoint.imageExpiresAt === undefined ? {} : { imageExpiresAt: Timestamp.fromDate(new Date(checkpoint.imageExpiresAt)) }), createdAt: FieldValue.serverTimestamp() });
      transaction.update(ref, { status: retryAt === undefined ? 'IDLE' : 'QUEUED', fallback: { ...Object.fromEntries(Object.entries(state).filter(([key]) => key !== 'imageExpiresAt')), checkpointId: id, sourceVersion: continuationSource(project, session), resumable: true, ...(checkpoint.imageExpiresAt === undefined ? {} : { imageExpiresAt: checkpoint.imageExpiresAt }) }, lastFinishedLeaseToken: authority.token,
        executionStarted: FieldValue.delete(), claimableAt: retryAt !== undefined && state.lane === 'premium' ? Timestamp.fromDate(retryAt) : FieldValue.delete(), fallbackClaimableAt: retryAt === undefined || state.lane === 'premium' ? FieldValue.delete() : Timestamp.fromDate(retryAt),
        claimedBy: FieldValue.delete(), leaseToken: FieldValue.delete(), specialistReservationIds: FieldValue.delete(), error: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
      transaction.update(this.#projects.refFor(project.id), { activeSessionId: retryAt === undefined ? null : session.id, updatedAt: FieldValue.serverTimestamp() });
    });
  }

  async readContinuation(authority: SessionLease): Promise<ContinuationCheckpoint> {
    const { registry } = await this.#configuration.get();
    const policy = registry.fallback;
    return this.#firestore.runTransaction(async (transaction) => {
      const { session, project } = await this.#requireLeaseState(transaction, this.#ref(authority.sessionId), authority);
      const id = session.fallback?.checkpointId;
      if (id === undefined) throw new Error('The continuation checkpoint is missing.');
      const checkpoint = await transaction.get(this.#ref(session.id).collection('continuations').doc('active'));
      const fields = checkpoint.data() ?? {};
      if (fields['version'] !== id || fields['source'] !== continuationSource(project, session) || (session.fallback?.lane === 'fallback' && (policy === undefined || fields['policy'] !== policyFingerprint(policy)))) throw new AppError({
        code: 'fallback/checkpoint-stale', statusCode: 409, message: 'The saved project or continuation configuration changed. This task cannot be blindly resumed.' });
      return parseCheckpoint(stringField(fields, 'payload', 'continuation'), continuationProtocolMaxBytes);
    });
  }

  /** Explicit owner consent joins the existing session scheduler; no second build is created or charged. */
  async acceptFallback(uid: string, sessionId: string, commandId: string, input: { checkpointId: string; model: string; effort: AiEffort; lane?: 'premium' | 'fallback' }): Promise<BuildSession> {
    await this.readOwned(uid, sessionId);
    const entitlements = await this.#entitlements.forUser(uid, new Date(), true);
    const { registry } = await this.#configuration.get();
    const ref = this.#ref(sessionId);
    const accepted = await commandTransaction({ db: this.#firestore, parent: ref, uid, key: commandId, input: ['accept-continuation', input.checkpointId, input.model, input.effort, input.lane ?? 'fallback'],
      decode: receiptSession, work: async (transaction) => {
      const snapshot = await transaction.get(ref); const current = parseSession(sessionId, snapshot.data() ?? {}, ref.path);
      const state = current.fallback; const offer = state?.offer;
      if (current.status !== 'IDLE' || state === undefined || !['AWAITING_CONSENT', 'EXHAUSTED', 'SHARED_LIMIT', 'UNAVAILABLE'].includes(state.status) || (input.lane !== 'premium' && offer === undefined) ||
          state.checkpointId !== input.checkpointId || (input.lane === 'premium' ? (current.model !== input.model || current.effort !== input.effort) : (offer?.model !== input.model || offer?.effort !== input.effort)) || current.cancelRequested === true) throw new AppError({
        code: 'fallback/offer-stale', statusCode: 409, message: 'This fallback offer is no longer current. Refresh the task before deciding.' });
      const policy = input.lane === 'premium' ? undefined : requireFallbackPolicy(registry, entitlements, offer?.policyFingerprint);
      const project = await this.#projects.readOwnedInTransaction(transaction, uid, current.projectId);
      assertBuildAllowed(entitlements, project.platform, current.model);
      if (!entitlements.capabilities.boolean('git.persistence')) throw new AppError({ code: 'fallback/persistence-required', statusCode: 409, message: 'Safe continuation requires saved project persistence.' });
      this.#assertProjectCanActivate(project, current.id);
      const checkpoint = await transaction.get(ref.collection('continuations').doc('active'));
      const fields = checkpoint.data() ?? {};
      if (fields['version'] !== input.checkpointId || fields['status'] !== 'READY' || fields['source'] !== continuationSource(project, current) || (input.lane !== 'premium' && (policy === undefined || fields['policy'] !== policyFingerprint(policy)))) throw new AppError({ code: 'fallback/checkpoint-stale', statusCode: 409, message: 'The project or checkpoint for this task changed while awaiting your decision.' });
      parseCheckpoint(stringField(fields, 'payload', 'continuation'), continuationProtocolMaxBytes);
      const now = new Date();
      let inputMeterKey = registry.inputTokenMeterKey; let outputMeterKey = registry.outputTokenMeterKey;
      let inputQuantity = 1; let outputQuantity = 1;
      if (input.lane !== 'premium') {
        if (policy === undefined || offer === undefined) throw new Error('Verified fallback configuration is required.');
        inputMeterKey = policy.inputTokenMeterKey; outputMeterKey = policy.outputTokenMeterKey;
        inputQuantity = offer.inputTokens; outputQuantity = offer.maxOutputTokens;
      }
      const provider = registry.sandboxProviders.get(project.platform);
      if (provider === undefined) throw new Error('The project execution provider is not configured.');
      let fallback: FallbackState = { ...state, status: 'QUEUED', lane: input.lane ?? 'fallback', reason: input.lane === 'premium' ? 'Queued for the original model.' : 'Queued for the configured free-to-user model.', consent: input.lane !== 'premium' };
      let retryAt: Date | undefined;
      try {
        await this.#metering.assertAvailableIn(transaction, { uid, entitlements, meterKey: inputMeterKey, quantity: inputQuantity, now });
        await this.#metering.assertAvailableIn(transaction, { uid, entitlements, meterKey: outputMeterKey, quantity: outputQuantity, now });
        // Continuations reuse the already-admitted build; they neither refund nor charge a second build.
        await this.#metering.assertAvailableIn(transaction, { uid, entitlements, meterKey: registry.buildMeterKey, quantity: 0, now });
        await this.#metering.assertAvailableIn(transaction, { uid, entitlements, meterKey: registry.storageMeterKey, quantity: 0, now });
        await this.#metering.assertAvailableIn(transaction, { uid, entitlements, meterKey: registry.sandboxTimeMeterKey, quantity: provider.timeoutSeconds, now });
        await this.#metering.assertAvailableIn(transaction, { uid, entitlements, meterKey: provider.concurrencyMeterKey, quantity: 1, now });
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'usage/limit-reached' || typeof error.details !== 'object' || error.details === null || !('meterKey' in error.details)) throw error;
        if (error.details.meterKey === provider.concurrencyMeterKey) {
          if (registry.fallback === undefined) throw error;
          retryAt = new Date(now.getTime() + registry.fallback.capacityRetrySeconds * 1000);
          fallback = { ...fallback, status: 'CAPACITY_WAIT', reason: 'Shared execution capacity is temporarily unavailable. Your task remains queued.', retryAt: retryAt.toISOString() };
        } else {
          const modelQuota = error.details.meterKey === inputMeterKey || error.details.meterKey === outputMeterKey;
          fallback = { ...fallback, status: modelQuota ? 'EXHAUSTED' : 'SHARED_LIMIT', reason: modelQuota ? 'The selected model allowance is exhausted. Wait for reset or upgrade.' : 'A shared resource allowance was reached. Wait for reset or upgrade.', ...quotaMetadata(error) };
        }
      }
      const queued = fallback.status === 'QUEUED' || fallback.status === 'CAPACITY_WAIT';
      const due = retryAt ?? now;
      transaction.update(checkpoint.ref, { status: queued ? 'ENQUEUED' : 'READY', consentAt: FieldValue.serverTimestamp() });
      transaction.update(ref, { status: queued ? 'QUEUED' : 'IDLE', fallback,
        fallbackClaimableAt: queued && input.lane !== 'premium' ? Timestamp.fromDate(due) : FieldValue.delete(),
        claimableAt: queued && input.lane === 'premium' ? Timestamp.fromDate(due) : FieldValue.delete(),
        executionStarted: FieldValue.delete(), error: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
      transaction.update(this.#projects.refFor(project.id), { activeSessionId: queued ? current.id : null, updatedAt: FieldValue.serverTimestamp() });
      return { ...current, status: queued ? 'QUEUED' as const : 'IDLE' as const, fallback };
    } });
    return reconciledCommand(accepted, await this.readOwned(uid, sessionId));
  }

  async deferContinuation(authority: SessionLease, state: FallbackState, retryAt?: Date): Promise<void> {
    const ref = this.#ref(authority.sessionId);
    await this.#firestore.runTransaction(async (transaction) => {
      const { session, project } = await this.#requireLeaseState(transaction, ref, authority);
      if (session.sandboxId !== undefined || session.reservationIds.length > 0 || session.workspaceRecovery?.status === 'REQUIRED') throw new Error('Resources must be reconciled before deferring.');
      if (session.specialistReservationIds.length > 0) await this.#metering.releaseIn(transaction, session.ownerUid, session.specialistReservationIds, new Date());
      const status = retryAt === undefined ? 'IDLE' : 'QUEUED';
      if (retryAt === undefined && state.checkpointId !== undefined) transaction.update(ref.collection('continuations').doc('active'), { status: 'READY' });
      transaction.update(ref, { status, fallback: state, lastFinishedLeaseToken: authority.token, executionStarted: FieldValue.delete(),
        claimableAt: retryAt !== undefined && state.lane === 'premium' ? Timestamp.fromDate(retryAt) : FieldValue.delete(), fallbackClaimableAt: retryAt === undefined || state.lane === 'premium' ? FieldValue.delete() : Timestamp.fromDate(retryAt),
        claimedBy: FieldValue.delete(), leaseToken: FieldValue.delete(), specialistReservationIds: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
      transaction.update(this.#projects.refFor(project.id), { activeSessionId: retryAt === undefined ? null : session.id, updatedAt: FieldValue.serverTimestamp() });
    });
  }

  /** Notes are private session data, fenced like all worker mutations; never exposed in public SSE. */
  async saveTaskContext(authority: SessionLease, context: TaskContext): Promise<void> {
    const validated = parseTaskContext(context);
    await this.#withLease(authority.sessionId, authority, (transaction, ref) => {
      transaction.update(ref, { taskContext: validated, updatedAt: FieldValue.serverTimestamp() });
    });
  }

  async markExecutionStarted(authority: SessionLease): Promise<void> {
    await this.#withLease(authority.sessionId, authority, (tx, ref, session) => {
      if (session.pendingInput !== undefined) throw new Error('Session is awaiting user input.');
      tx.update(ref, { executionStarted: true, updatedAt: FieldValue.serverTimestamp() });
    });
  }

  async requestInput(authority: SessionLease, kind: PendingInput['kind'], prompt: string): Promise<PendingInput> {
    this.#validatePrompt(prompt);
    const request = { id: randomUUID(), kind, prompt };
    if (!['question', 'approval'].includes(kind)) throw new Error('Invalid input request kind.');
    await this.#withLease(authority.sessionId, authority, (tx, ref, session) => {
      if (session.pendingInput !== undefined) throw new Error('Session already awaits input.');
      tx.create(ref.collection('input_requests').doc(request.id), { ...request, createdAt: FieldValue.serverTimestamp() });
      tx.update(ref, { pendingInput: request, updatedAt: FieldValue.serverTimestamp() });
    });
    return request;
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

  /** Final voice dialogue shares this history without scheduling work or impersonating a worker. */
  async appendVoiceTurn(uid: string, sessionId: string, speaker: 'user' | 'assistant', text: string, key: string): Promise<void> {
    this.#validatePrompt(text);
    const parent = this.#ref(sessionId);
    await commandTransaction<{ recorded: true }>({ db: this.#firestore, parent, uid, key,
      input: ['voice-turn', speaker, text], decode: () => ({ recorded: true }), work: async tx => {
        const snapshot = await tx.get(parent);
        if (!snapshot.exists || snapshot.data()?.['ownerUid'] !== uid) throw new AppError({ code: 'session/not-found', statusCode: 404, message: 'No such session.' });
        const session = parseSession(sessionId, snapshot.data()!, parent.path);
        await this.#projects.readOwnedInTransaction(tx, uid, session.projectId);
        tx.create(parent.collection(messagesCollectionName).doc(messageId(session.messageCount)), {
          role: 'user', voiceSpeaker: speaker, content: text, createdAt: FieldValue.serverTimestamp(),
        });
        tx.update(parent, { messageCount: FieldValue.increment(1), voiceMessageCount: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() });
        return { recorded: true };
      } });
  }

  /** Adds execution-agent dialogue under the runner's lease, unlike owner voice context. */
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
        recoveryAttempts: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }, true);
  }

  /**
   * Keeps a session whose resource recovery just failed claimable, but not
   * every lease. Each failed attempt doubles the wait, capped at an hour, so
   * one dead session with unreconcilable holds cannot take the runner away
   * from healthy work once a minute. Nothing is released or marked resolved:
   * the holds, sandbox record and RUNNING status stay exactly as they were.
   */
  async deferRecovery(sessionId: string, authority: SessionLease, now: Date = new Date()): Promise<Date> {
    let retryAt = now;
    await this.#withLease(sessionId, authority, (transaction, ref, session) => {
      const attempts = (session.recoveryAttempts ?? 0) + 1;
      const waitSeconds = Math.min(this.#leaseSeconds * 2 ** Math.min(attempts, 10), RECOVERY_RETRY_CAP_SECONDS);
      retryAt = new Date(now.getTime() + waitSeconds * 1000);
      transaction.update(ref, {
        recoveryAttempts: attempts,
        claimableAt: Timestamp.fromDate(retryAt),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }, true);
    return retryAt;
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
      const { session, project } = await this.#requireLeaseState(transaction, ref, authority, true);
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
        ? await transaction.get(this.#queuedMessages(ref, session).limit(1)) : undefined;
      const pending = outcome.status === 'IDLE' && session.pendingInput === undefined && (session.pendingSteer !== undefined || (queued !== undefined && queued.size > 0));
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
        lastFinishedLeaseToken: authority.token,
        ...(outcome.status === 'FAILED' && outcome.fallback !== undefined ? { fallback: outcome.fallback } : {}),
        ...(continuationQueued(session) && !(outcome.status === 'FAILED' && outcome.fallback !== undefined) ? { fallback: { ...session.fallback, status: outcome.status === 'IDLE' ? 'COMPLETED' : 'UNAVAILABLE', resumable: false, reason: outcome.status === 'IDLE' ? 'The continuation ended within its execution budget.' : outcome.error } } : {}),
        executionStarted: FieldValue.delete(),
        inputContext: session.pendingInput === undefined ? FieldValue.delete() : inputContext(project, session),
        error: outcome.status === 'FAILED' ? outcome.error : FieldValue.delete(),
        claimedBy: FieldValue.delete(),
        leaseToken: FieldValue.delete(),
        claimableAt: pending ? Timestamp.fromDate(now) : FieldValue.delete(),
        queuedTurnPending: pending ? true : FieldValue.delete(),
        ...(!pending ? { pendingSteer: FieldValue.delete() } : {}),
        specialistReservationIds: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      if (continuationQueued(session) && outcome.status === 'IDLE' && session.fallback?.checkpointId !== undefined) transaction.delete(ref.collection('continuations').doc('active'));
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
    if (!allowCancelled && session.fallback?.imageExpiresAt !== undefined && Date.parse(session.fallback.imageExpiresAt) <= Date.now()) throw new AppError({ code: 'fallback/image-context-expired', statusCode: 409, message: 'Saved screenshot context expired. Fresh context is required before continuing.' });
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
