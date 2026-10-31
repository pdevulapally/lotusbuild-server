import { commandTransaction, reconciledCommand } from '../sessions/commands.ts';
import { randomBytes, timingSafeEqual } from 'node:crypto';


import { FieldValue, type Firestore, type Transaction } from 'firebase-admin/firestore';

import type { ConfigurationStore } from '../entitlements/store.ts';
import type { EntitlementService } from '../entitlements/service.ts';
import { type Platform, platforms } from '../entitlements/schema.ts';
import { AppError } from '../http/errors.ts';
import { type Mutation } from '../http/idempotency.ts';
import type { MeteringService } from '../metering/service.ts';
import type { SnapshotStore, StoredSnapshot } from '../storage/snapshots.ts';
import { SnapshotMaintenance } from '../storage/maintenance.ts';
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

export const projectStatuses = ['draft', 'deleting'] as const;

/**
 * Who may read a project besides its owner. `link` needs the unguessable share
 * token; `public` needs only the project id. Anything else reads as private.
 */
export const projectVisibilities = ['private', 'link', 'public'] as const;
export type ProjectVisibility = (typeof projectVisibilities)[number];
const shareTokenPattern = /^[A-Za-z0-9_-]{32}$/;

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
  readonly snapshotUploadId?: string;
  readonly publicPreviewEnabled?: boolean;
  readonly visibility: ProjectVisibility;
  readonly shareToken?: string;
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
    publicPreviewEnabled: fields['publicPreviewEnabled'] === true,
    visibility: projectVisibilities.find((value) => value === fields['visibility']) ?? 'private',
    ...(typeof fields['shareToken'] === 'string' && shareTokenPattern.test(fields['shareToken']) ? { shareToken: fields['shareToken'] } : {}),
    snapshot: storedSnapshot(fields, where, snapshotBytes),
    ...(typeof fields['snapshotUploadId'] === 'string' ? { snapshotUploadId: fields['snapshotUploadId'] } : {}),
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
  readonly #eraseSessionEvents: ((id: string) => Promise<void>) | undefined;

  constructor(
    firestore: Firestore,
    users: UserRepository,
    entitlements: EntitlementService,
    metering?: MeteringService | undefined,
    configuration?: ConfigurationStore | undefined,
    snapshots?: SnapshotStore | undefined,
    eraseSessionEvents?: (id: string) => Promise<void>,
  ) {
    this.#firestore = firestore;
    this.#users = users;
    this.#entitlements = entitlements;
    this.#metering = metering;
    this.#configuration = configuration;
    this.#snapshots = snapshots;
    this.#eraseSessionEvents = eraseSessionEvents;
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
  async create(ownerUid: string, input: NewProject, commandId?: string | Mutation<Project>): Promise<Project> {

    this.#validateName(input.name);
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

    const accepted = await commandTransaction({ db: this.#firestore, parent: userRef, uid: ownerUid, key: commandId,
      input: ['create-project', input.name, input.description ?? null, input.platform],
      encode: (project) => ({ id: project.id }),
      decode: (value, transaction) => {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid project receipt.');
        return this.readOwnedInTransaction(transaction, ownerUid, stringField(value as Fields, 'id', 'command'));
      }, work: async (transaction): Promise<Project> => {
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
        visibility: 'private',
        activeSessionId: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      transaction.update(userRef, {
        projectCount: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      });


    return {
      id: ref.id,
      ownerUid,
      name: input.name,
      description: input.description,
      platform: input.platform,
      status: 'draft',
      visibility: 'private',
      snapshotBytes: 0,
      snapshot: { kind: 'none' },
      activeSessionId: null,
      createdAt: new Date(),
    };
    } });
    return reconciledCommand(accepted, await this.readOwned(ownerUid, accepted.id));
  }

  /**
   * Updates an existing project's name and/or description.
   */
  async update(ownerUid: string, projectId: string, input: UpdateProject): Promise<Project> {
    if (input.name !== undefined) this.#validateName(input.name);
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

  #validateName(name: string): void {
    if (name.trim() === '') {
      throw new AppError({ code: 'project/invalid-name', statusCode: 400,
        message: 'Project name must contain a non-whitespace character.' });
    }
  }

  async setPublicPreview(ownerUid: string, projectId: string, enabled: boolean): Promise<{ enabled: boolean; terminationPending: boolean }> {
    const ref = this.refFor(projectId);
    return this.#firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      const project = this.#ownedFromSnapshot(ownerUid, ref.path, snapshot);
      if (project.activeSessionId === undefined) throw projectSessionGuardUnmigratedError();
      if (enabled && project.activeSessionId !== null) throw new AppError({ code: 'project/session-active', statusCode: 409,
        message: 'Finish the current session before enabling public previews.' });
      const active = project.activeSessionId === null ? undefined : this.#firestore.doc(`sessions/${project.activeSessionId}`);
      let terminationPending = false;
      if (active !== undefined) {
        const session = await tx.get(active);
        if (session.data()?.['ownerUid'] !== ownerUid || session.data()?.['projectId'] !== projectId) throw new Error('Project session guard disagrees.');
        terminationPending = project.publicPreviewEnabled === true && session.data()?.['status'] === 'RUNNING';
      }
      tx.update(ref, { publicPreviewEnabled: enabled, updatedAt: FieldValue.serverTimestamp() });
      if (active !== undefined && terminationPending) tx.update(active, { cancelRequested: true, updatedAt: FieldValue.serverTimestamp() });
      return { enabled, terminationPending };
    });
  }

  /**
   * Deletes a project, decrements the owner's project count, releases any
   * storage gauge occupancy, deletes associated sessions and messages, and
   * deletes the snapshot archive in storage.
   */
  async delete(ownerUid: string, projectId: string): Promise<void> {
    const ref = this.refFor(projectId);
    const userRef = this.#users.refFor(ownerUid);

    // The parent remains as a durable tombstone until every cleanup succeeds.
    // A repeated DELETE resumes it; other project operations fail closed.
    await this.#firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const project = this.#ownedFromSnapshot(ownerUid, ref.path, snapshot, true);
      if (project.activeSessionId === undefined) throw projectSessionGuardUnmigratedError();
      if (project.activeSessionId !== null) throw projectSessionActiveError();
      transaction.update(ref, { status: 'deleting', updatedAt: FieldValue.serverTimestamp() });
    });

    // Delete descendants before their session parent. recursiveDelete uses the
    // SDK's bounded BulkWriter; a partially deleted subtree stays discoverable.
    for (;;) {
      const page = await this.#firestore.collection(sessionsCollectionPath)
        .where('projectId', '==', projectId).limit(100).get();
      if (page.docs.length === 0) break;
      for (const session of page.docs) {
        if (this.#eraseSessionEvents === undefined) throw new Error('Session event erasure is not configured.');
        await this.#eraseSessionEvents(session.id);
        await this.#firestore.recursiveDelete(session.ref.collection(messagesCollectionName));
        await this.#firestore.recursiveDelete(session.ref.collection('queued_messages'));
        await this.#firestore.recursiveDelete(session.ref.collection('commands'));
        await this.#firestore.recursiveDelete(session.ref.collection('session_events'));
        await this.#firestore.recursiveDelete(session.ref.collection('input_requests'));
        await this.#firestore.recursiveDelete(session.ref.collection('continuations'));
        await session.ref.delete();
      }
    }
    if (this.#snapshots === undefined) {
      throw new Error('Project deletion requires the snapshot store. Cleanup remains pending.');
    }
    // Storage errors must reach the caller and leave the tombstone retryable.
    if (this.#metering === undefined) throw new Error('Storage accounting is not configured.');
    await new SnapshotMaintenance(this.#firestore, this.#metering, this.#snapshots).deleteProject(projectId);
    const deleting = await ref.get();
    const deletingProject = this.#ownedFromSnapshot(ownerUid, ref.path, deleting, true);
    if (deletingProject.snapshotUploadId === undefined) await this.#snapshots.removeStored(projectId, deletingProject.snapshot);
    await this.#snapshots.eraseProjectContent(projectId);

    await this.#firestore.recursiveDelete(ref.collection('commands'));
    await this.#firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) return; // A concurrent deletion already finalized.
      const project = this.#ownedFromSnapshot(ownerUid, ref.path, snapshot, true);
      if (project.status !== 'deleting' || project.activeSessionId !== null) {
        throw new Error('Project deletion lost its tombstone.');
      }
      if (project.snapshotBytes > 0 && project.snapshotUploadId === undefined) {
        if (this.#metering === undefined || this.#configuration === undefined) {
          throw new Error('Project deletion requires storage accounting.');
        }
        const { registry } = await this.#configuration.get();
        await this.#metering.setGaugeIn(transaction, {
          uid: ownerUid, entitlements: await this.#entitlements.forUser(ownerUid),
          meterKey: registry.storageMeterKey, previousQuantity: project.snapshotBytes,
          quantity: 0, now: new Date(),
        });
      }
      transaction.delete(ref);
      transaction.update(userRef, {
        projectCount: FieldValue.increment(-1), updatedAt: FieldValue.serverTimestamp(),
      });
    });
  }

  /** For callers that update a project inside their own transaction. */
  refFor(projectId: string) {
    return this.#firestore.doc(`${projectsCollectionPath}/${projectId}`);
  }

  /**
   * Leaving `link` always discards the token, so a link shared earlier can never
   * come back to life when the project is made link-only again.
   */
  async setVisibility(ownerUid: string, projectId: string, visibility: ProjectVisibility, rotateLink = false): Promise<{ visibility: ProjectVisibility; shareToken: string | null }> {
    const ref = this.refFor(projectId);
    return this.#firestore.runTransaction(async (tx) => {
      const project = await this.readOwnedInTransaction(tx, ownerUid, projectId);
      const shareToken = visibility !== 'link' ? null
        : rotateLink || project.shareToken === undefined ? randomBytes(24).toString('base64url') : project.shareToken;
      tx.update(ref, { visibility, shareToken: shareToken ?? FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
      return { visibility, shareToken };
    });
  }

  /**
   * A project as seen by someone who is not its owner. Every refusal — missing,
   * private, wrong or absent token, closed account — is the same 404, so the id
   * space cannot be probed.
   */
  async readShared(projectId: string, token: string | undefined): Promise<Project> {
    const ref = this.refFor(projectId);
    const snapshot = await ref.get();
    const missing = new AppError({ code: 'project/not-found', statusCode: 404, message: 'No such project.' });
    if (!snapshot.exists) throw missing;
    const ownerUid = parseProject(snapshot.id, snapshot.data() ?? {}, ref.path).ownerUid;
    const project = this.#ownedFromSnapshot(ownerUid, ref.path, snapshot);
    if ((await this.#firestore.doc(`accountErasures/${ownerUid}`).get()).exists) throw missing;
    if (project.visibility === 'public') return project;
    if (project.visibility === 'link' && token !== undefined && project.shareToken !== undefined) {
      const given = Buffer.from(token);
      const expected = Buffer.from(project.shareToken);
      if (given.length === expected.length && timingSafeEqual(given, expected)) return project;
    }
    throw missing;
  }

  async readOwnedInTransaction(
    transaction: Transaction,
    ownerUid: string,
    projectId: string,
    allowErasing = false,
  ): Promise<Project> {
    const ref = this.refFor(projectId);
    const snapshot = await transaction.get(ref);
    if (!allowErasing) {
      const erasure = await transaction.get(this.#firestore.doc(`accountErasures/${ownerUid}`));
      if (erasure.exists) throw new AppError({ code: 'account/erasure-pending', statusCode: 403, message: 'This account is closed or being erased.' });
    }
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
    allowDeleting = false,
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
    if (project.status === 'deleting' && !allowDeleting) {
      throw new AppError({ code: 'project/deleting', statusCode: 409,
        message: 'This project is being deleted. Retry deletion to complete pending cleanup.' });
    }
    return project;
  }
}

