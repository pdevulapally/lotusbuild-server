import { randomUUID } from 'node:crypto';

import type { App } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';

import { AppError } from '../http/errors.ts';

/** Image types Claude accepts; nothing else is stored, so nothing else reaches the model. */
export const imageMediaTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export type ImageMediaType = (typeof imageMediaTypes)[number];
/** Claude's own per-image ceiling; larger uploads would fail the whole turn later. */
export const maxAttachmentBytes = 5 * 1024 * 1024;
export const maxAttachmentsPerMessage = 4;
export const attachmentIdPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const attachmentId = new RegExp(attachmentIdPattern);

/** What a message records about an image; the bytes live in Storage. */
export interface AttachmentRef {
  readonly id: string;
  readonly mediaType: ImageMediaType;
}

export interface StoredAttachment extends AttachmentRef {
  readonly bytes: number;
}

export interface AttachmentContent extends AttachmentRef {
  readonly data: Buffer;
}

export function isImageMediaType(value: string): value is ImageMediaType {
  return (imageMediaTypes as readonly string[]).includes(value);
}

/**
 * Rejects a message's attachment list before anything is written. Shape only:
 * whether the objects exist for this owner is `AttachmentStore.assertOwned`'s job.
 */
export function validateAttachmentRefs(refs: readonly AttachmentRef[] | undefined): readonly AttachmentRef[] {
  if (refs === undefined) return [];
  if (refs.length > maxAttachmentsPerMessage) {
    throw new AppError({ code: 'attachment/too-many', statusCode: 400,
      message: `A message can carry at most ${maxAttachmentsPerMessage} images.` });
  }
  const seen = new Set<string>();
  for (const ref of refs) {
    if (!attachmentId.test(ref.id) || !isImageMediaType(ref.mediaType) || seen.has(ref.id)) {
      throw new AppError({ code: 'attachment/invalid', statusCode: 400, message: 'An attachment reference is not valid.' });
    }
    seen.add(ref.id);
  }
  return refs.map((ref) => ({ id: ref.id, mediaType: ref.mediaType }));
}

export interface AttachmentReader {
  read(ownerUid: string, id: string): Promise<AttachmentContent>;
}

/**
 * Images a user attaches to a prompt. Objects are keyed under the owner's uid,
 * so a reference can only ever resolve to that user's own uploads: there is no
 * cross-user path to check, only an existence check.
 */
export class AttachmentStore implements AttachmentReader {
  readonly #app: App;
  readonly #bucketName: string;

  constructor(app: App, bucketName: string) {
    this.#app = app;
    this.#bucketName = bucketName;
  }

  #file(ownerUid: string, id: string) {
    if (!attachmentId.test(id)) throw new AppError({ code: 'attachment/invalid', statusCode: 400, message: 'An attachment reference is not valid.' });
    if (ownerUid.trim() === '' || ownerUid.includes('/')) throw new Error('An attachment owner must be a non-empty path segment.');
    return getStorage(this.#app).bucket(this.#bucketName).file(`attachments/${ownerUid}/${id}`);
  }

  async save(ownerUid: string, mediaType: ImageMediaType, data: Buffer): Promise<StoredAttachment> {
    if (data.byteLength === 0) throw new AppError({ code: 'attachment/empty', statusCode: 400, message: 'The image is empty.' });
    if (data.byteLength > maxAttachmentBytes) {
      throw new AppError({ code: 'attachment/too-large', statusCode: 413, message: 'Images must be 5 MB or smaller.' });
    }
    const id = randomUUID();
    await this.#file(ownerUid, id).save(data, {
      contentType: mediaType,
      resumable: false,
      metadata: { cacheControl: 'private, max-age=0', metadata: { ownerUid } },
    });
    return { id, mediaType, bytes: data.byteLength };
  }

  async read(ownerUid: string, id: string): Promise<AttachmentContent> {
    const file = this.#file(ownerUid, id);
    try {
      const [metadata] = await file.getMetadata();
      const mediaType = String(metadata.contentType ?? '');
      if (!isImageMediaType(mediaType)) throw new Error(`Attachment ${id} has an unexpected content type.`);
      const [data] = await file.download();
      return { id, mediaType, data };
    } catch (error) {
      if ((error as { code?: unknown }).code === 404) {
        throw new AppError({ code: 'attachment/not-found', statusCode: 404, message: 'No such attachment.' });
      }
      throw error;
    }
  }

  /** Every reference must name an upload this owner made; a message never points at a missing image. */
  async assertOwned(ownerUid: string, refs: readonly AttachmentRef[]): Promise<void> {
    await Promise.all(refs.map(async (ref) => {
      const [exists] = await this.#file(ownerUid, ref.id).exists();
      if (!exists) throw new AppError({ code: 'attachment/not-found', statusCode: 404, message: 'No such attachment.' });
    }));
  }
}
