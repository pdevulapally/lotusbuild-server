import type { App } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';

import { EnvironmentError } from '../config/env.ts';
import { AppError } from '../http/errors.ts';

/**
 * A project's durable state is one object: the gzipped `.git` directory from
 * its last session.
 *
 * Only `.git` is kept, and that is the whole design. What belongs in the
 * snapshot is exactly what the project's own `.gitignore` says belongs in it,
 * so `node_modules` — bigger than everything else together and reinstallable
 * from a lockfile — is excluded without this code holding a list of things to
 * skip that would go stale the moment a project used a different toolchain.
 */
export const snapshotContentType = 'application/gzip';

export type StoredSnapshot =
  | { readonly kind: 'none' }
  | { readonly kind: 'legacy' }
  | {
      readonly kind: 'immutable';
      readonly objectName: string;
      readonly generation: string;
    };

/**
 * A snapshot the project document asserts exists. Distinguished from
 * `StoredSnapshot` so that "Storage has nothing" and "this project never had
 * anything" cannot be confused: only the `none` case may end in a fresh
 * repository, and it is the one case this type cannot hold.
 */
export type PersistedSnapshot = Exclude<StoredSnapshot, { readonly kind: 'none' }>;

export interface SnapshotUpload {
  readonly objectName: string;
  readonly url: string;
}

export interface UploadedSnapshot {
  readonly objectName: string;
  readonly generation: string;
  readonly bytes: number;
}

export interface SnapshotStorage {
  readUrl(projectId: string, snapshot: PersistedSnapshot): Promise<string>;
  createUpload(projectId: string, leaseToken: string): Promise<SnapshotUpload>;
  inspectUpload(objectName: string): Promise<UploadedSnapshot>;
  removeStored(projectId: string, snapshot: StoredSnapshot): Promise<void>;
}

/**
 * The project's durable state names a snapshot that Storage cannot produce.
 *
 * Deliberately not a 404: the project itself is fine and the user did nothing
 * wrong — its backing object is missing, which is ours to explain and ours to
 * recover, by an administrative route that does not exist yet and must not be
 * improvised at build time. The diagnostic context stays in `details`, and the
 * object name stays out of it: a candidate object is named after the lease
 * token that wrote it.
 */
export function missingSnapshotError(projectId: string, snapshot: PersistedSnapshot): AppError {
  return new AppError({
    code: 'project/snapshot-missing',
    statusCode: 500,
    message: 'The saved project could not be restored.',
    details: {
      projectId,
      snapshot: snapshot.kind,
      ...(snapshot.kind === 'immutable' ? { generation: snapshot.generation } : {}),
    },
  });
}

export class SnapshotStore implements SnapshotStorage {
  readonly #bucketName: string;
  readonly #ttlSeconds: number;
  readonly #app: App;

  constructor(app: App, bucketName: string, ttlSeconds: number) {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new Error(`A signed URL lifetime must be a positive number of seconds.`);
    }
    this.#app = app;
    this.#bucketName = bucketName;
    this.#ttlSeconds = ttlSeconds;
  }

  #bucket() {
    return getStorage(this.#app).bucket(this.#bucketName);
  }

  #legacyFile(projectId: string) {
    return this.#bucket().file(`projects/${projectId}/repo.tar.gz`);
  }

  #candidateName(projectId: string, leaseToken: string): string {
    for (const [name, value] of [
      ['projectId', projectId],
      ['leaseToken', leaseToken],
    ] as const) {
      if (value.trim() === '' || value.includes('/') || value.includes('\\')) {
        throw new Error(`A snapshot ${name} must be a non-empty path segment.`);
      }
    }
    return `projects/${projectId}/snapshots/${leaseToken}.tar.gz`;
  }

  #expiry(): number {
    return Date.now() + this.#ttlSeconds * 1000;
  }

  /**
   * Proves the bucket is there before the runner claims any work. A missing
   * bucket discovered at save time means a build that ran, cost money and threw
   * its result away.
   */
  async assertReachable(): Promise<void> {
    const bucket = this.#bucket();
    let exists: boolean;
    try {
      [exists] = await bucket.exists();
    } catch (cause) {
      throw new EnvironmentError([
        `FIREBASE_STORAGE_BUCKET "${this.#bucketName}" could not be reached — ` +
          `${cause instanceof Error ? cause.message : String(cause)}`,
      ]);
    }
    if (!exists) {
      throw new EnvironmentError([
        `FIREBASE_STORAGE_BUCKET "${this.#bucketName}" does not exist, so no project could be ` +
          'saved.',
      ]);
    }
  }

  /**
   * A URL the sandbox can fetch the recorded snapshot from.
   *
   * The project document is the authority on whether a snapshot exists, and it
   * has already said one does — a project that has never been saved carries
   * `none` and never reaches here. So an object that is absent, or an immutable
   * generation that is gone, is a broken invariant rather than an empty project,
   * and the only safe answer is to stop. Returning "nothing here" would hand the
   * agent a fresh repository and let the next save publish it over history the
   * user still owns.
   */
  async readUrl(projectId: string, snapshot: PersistedSnapshot): Promise<string> {
    // For an immutable snapshot the generation is part of the reference, so this
    // asks whether that exact version exists — never whether the name is taken.
    const file =
      snapshot.kind === 'legacy'
        ? this.#legacyFile(projectId)
        : this.#bucket().file(snapshot.objectName, { generation: snapshot.generation });
    const [exists] = await file.exists();
    if (!exists) {
      throw missingSnapshotError(projectId, snapshot);
    }
    const [url] = await file.getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: this.#expiry(),
    });
    return url;
  }

  /**
   * A URL the sandbox can PUT the new snapshot to.
   *
   * The signature covers the content type, so the upload must send the same
   * header or the bucket refuses it — which is what stops a leaked URL being
   * used to store something else.
   */
  async createUpload(projectId: string, leaseToken: string): Promise<SnapshotUpload> {
    const objectName = this.#candidateName(projectId, leaseToken);
    const [url] = await this.#bucket().file(objectName).getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: this.#expiry(),
      contentType: snapshotContentType,
      extensionHeaders: {
        'x-goog-if-generation-match': '0',
      },
    });
    return { objectName, url };
  }

  async inspectUpload(objectName: string): Promise<UploadedSnapshot> {
    const [metadata] = await this.#bucket().file(objectName).getMetadata();
    const generation = metadata.generation;
    const generationText =
      typeof generation === 'string' || typeof generation === 'number' ? String(generation) : '';
    if (
      (typeof generation !== 'string' && typeof generation !== 'number') ||
      !/^[1-9]\d*$/.test(generationText)
    ) {
      throw new Error(`Snapshot object "${objectName}" has no valid generation.`);
    }
    const storedSize = metadata.size;
    const bytes =
      typeof storedSize === 'string' && /^\d+$/.test(storedSize)
        ? Number(storedSize)
        : typeof storedSize === 'number'
          ? storedSize
          : Number.NaN;
    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
      throw new Error(`Snapshot object "${objectName}" has no valid byte size.`);
    }
    if (metadata.contentType !== snapshotContentType) {
      throw new Error(
        `Snapshot object "${objectName}" has content type "${String(metadata.contentType)}" rather than "${snapshotContentType}".`,
      );
    }
    return { objectName, generation: generationText, bytes };
  }

  async removeStored(projectId: string, snapshot: StoredSnapshot): Promise<void> {
    if (snapshot.kind === 'none') {
      return;
    }
    const file =
      snapshot.kind === 'legacy'
        ? this.#legacyFile(projectId)
        : this.#bucket().file(snapshot.objectName, { generation: snapshot.generation });
    await file.delete({
      ignoreNotFound: true,
      ...(snapshot.kind === 'immutable' ? { ifGenerationMatch: snapshot.generation } : {}),
    });
  }

  /** For when a project is deleted and its storage must stop being charged. */
  async remove(projectId: string): Promise<void> {
    await this.#legacyFile(projectId).delete({ ignoreNotFound: true });
    await this.#bucket().deleteFiles({ prefix: `projects/${projectId}/snapshots/` });
  }
}
