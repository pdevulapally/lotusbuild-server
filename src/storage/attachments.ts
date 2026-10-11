import type { App } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';

/** Hard ceilings for one user attachment. Plans do not vary these yet. */
export const attachmentMaxBytes = 10 * 1024 * 1024;
export const attachmentsPerMessageMax = 5;
export const attachmentNameMaxLength = 200;

export const attachmentImageTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export const attachmentTextTypes = ['text/plain', 'text/markdown', 'text/csv', 'application/json'] as const;
export const attachmentContentTypes = [...attachmentImageTypes, 'application/pdf', ...attachmentTextTypes] as const;
export type AttachmentContentType = (typeof attachmentContentTypes)[number];

export function isAttachmentContentType(value: string): value is AttachmentContentType {
  return (attachmentContentTypes as readonly string[]).includes(value);
}

export interface InspectedAttachment {
  readonly generation: string;
  readonly bytes: number;
  readonly contentType: string;
}

export interface AttachmentStorage {
  createUpload(objectName: string, contentType: AttachmentContentType, bytes: number, expiresAt: Date): Promise<string>;
  inspect(objectName: string): Promise<InspectedAttachment>;
  read(objectName: string, generation: string, maxBytes: number): Promise<Buffer>;
  retire(objectName: string): Promise<void>;
}

export function attachmentObjectName(ownerUid: string, attachmentId: string): string {
  for (const [name, value] of [['owner', ownerUid], ['attachment id', attachmentId]] as const) {
    if (value.trim() === '' || value.includes('/') || value.includes('\\') || value === '.' || value === '..') {
      throw new Error(`An attachment ${name} must be a non-empty path segment.`);
    }
  }
  return `users/${ownerUid}/attachments/${attachmentId}`;
}

/**
 * Private Firebase Storage objects, written once through a short-lived signed
 * URL that fixes content type and length, and read back only by generation so
 * the bytes the model sees are the bytes the ledger inspected.
 */
export class AttachmentStore implements AttachmentStorage {
  readonly #app: App;
  readonly #bucketName: string;

  constructor(app: App, bucketName: string) {
    this.#app = app;
    this.#bucketName = bucketName;
  }

  #bucket() {
    return getStorage(this.#app).bucket(this.#bucketName);
  }

  async createUpload(objectName: string, contentType: AttachmentContentType, bytes: number, expiresAt: Date): Promise<string> {
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > attachmentMaxBytes) throw new Error('Attachment upload needs a bounded positive byte count.');
    if (expiresAt.getTime() <= Date.now()) throw new Error('Attachment upload admission expired.');
    const [url] = await this.#bucket().file(objectName).getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: expiresAt,
      contentType,
      extensionHeaders: { 'x-goog-if-generation-match': '0', 'content-length': String(bytes) },
    });
    return url;
  }

  async inspect(objectName: string): Promise<InspectedAttachment> {
    const [metadata] = await this.#bucket().file(objectName).getMetadata();
    const generation = String(metadata.generation ?? '');
    if (!/^[1-9]\d*$/.test(generation)) throw new Error(`Attachment "${objectName}" has no valid generation.`);
    const bytes = Number(metadata.size);
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error(`Attachment "${objectName}" has no valid byte size.`);
    if (typeof metadata.contentType !== 'string') throw new Error(`Attachment "${objectName}" has no content type.`);
    return { generation, bytes, contentType: metadata.contentType };
  }

  async read(objectName: string, generation: string, maxBytes: number): Promise<Buffer> {
    if (!/^[1-9]\d*$/.test(generation)) throw new Error('Attachment reads require the inspected generation.');
    const file = this.#bucket().file(objectName, { generation: Number(generation) });
    const [metadata] = await file.getMetadata();
    const bytes = Number(metadata.size);
    if (!Number.isSafeInteger(bytes) || bytes > maxBytes) throw new Error(`Attachment "${objectName}" exceeds the readable size.`);
    const [content] = await file.download();
    if (content.byteLength > maxBytes) throw new Error(`Attachment "${objectName}" exceeds the readable size.`);
    return content;
  }

  /** Leave an empty current generation so an outstanding create-only URL cannot resurrect content, then drop the rest. */
  async retire(objectName: string): Promise<void> {
    const file = this.#bucket().file(objectName);
    await file.save(Buffer.alloc(0), { resumable: false, metadata: { contentType: 'application/octet-stream', cacheControl: 'no-store' } });
    const [current] = await file.getMetadata();
    const keep = String(current.generation ?? '');
    let pageToken: string | undefined;
    do {
      const [files, next] = await this.#bucket().getFiles({ prefix: objectName, versions: true, autoPaginate: false, maxResults: 100,
        ...(pageToken === undefined ? {} : { pageToken }) });
      for (const version of files) {
        if (version.name !== objectName || String(version.metadata.generation ?? '') === keep) continue;
        await version.delete({ ignoreNotFound: true });
      }
      pageToken = (next as { pageToken?: string } | undefined)?.pageToken;
    } while (pageToken !== undefined);
  }
}
