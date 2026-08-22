import { AppError } from '../http/errors.ts';

/**
 * Entitlement values are stored as a tagged object — `{"kind":"number","value":3}`
 * — rather than a bare JSON value. The tag is what lets a capability's declared
 * kind be checked against what is actually stored, so a plan configured with a
 * string where a number belongs fails when the configuration is read rather than
 * at the point some caller does arithmetic on it.
 */
export const entitlementValueKinds = ['boolean', 'number', 'string', 'stringList'] as const;
export type EntitlementValueKind = (typeof entitlementValueKinds)[number];

export type EntitlementValue =
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'stringList'; readonly value: readonly string[] };

export class EntitlementConfigError extends AppError {
  constructor(message: string) {
    super({ code: 'entitlement/misconfigured', statusCode: 500, message });
    this.name = 'EntitlementConfigError';
  }
}

const validators: Readonly<Record<EntitlementValueKind, (value: unknown) => boolean>> = {
  boolean: (value) => typeof value === 'boolean',
  // Rejects NaN and Infinity: both survive JSON round-trips through some clients
  // and would silently poison a limit comparison.
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  string: (value) => typeof value === 'string',
  stringList: (value) => Array.isArray(value) && value.every((item) => typeof item === 'string'),
};

function isKind(value: unknown): value is EntitlementValueKind {
  return typeof value === 'string' && (entitlementValueKinds as readonly string[]).includes(value);
}

/**
 * Parses one stored entitlement value, checking it against the kind its
 * capability declares. `where` names the row so a misconfiguration points at the
 * document that carries it instead of at this function.
 */
export function parseEntitlementValue(
  stored: unknown,
  expectedKind: EntitlementValueKind,
  where: string,
): EntitlementValue {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
    throw new EntitlementConfigError(`${where}: expected an object of the form {kind, value}.`);
  }

  const { kind, value } = stored as { kind?: unknown; value?: unknown };

  if (!isKind(kind)) {
    throw new EntitlementConfigError(
      `${where}: "kind" must be one of ${entitlementValueKinds.join(', ')}, got ${JSON.stringify(kind)}.`,
    );
  }

  if (kind !== expectedKind) {
    throw new EntitlementConfigError(
      `${where}: the capability declares kind "${expectedKind}" but this value is "${kind}".`,
    );
  }

  if (!validators[kind](value)) {
    throw new EntitlementConfigError(
      `${where}: ${JSON.stringify(value)} is not a valid ${kind}.`,
    );
  }

  // Lists are frozen and de-duplicated so downstream set operations cannot be
  // skewed by a repeated entry and no caller can mutate shared configuration.
  if (kind === 'stringList') {
    return { kind, value: Object.freeze([...new Set(value as readonly string[])]) };
  }
  return { kind, value } as EntitlementValue;
}
