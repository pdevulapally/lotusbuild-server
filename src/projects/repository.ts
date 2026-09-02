import { FieldValue, type Firestore, type Transaction } from 'firebase-admin/firestore';

import type { ConfigurationStore } from '../entitlements/store.ts';
import type { EntitlementService } from '../entitlements/service.ts';
import { type Platform, platforms } from '../entitlements/schema.ts';
import { AppError } from '../http/errors.ts';
import type { MeteringService } from '../metering/service.ts';
import type { SnapshotStore, StoredSnapshot } from '../storage/snapshots.ts';
import {
  DocumentShapeError,
  type Fields,
  countField,
  enumField,
  optionalStringField,
  stringField,
  timestampField,
} from '../support/documents.ts';
import type { UserRepository } from '../users/repository.ts';

export const projectsCollectionPath = 'projects';
export const sessionsCollectionPath = 'sessions';
export const messagesCollectionName = 'messages';

/** Recovered from the previous schema: varchar(100) name, varchar(500) description. */
export const projectNameMaxLength = 100;
export const projectDescriptionMaxLength = 500;

export const projectStatuses = ['draft'] as const;

export interface Project {
  readonly id: string;
  readonly ownerUid: string;
  readonly name: string;
  readonly description: string | undefined;
  readonly platform: Platform;
  readonly status: (typeof projectStatuses)[number];
  /** Bytes the last saved snapshot occupies, and so what it charges storage. */
  readonly snapshotBytes: number;
  readonly snapshot: StoredSnapshot;
  /**
   * The session allowed to mutate this project's workspace. `null` is an
   * explicitly unlocked project; `undefined` is a legacy document that must be
   * migrated before session activation can safely continue.
   */
  readonly activeSessionId: string | null | undefined;
  readonly createdAt: Date;
}

export interface NewProject {
  readonly name: string;
  readonly description: string | undefined;
  readonly platform: Platform;
}

export interface UpdateProject {
  readonly name?: string | undefined;
  readonly description?: string | undefined;
}

function activeSessionIdField(fields: Fields, where: string): string | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(fields, 'activeSessionId')) {
    return undefined;
  }
  const value = fields['activeSessionId'];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DocumentShapeError(
      `${where}: field "activeSessionId" must be a non-empty string or null.`,
    );
  }
  return value;
}

function storedSnapshot(fields: Fields, where: string, snapshotBytes: number): StoredSnapshot {
  const hasObjectName = Object.prototype.hasOwnProperty.call(fields, 'snapshotObjectName');
  const hasGeneration = Object.prototype.hasOwnProperty.call(fields, 'snapshotObjectGeneration');
  if (hasObjectName !== hasGeneration) {
    throw new DocumentShapeError(
      `${where}: snapshotObjectName and snapshotObjectGeneration must either both exist or both be absent.`,
    );
  }
  if (!hasObjectName) {
    return snapshotBytes === 0 ? { kind: 'none' } : { kind: 'legacy' };
  }
  if (snapshotBytes === 0) {
    throw new DocumentShapeError(`${where}: an immutable snapshot cannot have zero recorded bytes.`);
  }
  const objectName = stringField(fields, 'snapshotObjectName', where);
  const generation = stringField(fields, 'snapshotObjectGeneration', where);
  if (!/^[1-9]\d*$/.test(generation)) {
    throw new DocumentShapeError(
      `${where}: field "snapshotObjectGeneration" must be a positive decimal generation.`,
    );
  }
  return { kind: 'immutable', objectName, generation };
}

function parseProject(id: string, fields: Fields, where: string): Project {
  const snapshotBytes = countField(fields, 'snapshotBytes', where);
  return {
    id,
    ownerUid: stringField(fields, 'ownerUid', where),
    name: stringField(fields, 'name', where),
    description: optionalStringField(fields, 'description'),
    platform: enumField(fields, 'platform', where, platforms),
    status: enumField(fields, 'status', where, projectStatuses),
    snapshotBytes,
    snapshot: storedSnapshot(fields, where, snapshotBytes),
    activeSessionId: activeSessionIdField(fields, where),
    createdAt: timestampField(fields, 'createdAt', where),
  };
}

export function projectSessionActiveError(): AppError {
  return new AppError({
    code: 'project/session-active',
    statusCode: 409,
    message: 'Another session is currently active for this project.',
  });
}

export function projectSessionGuardUnmigratedError(): AppError {
  return new AppError({
    code: 'project/session-guard-unmigrated',
    statusCode: 503,
    message: 'This project is not ready to start a session yet.',
  });
}

export class ProjectRepository {
  readonly #firestore: Firestore;
  readonly #users: UserRepository;
  readonly #entitlements: EntitlementService;
  readonly #metering: MeteringService | undefined;
  readonly #configuration: ConfigurationStore | undefined;
  readonly #snapshots: SnapshotStore | undefined;

  constructor(
    firestore: Firestore,
    users: UserRepository,
    entitlements: EntitlementService,
    metering?: MeteringService | undefined,
    configuration?: ConfigurationStore | undefined,
    snapshots?: SnapshotStore | undefined,
  ) {
    this.#firestore = firestore;
    this.#users = users;
    this.#entitlements = entitlements;
    this.#metering = metering;
    this.#configuration = configuration;
    this.#snapshots = snapshots;
  }


  /**
   * Creates a project if the owner's plan permits the platform and they are
   * under their project limit.
   *
   * The limit is enforced inside a transaction against a counter on the user
   * document, not by counting project documents. Counting is racy: two requests
   * arriving together both see the old total and both succeed, so the plan limit
   * a customer pays for is bypassed by the simplest possible retry.
   */
  async create(ownerUid: string, input: NewProject): Promise<Project> {
    const entitlements = await this.#entitlements.forUser(ownerUid);

    // The capability key is derived from the requested platform, so supporting a
    // new platform is a configuration change rather than another branch here.
    const platformCapability = `platform.${input.platform}`;
    if (!entitlements.capabilities.boolean(platformCapability)) {
      throw new AppError({
        code: 'project/platform-not-permitted',
        statusCode: 403,
        message: `The ${entitlements.planName} plan cannot build ${input.platform} projects.`,
        details: { platform: input.platform, plan: entitlements.planKey },
      });
    }

    const limit = entitlements.capabilities.number('projects.max');
    const ref = this.#firestore.collection(projectsCollectionPath).doc();
    const userRef = this.#users.refFor(ownerUid);

    const createdAt = await this.#firestore.runTransaction(async (transaction) => {
      const user = await this.#users.readInTransaction(transaction, ownerUid);

      if (user.projectCount >= limit) {
        throw new AppError({
          code: 'project/limit-reached',
          statusCode: 403,
          message: `The ${entitlements.planName} plan allows ${limit} projects.`,
          details: { limit, current: user.projectCount, plan: entitlements.planKey },
        });
      }

      transaction.create(ref, {
        ownerUid,
        name: input.name,
        description: input.description,
        platform: input.platform,
        status: 'draft',
        activeSessionId: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      transaction.update(userRef, {
        projectCount: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      });

      return new Date();
    });

    return {
      id: ref.id,
      ownerUid,
      name: input.name,
      description: input.description,
      platform: input.platform,
      status: 'draft',
      snapshotBytes: 0,
      snapshot: { kind: 'none' },
      activeSessionId: null,
      createdAt,
    };
  }

  /**
   * Updates an existing project's name and/or description.
   */
  async update(ownerUid: string, projectId: string, input: UpdateProject): Promise<Project> {
    const existing = await this.readOwned(ownerUid, projectId);
    if (input.name === undefined && input.description === undefined) {
      return existing;
    }

    const ref = this.refFor(projectId);
    const updates: Record<string, unknown> = {
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (input.name !== undefined) {
      updates.name = input.name;
    }
    if (input.description !== undefined) {
      updates.description = input.description === '' ? FieldValue.delete() : input.description;
    }

    await ref.update(updates);

    return {
      ...existing,
      name: input.name ?? existing.name,
      description:
        input.description !== undefined
          ? input.description === ''
            ? undefined
            : input.description
          : existing.description,
    };
  }

  /**
   * Deletes a project, decrements the owner's project count, releases any
   * storage gauge occupancy, deletes associated sessions and messages, and
   * deletes the snapshot archive in storage.
   */
  async delete(ownerUid: string, projectId: string): Promise<void> {
    const ref = this.refFor(projectId);
    const userRef = this.#users.refFor(ownerUid);

    await this.#firestore.runTransaction(async (transaction) => {
      const project = await this.readOwnedInTransaction(transaction, ownerUid, projectId);
      if (project.activeSessionId === undefined) {
        throw projectSessionGuardUnmigratedError();
      }
      if (project.activeSessionId !== null) {
        throw projectSessionActiveError();
      }

      // Release storage meter gauge if bytes were charged
      if (this.#metering !== undefined && this.#configuration !== undefined && project.snapshotBytes > 0) {
        const { registry } = await this.#configuration.get();
        const entitlements = await this.#entitlements.forUser(ownerUid);
        await this.#metering.setGaugeIn(transaction, {
          uid: ownerUid,
          entitlements,
          meterKey: registry.storageMeterKey,
          previousQuantity: project.snapshotBytes,
          quantity: 0,
          now: new Date(),
        });
      }

      transaction.delete(ref);
      transaction.update(userRef, {
        projectCount: FieldValue.increment(-1),
        updatedAt: FieldValue.serverTimestamp(),
      });
    });

    // Delete associated sessions and message sub-collections
    const sessionDocs = await this.#firestore
      .collection(sessionsCollectionPath)
      .where('projectId', '==', projectId)
      .get();

    for (const sessionDoc of sessionDocs.docs) {
      const messages = await sessionDoc.ref.collection(messagesCollectionName).get();
      const queuedMessages = await sessionDoc.ref.collection('queued_messages').get();
      const batch = this.#firestore.batch();
      for (const msg of messages.docs) {
        batch.delete(msg.ref);
      }
      for (const qMsg of queuedMessages.docs) {
        batch.delete(qMsg.ref);
      }
      batch.delete(sessionDoc.ref);
      await batch.commit();
    }


    // Clean up durable git snapshot archive if snapshot store is available
    if (this.#snapshots !== undefined) {
      try {
        await this.#snapshots.remove(projectId);
      } catch {
        // Ignored: Snapshot removal is best-effort if file does not exist
      }
    }
  }

  /** For callers that update a project inside their own transaction. */
  refFor(projectId: string) {
    return this.#firestore.doc(`${projectsCollectionPath}/${projectId}`);
  }

  async readOwnedInTransaction(
    transaction: Transaction,
    ownerUid: string,
    projectId: string,
  ): Promise<Project> {
    const ref = this.refFor(projectId);
    const snapshot = await transaction.get(ref);
    return this.#ownedFromSnapshot(ownerUid, ref.path, snapshot);
  }

  async listOwnedBy(ownerUid: string, limit: number): Promise<readonly Project[]> {
    const snapshot = await this.#firestore
      .collection(projectsCollectionPath)
      .where('ownerUid', '==', ownerUid)
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();

    return snapshot.docs.map((doc) => parseProject(doc.id, doc.data(), doc.ref.path));
  }

  /**
   * Reads a project the caller owns.
   *
   * A project owned by someone else is reported as missing rather than
   * forbidden: telling a stranger that an id exists but is not theirs leaks the
   * id space, and there is nothing they can do with the distinction.
   */
  async readOwned(ownerUid: string, projectId: string): Promise<Project> {
    const ref = this.refFor(projectId);
    const snapshot = await ref.get();

    return this.#ownedFromSnapshot(ownerUid, ref.path, snapshot);
  }

  #ownedFromSnapshot(
    ownerUid: string,
    path: string,
    snapshot: { readonly exists: boolean; readonly id: string; data(): Fields | undefined },
  ): Project {
    const missing = new AppError({
      code: 'project/not-found',
      statusCode: 404,
      message: 'No such project.',
    });

    if (!snapshot.exists) {
      throw missing;
    }
    const project = parseProject(snapshot.id, snapshot.data() ?? {}, path);
    if (project.ownerUid !== ownerUid) {
      throw missing;
    }
    return project;
  }
}

