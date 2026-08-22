import type { Firestore, Timestamp } from 'firebase-admin/firestore';

import { DocumentShapeError, type Fields, enumField, stringField } from '../support/documents.ts';
import { type EntitlementContribution, resolveCapability } from './merge.ts';
import {
  type MeterLimit,
  type Plan,
  type RateLimit,
  type RateLimitClass,
  type Registry,
  type SubscriptionStatus,
  subscriptionStatuses,
} from './schema.ts';
import type { ConfigurationStore } from './store.ts';
import { EntitlementConfigError, type EntitlementValue } from './values.ts';

export const subscriptionsCollectionPath = 'subscriptions';

export type { SubscriptionStatus } from './schema.ts';

export interface Subscription {
  readonly planKey: string;
  readonly status: SubscriptionStatus;
  readonly currentPeriodStart: Date;
  readonly currentPeriodEnd: Date;
}

function timestampField(fields: Fields, name: string, where: string): Date {
  const value = fields[name];
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as Timestamp).toDate !== 'function'
  ) {
    throw new DocumentShapeError(`${where}: field "${name}" must be a Firestore timestamp.`);
  }
  const date = (value as Timestamp).toDate();
  if (Number.isNaN(date.getTime())) {
    throw new DocumentShapeError(`${where}: field "${name}" is not a valid instant.`);
  }
  return date;
}

function parseSubscription(fields: Fields, where: string): Subscription {
  const currentPeriodStart = timestampField(fields, 'currentPeriodStart', where);
  const currentPeriodEnd = timestampField(fields, 'currentPeriodEnd', where);
  if (currentPeriodEnd <= currentPeriodStart) {
    throw new DocumentShapeError(`${where}: currentPeriodEnd is not after currentPeriodStart.`);
  }
  return {
    planKey: stringField(fields, 'planKey', where),
    status: enumField(fields, 'status', where, subscriptionStatuses),
    currentPeriodStart,
    currentPeriodEnd,
  };
}

/**
 * The effective entitlements for one user, with accessors that fail rather than
 * hand back `undefined`.
 *
 * A caller asking for a capability the configuration never declared has found a
 * misconfiguration, and treating that as "absent, therefore denied" would let a
 * typo silently disable a paid feature — or silently permit one.
 */
export class ResolvedEntitlements {
  readonly #values: ReadonlyMap<string, EntitlementValue>;

  constructor(values: ReadonlyMap<string, EntitlementValue>) {
    this.#values = values;
  }

  #require(key: string, kind: EntitlementValue['kind']): EntitlementValue {
    const value = this.#values.get(key);
    if (value === undefined) {
      throw new EntitlementConfigError(
        `Capability "${key}" is not configured for this user's plan, so it cannot be evaluated.`,
      );
    }
    if (value.kind !== kind) {
      throw new EntitlementConfigError(
        `Capability "${key}" resolved to a "${value.kind}" but was read as a "${kind}".`,
      );
    }
    return value;
  }

  boolean(key: string): boolean {
    return this.#require(key, 'boolean').value as boolean;
  }

  number(key: string): number {
    return this.#require(key, 'number').value as number;
  }

  string(key: string): string {
    return this.#require(key, 'string').value as string;
  }

  stringList(key: string): readonly string[] {
    return this.#require(key, 'stringList').value as readonly string[];
  }

  /**
   * Whether a value is permitted by an allowlist capability, honouring the rule
   * that an empty list means unrestricted rather than nothing-permitted.
   */
  allows(key: string, candidate: string): boolean {
    const permitted = this.stringList(key);
    return permitted.length === 0 || permitted.includes(candidate);
  }

  keys(): readonly string[] {
    return [...this.#values.keys()];
  }

  /** Every capability with its declared kind intact, for reporting them all. */
  entries(): readonly (EntitlementValue & { readonly key: string })[] {
    return [...this.#values].map(([key, value]) => ({ key, ...value }));
  }
}

export interface UserEntitlements {
  readonly planKey: string;
  readonly planName: string;
  readonly subscriptionStatus: SubscriptionStatus | undefined;
  readonly capabilities: ResolvedEntitlements;
  readonly meterLimits: ReadonlyMap<string, MeterLimit>;
  readonly rateLimits: ReadonlyMap<RateLimitClass, RateLimit>;
}

export class EntitlementService {
  readonly #firestore: Firestore;
  readonly #configuration: ConfigurationStore;

  constructor(firestore: Firestore, configuration: ConfigurationStore) {
    this.#firestore = firestore;
    this.#configuration = configuration;
  }

  /**
   * A subscription entitles only while it is in an entitling status *and* inside
   * its paid period. Checking the period as well as the status means a webhook
   * that never arrives cannot leave a lapsed subscription granting a paid plan
   * indefinitely.
   */
  #entitles(subscription: Subscription, registry: Registry, now: Date): boolean {
    return (
      registry.entitlingSubscriptionStatuses.includes(subscription.status) &&
      subscription.currentPeriodStart <= now &&
      now < subscription.currentPeriodEnd
    );
  }

  async #planFor(uid: string, now: Date): Promise<{
    plan: Plan;
    status: SubscriptionStatus | undefined;
  }> {
    const { registry, plans } = await this.#configuration.get();

    const path = `${subscriptionsCollectionPath}/${uid}`;
    const snapshot = await this.#firestore.doc(path).get();

    const defaultPlan = plans.get(registry.defaultPlanKey);
    if (defaultPlan === undefined) {
      throw new EntitlementConfigError(
        `The default plan "${registry.defaultPlanKey}" is missing from the loaded configuration.`,
      );
    }

    if (!snapshot.exists) {
      return { plan: defaultPlan, status: undefined };
    }

    const subscription = parseSubscription(snapshot.data() ?? {}, path);
    if (!this.#entitles(subscription, registry, now)) {
      return { plan: defaultPlan, status: subscription.status };
    }

    const plan = plans.get(subscription.planKey);
    if (plan === undefined) {
      // Silently demoting a paying customer to the free plan because their plan
      // key no longer exists would be a billing incident nobody notices.
      throw new EntitlementConfigError(
        `${path}: plan "${subscription.planKey}" is not configured, so this subscription cannot ` +
          'be honoured.',
      );
    }
    if (plan.status !== 'ACTIVE') {
      throw new EntitlementConfigError(
        `${path}: plan "${plan.key}" is ${plan.status}, so it cannot entitle a live subscription.`,
      );
    }

    return { plan, status: subscription.status };
  }

  async forUser(uid: string, now: Date = new Date()): Promise<UserEntitlements> {
    const { registry } = await this.#configuration.get();
    const { plan, status } = await this.#planFor(uid, now);

    const planSource = registry.entitlementSources.get('plan');
    if (planSource === undefined) {
      throw new EntitlementConfigError(
        'The "plan" entitlement source is not declared, so a plan cannot contribute anything.',
      );
    }

    // Only the plan contributes today. Additional sources — a manual grant, a
    // promotion — become extra contributions here and merge by the capability's
    // own strategy without any change to the resolver.
    const resolved = new Map<string, EntitlementValue>();
    for (const [capabilityKey, value] of plan.entitlements) {
      const capability = registry.capabilities.get(capabilityKey);
      if (capability === undefined) {
        throw new EntitlementConfigError(
          `Plan "${plan.key}" grants "${capabilityKey}", which is not a declared capability.`,
        );
      }
      const contributions: readonly EntitlementContribution[] = [
        { sourceKey: planSource.key, precedence: planSource.precedence, value },
      ];
      resolved.set(capabilityKey, resolveCapability(capability, contributions));
    }

    return {
      planKey: plan.key,
      planName: plan.name,
      subscriptionStatus: status,
      capabilities: new ResolvedEntitlements(resolved),
      meterLimits: plan.meterLimits,
      rateLimits: plan.rateLimits,
    };
  }
}
