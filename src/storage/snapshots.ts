import type { App } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';

import { EnvironmentError } from '../config/env.ts';

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

export class SnapshotStore {
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

  #file(projectId: string) {
    // One object per project, overwritten each session. History lives inside the
    // archive as git commits, so keeping old objects would duplicate it.
    return getStorage(this.#app).bucket(this.#bucketName).file(`projects/${projectId}/repo.tar.gz`);
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
    const bucket = getStorage(this.#app).bucket(this.#bucketName);
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
   * A URL the sandbox can fetch the snapshot from, or undefined when the project
   * has never been saved. Absent is the ordinary state of a new project, not a
   * failure.
   */
  async readUrl(projectId: string): Promise<string | undefined> {
    const file = this.#file(projectId);
    const [exists] = await file.exists();
    if (!exists) {
      return undefined;
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
  async writeUrl(projectId: string): Promise<string> {
    const [url] = await this.#file(projectId).getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: this.#expiry(),
      contentType: snapshotContentType,
    });
    return url;
  }

  /** For when a project is deleted and its storage must stop being charged. */
  async remove(projectId: string): Promise<void> {
    await this.#file(projectId).delete({ ignoreNotFound: true });
  }
}
