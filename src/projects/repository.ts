import { FieldValue, type Firestore } from 'firebase-admin/firestore';

import type { ConfigurationStore } from '../entitlements/store.ts';
import type { EntitlementService } from '../entitlements/service.ts';
import { type Platform, platforms } from '../entitlements/schema.ts';
import { AppError } from '../http/errors.ts';
import type { MeteringService } from '../metering/service.ts';
import type { SnapshotStore } from '../storage/snapshots.ts';
import {
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

function parseProject(id: string, fields: Fields, where: string): Project {
  return {
    id,
    ownerUid: stringField(fields, 'ownerUid', where),
    name: stringField(fields, 'name', where),
    description: optionalStringField(fields, 'description'),
    platform: enumField(fields, 'platform', where, platforms),
    status: enumField(fields, 'status', where, projectStatuses),
    snapshotBytes: countField(fields, 'snapshotBytes', where),
    createdAt: timestampField(fields, 'createdAt', where),
  };
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
    const project = await this.readOwned(ownerUid, projectId);
    const ref = this.refFor(projectId);
    const userRef = this.#users.refFor(ownerUid);

    await this.#firestore.runTransaction(async (transaction) => {
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
    const ref = this.#firestore.doc(`${projectsCollectionPath}/${projectId}`);
    const snapshot = await ref.get();

    const missing = new AppError({
      code: 'project/not-found',
      statusCode: 404,
      message: 'No such project.',
    });

    if (!snapshot.exists) {
      throw missing;
    }
    const project = parseProject(snapshot.id, snapshot.data() ?? {}, ref.path);
    if (project.ownerUid !== ownerUid) {
      throw missing;
    }
    return project;
  }
}

