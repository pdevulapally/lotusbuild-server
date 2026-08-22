import { FieldValue, type Firestore, Timestamp } from 'firebase-admin/firestore';

import type { EntitlementService } from '../entitlements/service.ts';
import type { Platform } from '../entitlements/schema.ts';
import { AppError } from '../http/errors.ts';
import { type Fields, enumField, stringField } from '../support/documents.ts';
import type { UserRepository } from '../users/repository.ts';

export const projectsCollectionPath = 'projects';

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
  readonly createdAt: Date;
}

export interface NewProject {
  readonly name: string;
  readonly description: string | undefined;
  readonly platform: Platform;
}

function parseProject(id: string, fields: Fields, where: string): Project {
  const createdAt = fields['createdAt'];
  if (!(createdAt instanceof Timestamp)) {
    throw new AppError({
      code: 'config/malformed-document',
      statusCode: 500,
      message: `${where}: createdAt is not a Firestore timestamp.`,
    });
  }
  const description = fields['description'];
  return {
    id,
    ownerUid: stringField(fields, 'ownerUid', where),
    name: stringField(fields, 'name', where),
    description: typeof description === 'string' && description !== '' ? description : undefined,
    platform: enumField(fields, 'platform', where, ['web', 'mobile']),
    status: enumField(fields, 'status', where, projectStatuses),
    createdAt: createdAt.toDate(),
  };
}

export class ProjectRepository {
  readonly #firestore: Firestore;
  readonly #users: UserRepository;
  readonly #entitlements: EntitlementService;

  constructor(firestore: Firestore, users: UserRepository, entitlements: EntitlementService) {
    this.#firestore = firestore;
    this.#users = users;
    this.#entitlements = entitlements;
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
      createdAt,
    };
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
