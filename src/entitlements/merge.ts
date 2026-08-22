import {
  EntitlementConfigError,
  type EntitlementValue,
  type EntitlementValueKind,
} from './values.ts';

export const mergeStrategies = [
  'OVERRIDE',
  'ADD',
  'MAX',
  'MIN',
  'UNION',
  'INTERSECTION',
  'HARD_DENY',
] as const;
export type MergeStrategy = (typeof mergeStrategies)[number];

export interface CapabilityDefinition {
  readonly key: string;
  readonly valueKind: EntitlementValueKind;
  readonly mergeStrategy: MergeStrategy;
}

/** One source's opinion about one capability. */
export interface EntitlementContribution {
  readonly sourceKey: string;
  /** Higher applies later, so it wins an OVERRIDE. Unique across sources. */
  readonly precedence: number;
  readonly value: EntitlementValue;
}

type Fold = (left: EntitlementValue, right: EntitlementValue) => EntitlementValue;

interface StrategyDefinition {
  readonly supports: readonly EntitlementValueKind[];
  readonly fold: Fold;
  /** Set when a strategy supports nothing, so the refusal explains itself. */
  readonly unavailable?: string;
}

function asList(value: EntitlementValue): readonly string[] {
  return value.value as readonly string[];
}

/**
 * How two contributions combine. Which strategy a capability uses is data, not a
 * branch here: adding a capability is a configuration change, never a code one.
 *
 * The *direction* of each strategy is the security-critical part. `MAX` on a
 * boolean is how `ai.run` lets an extra grant enable a capability but never
 * revoke one; `INTERSECTION` is how `ai.model.allowlist` lets a source narrow
 * the permitted set but never widen it. Reversing either is privilege
 * escalation, not a cosmetic difference — which is why each is tested in both
 * directions rather than only on the happy path.
 */
const strategies: Readonly<Record<MergeStrategy, StrategyDefinition>> = {
  // The later (higher-precedence) source replaces the earlier one outright.
  OVERRIDE: {
    supports: ['boolean', 'number', 'string', 'stringList'],
    fold: (_left, right) => right,
  },
  ADD: {
    supports: ['number'],
    fold: (left, right) => ({
      kind: 'number',
      value: (left.value as number) + (right.value as number),
    }),
  },
  // On a boolean this is OR: any source may grant, none may take away.
  MAX: {
    supports: ['boolean', 'number'],
    fold: (left, right) =>
      left.kind === 'boolean'
        ? { kind: 'boolean', value: (left.value as boolean) || (right.value as boolean) }
        : { kind: 'number', value: Math.max(left.value as number, right.value as number) },
  },
  // On a boolean this is AND: any source may withhold, none may grant.
  MIN: {
    supports: ['boolean', 'number'],
    fold: (left, right) =>
      left.kind === 'boolean'
        ? { kind: 'boolean', value: (left.value as boolean) && (right.value as boolean) }
        : { kind: 'number', value: Math.min(left.value as number, right.value as number) },
  },
  UNION: {
    supports: ['stringList'],
    fold: (left, right) => ({
      kind: 'stringList',
      value: Object.freeze([...new Set([...asList(left), ...asList(right)])]),
    }),
  },
  INTERSECTION: {
    supports: ['stringList'],
    fold: (left, right) => {
      const a = asList(left);
      const b = asList(right);
      // An empty list means "unrestricted", not "nothing permitted" — this is
      // the documented meaning of an empty ai.model.allowlist. Intersecting
      // naively would turn an absent restriction into a total denial.
      if (a.length === 0) return { kind: 'stringList', value: b };
      if (b.length === 0) return { kind: 'stringList', value: a };
      const permitted = new Set(b);
      return {
        kind: 'stringList',
        value: Object.freeze(a.filter((item) => permitted.has(item))),
      };
    },
  },
  // Present in the recovered schema, but nothing configured uses it and the
  // original implementation was lost with the source tree. Guessing at how it
  // differs from MIN would be guessing at an access-control rule, so it refuses.
  HARD_DENY: {
    supports: [],
    unavailable:
      'HARD_DENY is not implemented: how it differs from MIN was lost with the previous ' +
      'backend, and guessing at an access-control rule is not acceptable. Specify it before ' +
      'any capability uses it.',
    fold: () => {
      throw new EntitlementConfigError('HARD_DENY has no fold.');
    },
  },
};

export function isMergeStrategy(value: unknown): value is MergeStrategy {
  return typeof value === 'string' && (mergeStrategies as readonly string[]).includes(value);
}

/**
 * Folds every source's contribution for one capability into the effective value,
 * lowest precedence first.
 */
export function resolveCapability(
  capability: CapabilityDefinition,
  contributions: readonly EntitlementContribution[],
): EntitlementValue {
  if (contributions.length === 0) {
    throw new EntitlementConfigError(
      `Capability "${capability.key}" was resolved with no contributions.`,
    );
  }

  const strategy = strategies[capability.mergeStrategy];
  if (strategy.unavailable !== undefined) {
    throw new EntitlementConfigError(`Capability "${capability.key}": ${strategy.unavailable}`);
  }
  if (!strategy.supports.includes(capability.valueKind)) {
    throw new EntitlementConfigError(
      `Capability "${capability.key}" declares strategy ${capability.mergeStrategy}, which does ` +
        `not apply to kind "${capability.valueKind}".`,
    );
  }

  const ordered = [...contributions].sort((a, b) => a.precedence - b.precedence);

  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    // Equal precedence makes OVERRIDE depend on arrival order, which is a silent
    // and irreproducible authorisation result.
    if (previous !== undefined && current !== undefined && previous.precedence === current.precedence) {
      throw new EntitlementConfigError(
        `Capability "${capability.key}": sources "${previous.sourceKey}" and "${current.sourceKey}" ` +
          `share precedence ${current.precedence}, so the winner would be arbitrary.`,
      );
    }
  }

  for (const contribution of ordered) {
    if (contribution.value.kind !== capability.valueKind) {
      throw new EntitlementConfigError(
        `Capability "${capability.key}": source "${contribution.sourceKey}" supplied a ` +
          `"${contribution.value.kind}" where "${capability.valueKind}" is declared.`,
      );
    }
  }

  const [first, ...rest] = ordered;
  if (first === undefined) {
    throw new EntitlementConfigError(`Capability "${capability.key}" produced no ordered value.`);
  }

  return rest.reduce<EntitlementValue>(
    (accumulated, contribution) => strategy.fold(accumulated, contribution.value),
    first.value,
  );
}
