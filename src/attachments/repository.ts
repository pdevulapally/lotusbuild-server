import { randomUUID } from 'node:crypto';

import { FieldValue, Timestamp, type Firestore, type Transaction } from 'firebase-admin/firestore';

import type { EntitlementService } from '../entitlements/service.ts';
import type { ConfigurationStore } from '../entitlements/store.ts';
import { AppError } from '../http/errors.ts';
import type { MeteringService } from '../metering/service.ts';
import type { ProjectRepository } from '../projects/repository.ts';
import {
  type AttachmentContentType,
  type AttachmentStorage,
  attachmentMaxBytes,
  attachmentNameMaxLength,
  attachmentObjectName,
  attachmentsPerMessageMax,
  isAttachmentContentType,
} from '../storage/attachments.ts';
import {
  type Fields,
  enumField,
  integerField,
  objectArrayField,
  optionalStringField,
  stringField,
  timestampField,
} from '../support/documents.ts';

export const attachmentsCollectionPath = 'attachments';
export const attachmentStatuses = ['CANDIDATE', 'READY', 'ATTACHED', 'RETIRED'] as const;
export type AttachmentStatus = (typeof attachmentStatuses)[number];

export interface Attachment {
  readonly id: string;
  readonly ownerUid: string;
  readonly projectId: string;
  readonly name: string;
  readonly contentType: AttachmentContentType;
  readonly bytes: number;
  readonly status: AttachmentStatus;
  readonly objectName: string;
  readonly generation: string | undefined;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

/** What a message durably records about each file sent with it. */
export interface MessageAttachment {
  readonly id: string;
  readonly name: string;
  readonly contentType: AttachmentContentType;
  readonly bytes: number;
  readonly objectName: string;
  readonly generation: string;
}

export interface NewAttachment {
  readonly name: string;
  readonly contentType: string;
  readonly bytes: number;
}

const printableName = /^[^\u0000-\u001F\u007F/\\]+$/u;

function parseAttachment(id: string, fields: Fields, where: string): Attachment {
  const contentType = stringField(fields, 'contentType', where);
  if (!isAttachmentContentType(contentType)) throw new Error(`Attachment ${where} has an unsupported content type.`);
  return {
    id,
    ownerUid: stringField(fields, 'ownerUid', where),
    projectId: stringField(fields, 'projectId', where),
    name: stringField(fields, 'name', where),
    contentType,
    bytes: integerField(fields, 'bytes', where, { min: 1 }),
    status: enumField(fields, 'status', where, attachmentStatuses),
    objectName: stringField(fields, 'objectName', where),
    generation: optionalStringField(fields, 'generation'),
    expiresAt: timestampField(fields, 'expiresAt', where),
    createdAt: fields['createdAt'] === undefined ? new Date() : timestampField(fields, 'createdAt', where),
  };
}

export function parseMessageAttachments(fields: Fields, where: string): readonly MessageAttachment[] | undefined {
  if (fields['attachments'] === undefined) return undefined;
  return objectArrayField(fields, 'attachments', where).map((entry, index) => {
    const at = `${where}.attachments[${index}]`;
    const contentType = stringField(entry, 'contentType', at);
    if (!isAttachmentContentType(contentType)) throw new Error(`${at} has an unsupported content type.`);
    return {
      id: stringField(entry, 'id', at),
      name: stringField(entry, 'name', at),
      contentType,
      bytes: integerField(entry, 'bytes', at, { min: 1 }),
      objectName: stringField(entry, 'objectName', at),
      generation: stringField(entry, 'generation', at),
    };
  });
}

function notFound(): AppError {
  return new AppError({ code: 'attachment/not-found', statusCode: 404, message: 'No such attachment.' });
}

/**
 * User files that travel with a prompt. The object is private; the record here
 * is what grants a session the right to read it, and only once it is READY —
 * inspected against trusted Storage metadata and charged to the storage meter.
 */
export class AttachmentRepository {
  readonly #firestore: Firestore;
  readonly #projects: ProjectRepository;
  readonly #entitlements: EntitlementService;
  readonly #metering: MeteringService;
  readonly #configuration: ConfigurationStore;
  readonly #storage: AttachmentStorage;
  readonly #uploadTtlSeconds: number;

  constructor(firestore: Firestore, projects: ProjectRepository, entitlements: EntitlementService,
    metering: MeteringService, configuration: ConfigurationStore, storage: AttachmentStorage, uploadTtlSeconds: number) {
    if (!Number.isSafeInteger(uploadTtlSeconds) || uploadTtlSeconds <= 0) throw new Error('An upload lifetime must be a positive number of seconds.');
    this.#firestore = firestore;
    this.#projects = projects;
    this.#entitlements = entitlements;
    this.#metering = metering;
    this.#configuration = configuration;
    this.#storage = storage;
    this.#uploadTtlSeconds = uploadTtlSeconds;
  }

  #ref(id: string) {
    return this.#firestore.collection(attachmentsCollectionPath).doc(id);
  }

  static validate(input: NewAttachment): asserts input is NewAttachment & { contentType: AttachmentContentType } {
    if (input.name.length === 0 || input.name.length > attachmentNameMaxLength || !printableName.test(input.name)) {
      throw new AppError({ code: 'attachment/invalid-name', statusCode: 400, message: 'An attachment name must be a single printable line without slashes.' });
    }
    if (!isAttachmentContentType(input.contentType)) {
      throw new AppError({ code: 'attachment/unsupported-type', statusCode: 415, message: 'This file type cannot be attached.',
        details: { contentType: input.contentType } });
    }
    if (!Number.isSafeInteger(input.bytes) || input.bytes <= 0 || input.bytes > attachmentMaxBytes) {
      throw new AppError({ code: 'attachment/too-large', statusCode: 413, message: 'An attachment must be between 1 byte and the size limit.',
        details: { maxBytes: attachmentMaxBytes } });
    }
  }

  /** Admits an upload: reserves its bytes and hands back a create-only signed URL. */
  async begin(uid: string, projectId: string, input: NewAttachment): Promise<{ readonly attachment: Attachment; readonly uploadUrl: string }> {
    AttachmentRepository.validate(input);
    const project = await this.#projects.readOwned(uid, projectId);
    const entitlements = await this.#entitlements.forUser(uid);
    const { registry } = await this.#configuration.get();
    const id = randomUUID();
    const objectName = attachmentObjectName(uid, id);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.#uploadTtlSeconds * 1000);
    const ref = this.#ref(id);
    await this.#firestore.runTransaction(async (transaction) => {
      await this.#projects.readOwnedInTransaction(transaction, uid, project.id);
      const reservation = await this.#metering.reserveIn(transaction, { uid, entitlements, meterKey: registry.storageMeterKey,
        quantity: input.bytes, operationId: `attachment:${id}`, now });
      transaction.create(ref, {
        ownerUid: uid, projectId: project.id, name: input.name, contentType: input.contentType, bytes: input.bytes,
        objectName, status: 'CANDIDATE', reservationId: reservation.id, expiresAt: Timestamp.fromDate(expiresAt),
        createdAt: FieldValue.serverTimestamp(),
      });
    });
    const uploadUrl = await this.#storage.createUpload(objectName, input.contentType, input.bytes, expiresAt);
    return {
      attachment: { id, ownerUid: uid, projectId: project.id, name: input.name, contentType: input.contentType, bytes: input.bytes,
        status: 'CANDIDATE', objectName, generation: undefined, expiresAt, createdAt: now },
      uploadUrl,
    };
  }

  async readOwned(uid: string, id: string): Promise<Attachment> {
    const ref = this.#ref(id);
    const snapshot = await ref.get();
    if (!snapshot.exists) throw notFound();
    const attachment = parseAttachment(snapshot.id, snapshot.data() ?? {}, ref.path);
    if (attachment.ownerUid !== uid) throw notFound();
    return attachment;
  }

  /** Confirms the upload from Storage metadata and charges the bytes. */
  async complete(uid: string, id: string): Promise<Attachment> {
    const attachment = await this.readOwned(uid, id);
    if (attachment.status !== 'CANDIDATE') {
      if (attachment.status === 'RETIRED') throw notFound();
      return attachment;
    }
    if (attachment.expiresAt.getTime() <= Date.now()) {
      throw new AppError({ code: 'attachment/upload-expired', statusCode: 410, message: 'This upload window has closed. Start the attachment again.' });
    }
    let inspected;
    try { inspected = await this.#storage.inspect(attachment.objectName); }
    catch { throw new AppError({ code: 'attachment/not-uploaded', statusCode: 409, message: 'The file has not been uploaded yet.' }); }
    if (inspected.bytes !== attachment.bytes || inspected.contentType !== attachment.contentType) {
      throw new AppError({ code: 'attachment/upload-mismatch', statusCode: 409, message: 'The uploaded file does not match what was declared.' });
    }
    const ref = this.#ref(id);
    return this.#firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const fields = snapshot.data() ?? {};
      const current = parseAttachment(snapshot.id, fields, ref.path);
      if (current.ownerUid !== uid) throw notFound();
      if (current.status !== 'CANDIDATE') return current;
      await this.#metering.commitStorageIn(transaction, uid, stringField(fields, 'reservationId', ref.path), current.bytes);
      transaction.update(ref, { status: 'READY', generation: inspected.generation, updatedAt: FieldValue.serverTimestamp() });
      return { ...current, status: 'READY', generation: inspected.generation };
    });
  }

  /** Releases a file that no message has claimed. */
  async remove(uid: string, id: string): Promise<void> {
    const ref = this.#ref(id);
    const now = new Date();
    const retired = await this.#firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw notFound();
      const fields = snapshot.data() ?? {};
      const current = parseAttachment(snapshot.id, fields, ref.path);
      if (current.ownerUid !== uid || current.status === 'RETIRED') throw notFound();
      if (current.status === 'ATTACHED') {
        throw new AppError({ code: 'attachment/in-use', statusCode: 409, message: 'This attachment is part of a message and stays with it.' });
      }
      if (current.status === 'READY') await this.#metering.removeStoredBytesIn(transaction, uid, current.bytes);
      else await this.#metering.releaseIn(transaction, uid, [stringField(fields, 'reservationId', ref.path)], now);
      transaction.update(ref, { status: 'RETIRED', updatedAt: FieldValue.serverTimestamp() });
      return current;
    });
    await this.#storage.retire(retired.objectName);
  }

  /**
   * Binds READY attachments to the message being written in `transaction`.
   * Reads happen before the caller's writes; the status flip is a write the
   * caller's commit carries, so a lost message never strands a claimed file.
   */
  async claimIn(transaction: Transaction, uid: string, projectId: string, ids: readonly string[]): Promise<readonly MessageAttachment[]> {
    const unique = [...new Set(ids)];
    if (unique.length !== ids.length) {
      throw new AppError({ code: 'attachment/duplicate', statusCode: 400, message: 'Each attachment may be sent once per message.' });
    }
    if (unique.length > attachmentsPerMessageMax) {
      throw new AppError({ code: 'attachment/too-many', statusCode: 400, message: 'Too many attachments for one message.',
        details: { maxPerMessage: attachmentsPerMessageMax } });
    }
    const claimed: MessageAttachment[] = [];
    const refs = unique.map((id) => this.#ref(id));
    const snapshots = await Promise.all(refs.map((ref) => transaction.get(ref)));
    snapshots.forEach((snapshot, index) => {
      const ref = refs[index]!;
      if (!snapshot.exists) throw notFound();
      const attachment = parseAttachment(snapshot.id, snapshot.data() ?? {}, ref.path);
      if (attachment.ownerUid !== uid || attachment.projectId !== projectId) throw notFound();
      if (attachment.status !== 'READY' || attachment.generation === undefined) {
        throw new AppError({ code: 'attachment/not-ready', statusCode: 409, message: 'Finish uploading every attachment before sending.',
          details: { attachmentId: attachment.id, status: attachment.status } });
      }
      claimed.push({ id: attachment.id, name: attachment.name, contentType: attachment.contentType, bytes: attachment.bytes,
        objectName: attachment.objectName, generation: attachment.generation });
    });
    for (const ref of refs) transaction.update(ref, { status: 'ATTACHED', attachedAt: FieldValue.serverTimestamp() });
    return claimed;
  }
}
