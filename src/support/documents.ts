import { Timestamp } from 'firebase-admin/firestore';

import { AppError } from '../http/errors.ts';

/**
 * Firestore hands back `DocumentData` — an untyped bag. Casting it to an
 * interface is a lie the compiler cannot check, so every field a document
 * contributes is read through these accessors instead. They fail with the
 * document path and field name, which is the difference between "a plan is
 * misconfigured" and reading the whole collection by hand to find which one.
 */
export class DocumentShapeError extends AppError {
  constructor(message: string) {
    super({ code: 'config/malformed-document', statusCode: 500, message });
    this.name = 'DocumentShapeError';
  }
}

export type Fields = Readonly<Record<string, unknown>>;

function raw(fields: Fields, name: string, where: string): unknown {
  const value = fields[name];
  if (value === undefined || value === null) {
    throw new DocumentShapeError(`${where}: field "${name}" is missing.`);
  }
  return value;
}

export function stringField(fields: Fields, name: string, where: string): string {
  const value = raw(fields, name, where);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DocumentShapeError(`${where}: field "${name}" must be a non-empty string.`);
  }
  return value;
}

export function booleanField(fields: Fields, name: string, where: string): boolean {
  const value = raw(fields, name, where);
  if (typeof value !== 'boolean') {
    throw new DocumentShapeError(`${where}: field "${name}" must be a boolean.`);
  }
  return value;
}

/**
 * Integers only. Firestore stores every number as a double, so a limit written
 * as 1e21 or 0.5 would otherwise sail through and corrupt an allowance
 * comparison much later.
 */
export function integerField(
  fields: Fields,
  name: string,
  where: string,
  { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER }: { min?: number; max?: number } = {},
): number {
  const value = raw(fields, name, where);
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new DocumentShapeError(`${where}: field "${name}" must be a safe integer.`);
  }
  if (value < min || value > max) {
    throw new DocumentShapeError(`${where}: field "${name}" must be between ${min} and ${max}.`);
  }
  return value;
}

/**
 * A non-negative count, absent meaning none has been recorded. For a stored
 * size that is the same state as zero, so callers are not made to tell apart
 * "no snapshot yet" from "a snapshot of nothing".
 */
export function countField(fields: Fields, name: string, where: string): number {
  const value = fields[name];
  return value === undefined || value === null
    ? 0
    : integerField(fields, name, where, { min: 0 });
}

export function timestampField(fields: Fields, name: string, where: string): Date {
  const value = raw(fields, name, where);
  if (!(value instanceof Timestamp)) {
    throw new DocumentShapeError(`${where}: field "${name}" must be a Firestore timestamp.`);
  }
  const date = value.toDate();
  if (Number.isNaN(date.getTime())) {
    throw new DocumentShapeError(`${where}: field "${name}" is not a valid instant.`);
  }
  return date;
}

/**
 * For fields whose absence is meaningful rather than broken — a heartbeat on a
 * session nobody has claimed, an end date on something still open. A present
 * but malformed value is still an error: only "not there" is acceptable.
 */
export function optionalTimestampField(
  fields: Fields,
  name: string,
  where: string,
): Date | undefined {
  const value = fields[name];
  return value === undefined || value === null ? undefined : timestampField(fields, name, where);
}

export function optionalStringField(fields: Fields, name: string): string | undefined {
  const value = fields[name];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * A list of strings, absent meaning empty. Used for the ids a runner is holding:
 * "nothing recorded" and "holding nothing" are the same state, and a caller that
 * had to tell them apart would be reasoning about a distinction with no meaning.
 */
export function stringArrayField(fields: Fields, name: string, where: string): readonly string[] {
  const value = fields[name];
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new DocumentShapeError(`${where}: field "${name}" must be an array of strings.`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new DocumentShapeError(`${where}: ${name}[${index}] must be a non-empty string.`);
    }
    return entry;
  });
}

export function enumField<const T extends readonly [string, ...string[]]>(
  fields: Fields,
  name: string,
  where: string,
  allowed: T,
): T[number] {
  const value = stringField(fields, name, where);
  if (!allowed.includes(value)) {
    throw new DocumentShapeError(
      `${where}: field "${name}" must be one of ${allowed.join(', ')}, got "${value}".`,
    );
  }
  return value as T[number];
}

export function objectArrayField(fields: Fields, name: string, where: string): readonly Fields[] {
  const value = raw(fields, name, where);
  if (!Array.isArray(value)) {
    throw new DocumentShapeError(`${where}: field "${name}" must be an array.`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new DocumentShapeError(`${where}: ${name}[${index}] must be an object.`);
    }
    return entry as Fields;
  });
}

/**
 * Indexes parsed entries by key, refusing duplicates. A repeated key in a
 * configuration array otherwise resolves to whichever entry happened to be last.
 */
export function indexByKey<T>(
  entries: readonly T[],
  keyOf: (entry: T) => string,
  where: string,
): ReadonlyMap<string, T> {
  const byKey = new Map<string, T>();
  for (const entry of entries) {
    const key = keyOf(entry);
    if (byKey.has(key)) {
      throw new DocumentShapeError(`${where}: "${key}" appears more than once.`);
    }
    byKey.set(key, entry);
  }
  return byKey;
}
