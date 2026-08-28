import {
  DocumentShapeError,
  type Fields,
  booleanField,
  enumField,
  indexByKey,
  integerField,
  objectArrayField,
  stringField,
} from '../support/documents.ts';
import { type CapabilityDefinition, isMergeStrategy, mergeStrategies } from './merge.ts';
import { type EntitlementValue, entitlementValueKinds, parseEntitlementValue } from './values.ts';

export const meterKinds = ['COUNTER', 'GAUGE'] as const;
export const resetPeriods = ['NEVER', 'DAILY', 'MONTHLY'] as const;
export const planStatuses = ['ACTIVE', 'DEPRECATED'] as const;
export const rateLimitClasses = ['read', 'write', 'build', 'stream'] as const;
export const platforms = ['web', 'mobile'] as const;
export const sandboxProviderKeys = ['e2b', 'vps'] as const;
export const subscriptionStatuses = [
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'CANCELED',
  'INCOMPLETE',
] as const;

export type SubscriptionStatus = (typeof subscriptionStatuses)[number];

export type RateLimitClass = (typeof rateLimitClasses)[number];
export type Platform = (typeof platforms)[number];

export interface MeterDefinition {
  readonly key: string;
  readonly unit: string;
  readonly kind: (typeof meterKinds)[number];
  readonly resetPeriod: (typeof resetPeriods)[number];
  readonly label: string;
}

export interface SandboxProvider {
  readonly platform: Platform;
  readonly provider: (typeof sandboxProviderKeys)[number];
  readonly template: string;
  readonly timeoutSeconds: number;
  readonly memoryMb: number;
  readonly cpus: number;
  readonly concurrencyMeterKey: string;
  readonly workdir: string;
  readonly idleGraceSeconds: number;
  readonly agentInstructions: string;
}

export interface EntitlementSource {
  readonly key: string;
  readonly precedence: number;
}

export interface Registry {
  /** Applied when a user has no subscription. Configuration, not a fallback. */
  readonly defaultPlanKey: string;
  /** Which meter records sandbox wall-clock time, for the allowance invariant. */
  readonly sandboxTimeMeterKey: string;
  /**
   * Which meter one started build is charged against. Named here rather than
   * written into the code that starts builds, for the same reason as the one
   * above: renaming a meter is a configuration edit, not a deploy.
   */
  readonly buildMeterKey: string;
  /** Which meters model usage is charged to. Same reason: renaming is config. */
  readonly inputTokenMeterKey: string;
  readonly outputTokenMeterKey: string;
  /** Which meter records how much a user has stored. Occupied, so a gauge. */
  readonly storageMeterKey: string;
  /** Statuses that actually grant a paid plan. Data, so billing rules are not code. */
  readonly entitlingSubscriptionStatuses: readonly SubscriptionStatus[];
  readonly capabilities: ReadonlyMap<string, CapabilityDefinition>;
  readonly meters: ReadonlyMap<string, MeterDefinition>;
  readonly entitlementSources: ReadonlyMap<string, EntitlementSource>;
  readonly sandboxProviders: ReadonlyMap<Platform, SandboxProvider>;
}

export const billingIntervals = ['day', 'week', 'month', 'year'] as const;

export interface PlanPrice {
  /** The currency's minor unit — 2400 is £24.00. Integer, because money is not a float. */
  readonly amountMinor: number;
  /** ISO 4217, lowercase, as Stripe writes it. */
  readonly currency: string;
  readonly interval: (typeof billingIntervals)[number];
}

export interface MeterLimit {
  readonly meterKey: string;
  readonly includedAllowance: number;
  readonly hardLimit: number;
  readonly overageEnabled: boolean;
}

export interface RateLimit {
  readonly routeClass: RateLimitClass;
  readonly maxRequests: number;
  readonly windowSeconds: number;
}

export interface Plan {
  readonly key: string;
  readonly name: string;
  readonly status: (typeof planStatuses)[number];
  readonly rank: number;
  /**
   * What this plan costs. Absent for a plan nobody buys — the default one
   * everybody already has, or one kept only to honour subscriptions that
   * already exist.
   *
   * The amount lives here rather than as a Stripe price id, so configuration is
   * the single source of truth and Stripe is kept as a projection of it. The
   * price object in Stripe is created on demand from these numbers, which is
   * also what stops the pricing page advertising one figure while the checkout
   * charges another.
   */
  readonly price: PlanPrice | undefined;
  readonly entitlements: ReadonlyMap<string, EntitlementValue>;
  readonly meterLimits: ReadonlyMap<string, MeterLimit>;
  readonly rateLimits: ReadonlyMap<RateLimitClass, RateLimit>;
}

export function parseRegistry(fields: Fields, where: string): Registry {
  const capabilities = indexByKey(
    objectArrayField(fields, 'capabilities', where).map((entry, index): CapabilityDefinition => {
      const at = `${where}.capabilities[${index}]`;
      const mergeStrategy = stringField(entry, 'mergeStrategy', at);
      if (!isMergeStrategy(mergeStrategy)) {
        throw new DocumentShapeError(
          `${at}: mergeStrategy must be one of ${mergeStrategies.join(', ')}, got "${mergeStrategy}".`,
        );
      }
      return {
        key: stringField(entry, 'key', at),
        valueKind: enumField(entry, 'valueKind', at, entitlementValueKinds),
        mergeStrategy,
        label: stringField(entry, 'label', at),
      };
    }),
    (capability) => capability.key,
    `${where}.capabilities`,
  );

  const meters = indexByKey(
    objectArrayField(fields, 'meters', where).map((entry, index): MeterDefinition => {
      const at = `${where}.meters[${index}]`;
      return {
        key: stringField(entry, 'key', at),
        unit: stringField(entry, 'unit', at),
        kind: enumField(entry, 'kind', at, meterKinds),
        resetPeriod: enumField(entry, 'resetPeriod', at, resetPeriods),
        label: stringField(entry, 'label', at),
      };
    }),
    (meter) => meter.key,
    `${where}.meters`,
  );

  const entitlementSources = indexByKey(
    objectArrayField(fields, 'entitlementSources', where).map((entry, index): EntitlementSource => {
      const at = `${where}.entitlementSources[${index}]`;
      return {
        key: stringField(entry, 'key', at),
        precedence: integerField(entry, 'precedence', at, { min: 0 }),
      };
    }),
    (source) => source.key,
    `${where}.entitlementSources`,
  );

  // Two sources at the same precedence make an OVERRIDE depend on arrival order.
  // Caught here rather than at resolution, so it cannot reach a live request.
  const seenPrecedence = new Map<number, string>();
  for (const source of entitlementSources.values()) {
    const clash = seenPrecedence.get(source.precedence);
    if (clash !== undefined) {
      throw new DocumentShapeError(
        `${where}.entitlementSources: "${clash}" and "${source.key}" share precedence ${source.precedence}.`,
      );
    }
    seenPrecedence.set(source.precedence, source.key);
  }

  const providerList = objectArrayField(fields, 'sandboxProviders', where).map(
    (entry, index): SandboxProvider => {
      const at = `${where}.sandboxProviders[${index}]`;
      const concurrencyMeterKey = stringField(entry, 'concurrencyMeterKey', at);
      if (!meters.has(concurrencyMeterKey)) {
        throw new DocumentShapeError(
          `${at}: concurrencyMeterKey "${concurrencyMeterKey}" is not a declared meter.`,
        );
      }
      return {
        platform: enumField(entry, 'platform', at, platforms),
        provider: enumField(entry, 'provider', at, sandboxProviderKeys),
        template: stringField(entry, 'template', at),
        timeoutSeconds: integerField(entry, 'timeoutSeconds', at, { min: 1 }),
        memoryMb: integerField(entry, 'memoryMb', at, { min: 1 }),
        cpus: integerField(entry, 'cpus', at, { min: 1 }),
        concurrencyMeterKey,
        workdir: stringField(entry, 'workdir', at),
        idleGraceSeconds: integerField(entry, 'idleGraceSeconds', at, { min: 0 }),
        agentInstructions: stringField(entry, 'agentInstructions', at),
      };
    },
  );

  const defaultPlanKey = stringField(fields, 'defaultPlanKey', where);
  const sandboxTimeMeterKey = stringField(fields, 'sandboxTimeMeterKey', where);
  const buildMeterKey = stringField(fields, 'buildMeterKey', where);
  const inputTokenMeterKey = stringField(fields, 'inputTokenMeterKey', where);
  const outputTokenMeterKey = stringField(fields, 'outputTokenMeterKey', where);
  const storageMeterKey = stringField(fields, 'storageMeterKey', where);

  const entitling = fields['entitlingSubscriptionStatuses'];
  if (!Array.isArray(entitling) || entitling.length === 0) {
    throw new DocumentShapeError(
      `${where}: entitlingSubscriptionStatuses must be a non-empty array.`,
    );
  }
  const entitlingSubscriptionStatuses = entitling.map((status, index) => {
    if (!(subscriptionStatuses as readonly unknown[]).includes(status)) {
      throw new DocumentShapeError(
        `${where}.entitlingSubscriptionStatuses[${index}]: "${String(status)}" is not one of ` +
          `${subscriptionStatuses.join(', ')}.`,
      );
    }
    return status as SubscriptionStatus;
  });
  if (!meters.has(sandboxTimeMeterKey)) {
    throw new DocumentShapeError(
      `${where}: sandboxTimeMeterKey "${sandboxTimeMeterKey}" is not a declared meter.`,
    );
  }

  // Everything these three point at is spent outright rather than held, so each
  // must be a counter. Pointing one at a gauge would charge a slot that nothing
  // ever gives back.
  for (const [field, key] of [
    ['buildMeterKey', buildMeterKey],
    ['inputTokenMeterKey', inputTokenMeterKey],
    ['outputTokenMeterKey', outputTokenMeterKey],
  ] as const) {
    const meter = meters.get(key);
    if (meter === undefined) {
      throw new DocumentShapeError(`${where}: ${field} "${key}" is not a declared meter.`);
    }
    if (meter.kind !== 'COUNTER') {
      throw new DocumentShapeError(
        `${where}: ${field} "${key}" is a ${meter.kind}, but what it measures is consumed ` +
          'rather than held, so it must be a COUNTER.',
      );
    }
  }

  const storageMeter = meters.get(storageMeterKey);
  if (storageMeter === undefined) {
    throw new DocumentShapeError(
      `${where}: storageMeterKey "${storageMeterKey}" is not a declared meter.`,
    );
  }
  if (storageMeter.kind !== 'GAUGE') {
    // Storage is occupied and given back, not spent. A counter would only ever
    // climb, so deleting a project would never return the space.
    throw new DocumentShapeError(
      `${where}: storageMeterKey "${storageMeterKey}" is a ${storageMeter.kind}, but stored ` +
        'bytes are occupied rather than consumed, so it must be a GAUGE.',
    );
  }

  return {
    defaultPlanKey,
    sandboxTimeMeterKey,
    buildMeterKey,
    inputTokenMeterKey,
    outputTokenMeterKey,
    storageMeterKey,
    entitlingSubscriptionStatuses: Object.freeze(entitlingSubscriptionStatuses),
    capabilities,
    meters,
    entitlementSources,
    sandboxProviders: indexByKey(providerList, (provider) => provider.platform, `${where}.sandboxProviders`) as ReadonlyMap<Platform, SandboxProvider>,
  };
}

/**
 * A plan's price, when it has one. Absent and malformed are different: a plan
 * with no `price` is simply not for sale, while a `price` that cannot be read
 * is refused, because the alternative is quietly treating a paid plan as free.
 */
function parsePlanPrice(fields: Fields, where: string): PlanPrice | undefined {
  const raw = fields['price'];
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DocumentShapeError(`${where}.price must be an object when it is present.`);
  }
  const at = `${where}.price`;
  const price = raw as Fields;
  return {
    // Minimum 1: a zero-amount price would make a paid plan checkout for free.
    amountMinor: integerField(price, 'amountMinor', at, { min: 1 }),
    currency: stringField(price, 'currency', at),
    interval: enumField(price, 'interval', at, billingIntervals),
  };
}

export function parsePlan(fields: Fields, where: string, registry: Registry): Plan {
  const key = stringField(fields, 'key', where);

  const entitlements = new Map<string, EntitlementValue>();
  objectArrayField(fields, 'entitlements', where).forEach((entry, index) => {
    const at = `${where}.entitlements[${index}]`;
    const capabilityKey = stringField(entry, 'capabilityKey', at);
    const capability = registry.capabilities.get(capabilityKey);
    if (capability === undefined) {
      throw new DocumentShapeError(`${at}: "${capabilityKey}" is not a declared capability.`);
    }
    if (entitlements.has(capabilityKey)) {
      throw new DocumentShapeError(`${at}: "${capabilityKey}" appears more than once.`);
    }
    entitlements.set(
      capabilityKey,
      parseEntitlementValue(entry['value'], capability.valueKind, `${at}.value`),
    );
  });

  const meterLimits = new Map<string, MeterLimit>();
  objectArrayField(fields, 'meterLimits', where).forEach((entry, index) => {
    const at = `${where}.meterLimits[${index}]`;
    const meterKey = stringField(entry, 'meterKey', at);
    if (!registry.meters.has(meterKey)) {
      throw new DocumentShapeError(`${at}: "${meterKey}" is not a declared meter.`);
    }
    if (meterLimits.has(meterKey)) {
      throw new DocumentShapeError(`${at}: "${meterKey}" appears more than once.`);
    }
    const includedAllowance = integerField(entry, 'includedAllowance', at, { min: 0 });
    const hardLimit = integerField(entry, 'hardLimit', at, { min: 0 });
    if (includedAllowance > hardLimit) {
      throw new DocumentShapeError(
        `${at}: includedAllowance ${includedAllowance} exceeds hardLimit ${hardLimit}.`,
      );
    }
    meterLimits.set(meterKey, {
      meterKey,
      includedAllowance,
      hardLimit,
      overageEnabled: booleanField(entry, 'overageEnabled', at),
    });
  });

  const rateLimits = new Map<RateLimitClass, RateLimit>();
  objectArrayField(fields, 'rateLimits', where).forEach((entry, index) => {
    const at = `${where}.rateLimits[${index}]`;
    const routeClass = enumField(entry, 'routeClass', at, rateLimitClasses);
    if (rateLimits.has(routeClass)) {
      throw new DocumentShapeError(`${at}: "${routeClass}" appears more than once.`);
    }
    rateLimits.set(routeClass, {
      routeClass,
      maxRequests: integerField(entry, 'maxRequests', at, { min: 1 }),
      windowSeconds: integerField(entry, 'windowSeconds', at, { min: 1 }),
    });
  });

  return {
    key,
    name: stringField(fields, 'name', where),
    status: enumField(fields, 'status', where, planStatuses),
    rank: integerField(fields, 'rank', where, { min: 0 }),
    price: parsePlanPrice(fields, where),
    entitlements,
    meterLimits,
    rateLimits,
  };
}

/**
 * Acquiring a sandbox reserves the provider's *full* timeout up front, because
 * that is the most it could possibly spend and reserving the maximum is what
 * makes overspend structurally impossible. The invariant that follows is easy to
 * violate silently, and did reach production once:
 *
 *   no plan's hard limit for a sandbox-time meter may be below the longest
 *   sandbox lifetime, or every acquisition on that plan is refused before doing
 *   any work — which reads as a usage problem rather than a configuration one.
 *
 * Checked when configuration loads, so raising a provider timeout cannot quietly
 * kill a cheap tier.
 */
export function assertSandboxAllowancesAreUsable(
  registry: Registry,
  plans: readonly Plan[],
  sandboxTimeMeterKey: string,
): void {
  const meter = registry.meters.get(sandboxTimeMeterKey);
  if (meter === undefined) {
    throw new DocumentShapeError(
      `The sandbox time meter "${sandboxTimeMeterKey}" is not declared in the registry.`,
    );
  }

  let longest: SandboxProvider | undefined;
  for (const provider of registry.sandboxProviders.values()) {
    if (longest === undefined || provider.timeoutSeconds > longest.timeoutSeconds) {
      longest = provider;
    }
  }
  if (longest === undefined) {
    throw new DocumentShapeError('No sandbox providers are configured.');
  }

  for (const plan of plans) {
    if (plan.status !== 'ACTIVE') continue;
    const limit = plan.meterLimits.get(sandboxTimeMeterKey);
    if (limit === undefined) {
      throw new DocumentShapeError(
        `Plan "${plan.key}" declares no limit for "${sandboxTimeMeterKey}", so a sandbox could ` +
          'run unmetered.',
      );
    }
    if (limit.hardLimit < longest.timeoutSeconds) {
      throw new DocumentShapeError(
        `Plan "${plan.key}" caps "${sandboxTimeMeterKey}" at ${limit.hardLimit}s, below the ` +
          `${longest.timeoutSeconds}s lifetime of the "${longest.platform}" sandbox. Every build ` +
          'on this plan would be refused before starting.',
      );
    }
  }
}
