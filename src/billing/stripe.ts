import Stripe from 'stripe';

import type { Plan, SubscriptionStatus } from '../entitlements/schema.ts';
import { EntitlementConfigError } from '../entitlements/values.ts';
import { AppError } from '../http/errors.ts';

/**
 * Stripe's vocabulary translated into ours.
 *
 * The translation is code because it is a protocol detail — Stripe decides what
 * words it uses. What those words are allowed to *buy* is not decided here: the
 * registry's `entitlingSubscriptionStatuses` is what says which of ours grant a
 * paid plan, so changing billing policy stays a configuration edit.
 *
 * Every status Stripe documents is listed, and an unrecognised one is refused
 * rather than guessed. A status silently treated as "not entitling" would take
 * a paying customer's features away; treated as entitling, it would give them
 * away.
 */
const statusTranslation: Readonly<Record<string, SubscriptionStatus>> = {
  trialing: 'TRIALING',
  active: 'ACTIVE',
  past_due: 'PAST_DUE',
  // Stripe stops trying to collect but keeps the subscription; for us that is
  // the same unpaid state as past_due, and the registry decides if it entitles.
  unpaid: 'PAST_DUE',
  canceled: 'CANCELED',
  // A subscription paused for non-payment is not cancelled at Stripe, but it is
  // not being paid for either, and nothing about it is going to resume by itself.
  paused: 'CANCELED',
  incomplete: 'INCOMPLETE',
  // The first payment never succeeded and Stripe has given up waiting.
  incomplete_expired: 'CANCELED',
};

export function translateStatus(status: string): SubscriptionStatus {
  const translated = statusTranslation[status];
  if (translated === undefined) {
    throw new AppError({
      code: 'billing/unknown-status',
      statusCode: 500,
      message: `Stripe reported subscription status "${status}", which this service cannot read.`,
      details: { status, known: Object.keys(statusTranslation) },
    });
  }
  return translated;
}

/** What one Stripe subscription means for one user, once translated. */
export interface StripeSubscriptionState {
  readonly customerId: string;
  readonly planKey: string;
  readonly status: SubscriptionStatus;
  readonly currentPeriodStart: Date;
  readonly currentPeriodEnd: Date;
}

function customerIdOf(subscription: Stripe.Subscription): string {
  const { customer } = subscription;
  const id = typeof customer === 'string' ? customer : customer.id;
  if (id === '') {
    throw new AppError({
      code: 'billing/malformed-subscription',
      statusCode: 500,
      message: `Stripe subscription ${subscription.id} has no customer.`,
    });
  }
  return id;
}

/**
 * Reads a Stripe subscription into the shape entitlements resolve against.
 *
 * The billing period is taken from the subscription *item*, not the
 * subscription: Stripe moved it there, and `subscription.current_period_end` —
 * which every older example reaches for — is simply not present any more. Read
 * from the wrong place it is `undefined`, and a period that cannot be compared
 * means every paid plan silently stops entitling.
 */
export function readSubscription(
  subscription: Stripe.Subscription,
  planByPrice: ReadonlyMap<string, Plan>,
): StripeSubscriptionState {
  const items = subscription.items.data;
  if (items.length !== 1) {
    // Our model is one plan per subscription. Taking the first of several would
    // charge for one thing and entitle another.
    throw new AppError({
      code: 'billing/unsupported-subscription',
      statusCode: 500,
      message:
        `Stripe subscription ${subscription.id} has ${items.length} items, and a subscription ` +
        'must carry exactly one plan.',
      details: { subscriptionId: subscription.id, items: items.length },
    });
  }

  const item = items[0]!;
  const priceId = item.price.id;
  const plan = planByPrice.get(priceId);
  if (plan === undefined) {
    throw new AppError({
      code: 'billing/unknown-price',
      statusCode: 500,
      message: `No plan is configured for Stripe price ${priceId}.`,
      details: { priceId, configured: [...planByPrice.keys()] },
    });
  }

  const currentPeriodStart = new Date(item.current_period_start * 1000);
  const currentPeriodEnd = new Date(item.current_period_end * 1000);
  if (
    Number.isNaN(currentPeriodStart.getTime()) ||
    Number.isNaN(currentPeriodEnd.getTime()) ||
    currentPeriodEnd <= currentPeriodStart
  ) {
    throw new AppError({
      code: 'billing/malformed-subscription',
      statusCode: 500,
      message: `Stripe subscription ${subscription.id} has no usable billing period.`,
      details: { subscriptionId: subscription.id },
    });
  }

  return {
    customerId: customerIdOf(subscription),
    planKey: plan.key,
    status: translateStatus(subscription.status),
    currentPeriodStart,
    currentPeriodEnd,
  };
}

/**
 * Which plan each Stripe price sells, built from the plan documents.
 *
 * Two plans sharing a price would make what a customer bought depend on map
 * ordering, and the default plan carrying one would mean the free tier could be
 * purchased — both are refused here rather than discovered at a checkout.
 */
export function planPrices(
  plans: ReadonlyMap<string, Plan>,
  defaultPlanKey: string,
): ReadonlyMap<string, Plan> {
  const byPrice = new Map<string, Plan>();
  for (const plan of plans.values()) {
    if (plan.stripePriceId === undefined) {
      continue;
    }
    if (plan.key === defaultPlanKey) {
      throw new EntitlementConfigError(
        `The default plan "${plan.key}" carries a Stripe price, but the plan everyone already ` +
          'has cannot be sold.',
      );
    }
    const clash = byPrice.get(plan.stripePriceId);
    if (clash !== undefined) {
      throw new EntitlementConfigError(
        `Plans "${clash.key}" and "${plan.key}" both sell Stripe price ${plan.stripePriceId}.`,
      );
    }
    byPrice.set(plan.stripePriceId, plan);
  }
  return byPrice;
}

/**
 * Runs a Stripe call, turning their failures into ours.
 *
 * Without this a card network having a bad afternoon reaches the client as a
 * bare 500 that reads like our bug. A 502 says the truth — we are fine, the
 * thing we depend on is not — and it is the difference between a user retrying
 * in a minute and a user filing a support ticket. The provider's own message is
 * logged, never returned: it carries request ids and account details.
 */
export async function throughStripe<T>(
  what: string,
  call: () => Promise<T>,
  onError: (error: Error) => void,
): Promise<T> {
  try {
    return await call();
  } catch (cause) {
    if (!(cause instanceof Stripe.errors.StripeError)) {
      throw cause;
    }
    onError(cause instanceof Error ? cause : new Error(String(cause)));
    throw new AppError({
      code: 'billing/provider-unavailable',
      statusCode: 502,
      message: `Stripe could not ${what} right now. Try again shortly.`,
      details: { operation: what, type: cause.type },
    });
  }
}

/**
 * The API version is pinned by the library rather than chosen here. Letting the
 * account's default apply would mean Stripe changing a payload shape under a
 * running deployment.
 */
export function createStripe(secretKey: string): Stripe {
  return new Stripe(secretKey, {
    // Retries are for transient failures only; Stripe's own idempotency covers
    // the rest, and a request retried forever holds a user's checkout open.
    maxNetworkRetries: 2,
    timeout: 20_000,
  });
}
