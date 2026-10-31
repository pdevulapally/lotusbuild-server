import { parseTaskContext, type TaskContext } from './task-context.ts';
import { createHash } from 'node:crypto';
import type { MessageCountTokensParams, MessageParam, ToolUnion } from '@anthropic-ai/sdk/resources/messages';
import { AppError } from '../http/errors.ts';
import { integerField, stringArrayField, stringField, type Fields } from '../support/documents.ts';

// Protocol ceiling below the Firestore document limit; this is not a commercial allowance.
export const continuationProtocolMaxBytes = 750000;
/** User-approved maximum on 2026-10-31. Retries never renew the original image deadline. */
export const screenshotCheckpointRetentionMs = 7 * 24 * 60 * 60 * 1000;

export interface ContinuationCheckpoint {
  readonly protocol: 1;
  readonly taskContext?: TaskContext;
  readonly restoredEnvironment?: boolean;
  readonly imageRetainedAt?: string;
  readonly imageExpiresAt?: string;
  readonly conversation: MessageParam[];
  readonly spoken: string[];
  readonly completedSteps: number;
  readonly consultations: number;
  readonly maxOutputTokens: number;
  readonly maxSteps: number;
  readonly maxConsultations: number;
  readonly contextFingerprint: string;
  readonly request: Omit<MessageCountTokensParams, 'messages'>;
}

export interface AdmissionBoundary {
  readonly conversation: MessageParam[];
  readonly spoken: string[];
  readonly completedSteps: number;
  readonly request: MessageCountTokensParams;
}

export function contextFingerprint(system: unknown, tools: readonly ToolUnion[]): string {
  return createHash('sha256').update(JSON.stringify([system, tools])).digest('hex');
}

/** Only raised before generation dispatch, after the preceding tool batch fully completed. */
export class ContinuationPause extends Error {
  readonly checkpoint: ContinuationCheckpoint;
  readonly reason: AppError;
  constructor(checkpoint: ContinuationCheckpoint, reason: AppError) {
    super('The task is paused at a verified model admission boundary.');
    this.checkpoint = checkpoint; this.reason = reason;
  }
}

function object(value: unknown): Fields {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid continuation object.');
  return value as Fields;
}

function validateImage(value: Fields): void {
  const source = object(value['source']);
  if (source['type'] !== 'base64' || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(String(source['media_type']))) throw new Error('Only embedded supported images may be retained.');
  const data = stringField(source, 'data', 'image checkpoint');
  if (Buffer.from(data, 'base64').toString('base64') !== data) throw new Error('Invalid checkpoint image encoding.');
}

export function checkpointHasImages(checkpoint: Pick<ContinuationCheckpoint, 'conversation'>): boolean {
  return checkpoint.conversation.some((message) => Array.isArray(message.content) && message.content.some((block) =>
    block.type === 'image' || (block.type === 'tool_result' && Array.isArray(block.content) && block.content.some((nested) => nested.type === 'image'))));
}

export function retainCheckpointImages(checkpoint: ContinuationCheckpoint, now = new Date()): ContinuationCheckpoint {
  if (!checkpointHasImages(checkpoint)) { const { imageRetainedAt: _retained, imageExpiresAt: _expires, ...textOnly } = checkpoint; return textOnly; }
  if (checkpoint.imageRetainedAt !== undefined || checkpoint.imageExpiresAt !== undefined) {
    if (checkpoint.imageRetainedAt === undefined || checkpoint.imageExpiresAt === undefined) throw new Error('The original image retention deadline is missing.');
    return checkpoint;
  }
  return { ...checkpoint, imageRetainedAt: now.toISOString(), imageExpiresAt: new Date(now.getTime() + screenshotCheckpointRetentionMs).toISOString() };
}

/** Refuse opaque provider state (including signed thinking), rather than pretending it is portable. */
function validateConversation(value: unknown): asserts value is MessageParam[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('Missing continuation conversation.');
  const pending = new Set<string>();
  for (const message of value) {
    const fields = object(message);
    if (fields['role'] !== 'user' && fields['role'] !== 'assistant') throw new Error('Invalid continuation role.');
    const content = fields['content'];
    if (typeof content === 'string') { if (pending.size > 0) throw new Error('Unresolved tool calls in continuation.'); continue; }
    if (!Array.isArray(content)) throw new Error('Invalid continuation content.');
    for (const part of content) {
      const block = object(part);
      switch (block['type']) {
        case 'text': stringField(block, 'text', 'continuation'); break;
        case 'image': validateImage(block); break;
        case 'tool_use': {
          if (fields['role'] !== 'assistant') throw new Error('Invalid tool call role.');
          const id = stringField(block, 'id', 'continuation');
          if (pending.has(id)) throw new Error('Duplicate unresolved tool call.');
          stringField(block, 'name', 'continuation'); object(block['input']); pending.add(id); break;
        }
        case 'tool_result': {
          if (fields['role'] !== 'user' || !pending.delete(stringField(block, 'tool_use_id', 'continuation'))) throw new Error('Unmatched tool result.');
          if (typeof block['content'] !== 'string') {
            if (!Array.isArray(block['content'])) throw new Error('Invalid tool result content.');
            for (const nested of block['content']) {
              const item = object(nested);
              if (item['type'] === 'image') validateImage(item);
              else if (item['type'] !== 'text') throw new Error('Provider-specific tool output is not portable.');
            }
          }
          break;
        }
        default: throw new Error('The conversation contains provider state that cannot safely switch models.');
      }
    }
  }
  if (pending.size > 0) throw new Error('A consequential tool action is still unresolved.');
}

export function serializeCheckpoint(checkpoint: ContinuationCheckpoint, maximum: number): string {
  const serialized = JSON.stringify(checkpoint);
  if (Buffer.byteLength(serialized) > maximum) throw new Error('The continuation exceeds its configured storage budget.');
  parseCheckpoint(serialized, maximum);
  return serialized;
}

export function parseCheckpoint(serialized: string, maximum: number): ContinuationCheckpoint {
  if (Buffer.byteLength(serialized) > maximum) throw new Error('The continuation exceeds its configured storage budget.');
  const fields = object(JSON.parse(serialized));
  if (fields['protocol'] !== 1) throw new Error('Unsupported continuation protocol.');
  validateConversation(fields['conversation']);
  const request = object(fields['request']);
  if (!Array.isArray(request['tools']) || typeof request['system'] !== 'string' || typeof request['model'] !== 'string') throw new Error('Invalid continuation request.');
  if (fields['restoredEnvironment'] !== undefined && typeof fields['restoredEnvironment'] !== 'boolean') throw new Error('Invalid continuation environment marker.');
  const fingerprint = stringField(fields, 'contextFingerprint', 'continuation');
  if (fingerprint !== contextFingerprint(request['system'], request['tools'])) throw new Error('Continuation policy fingerprint disagrees.');
  if ('messages' in request || !Array.isArray(fields['spoken'])) throw new Error('Invalid continuation envelope.');
  const maxSteps = integerField(fields, 'maxSteps', 'continuation', { min: 1 });
  const completedSteps = integerField(fields, 'completedSteps', 'continuation', { min: 0, max: maxSteps - 1 });
  const maxConsultations = integerField(fields, 'maxConsultations', 'continuation', { min: 0 });
  const consultations = integerField(fields, 'consultations', 'continuation', { min: 0, max: maxConsultations });
  const imageRetainedAt = fields['imageRetainedAt']; const imageExpiresAt = fields['imageExpiresAt'];
  if (checkpointHasImages({ conversation: fields['conversation'] })) {
    if (typeof imageRetainedAt !== 'string' || typeof imageExpiresAt !== 'string' || !Number.isFinite(Date.parse(imageRetainedAt)) || !Number.isFinite(Date.parse(imageExpiresAt)) ||
        Date.parse(imageExpiresAt) <= Date.parse(imageRetainedAt) || Date.parse(imageExpiresAt) - Date.parse(imageRetainedAt) > screenshotCheckpointRetentionMs) throw new Error('A bounded original screenshot retention deadline is required.');
    if (Date.parse(imageExpiresAt) <= Date.now()) throw new AppError({ code: 'fallback/image-context-expired', statusCode: 409, message: 'Saved screenshot context expired. Fresh context is required before continuing.' });
  } else if (imageRetainedAt !== undefined || imageExpiresAt !== undefined) throw new Error('Image retention metadata does not match the checkpoint.');
  return { protocol: 1, ...(fields['taskContext'] === undefined ? {} : { taskContext: parseTaskContext(fields['taskContext']) }), ...(fields['restoredEnvironment'] === true ? { restoredEnvironment: true } : {}),
    ...(typeof imageRetainedAt === 'string' && typeof imageExpiresAt === 'string' ? { imageRetainedAt, imageExpiresAt } : {}), conversation: fields['conversation'], spoken: [...stringArrayField(fields, 'spoken', 'continuation')],
    completedSteps, consultations, maxOutputTokens: integerField(fields, 'maxOutputTokens', 'continuation', { min: 1 }), maxSteps, maxConsultations, contextFingerprint: fingerprint,
    // This server-owned request is only counted; stored tool definitions never become executable tools.
    request: request as unknown as Omit<MessageCountTokensParams, 'messages'> };
}
