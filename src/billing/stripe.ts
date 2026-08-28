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
  plans: ReadonlyMap<string, Plan>,
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
  // Resolved through the price's own metadata rather than by matching its id
  // against the current catalogue. A price change publishes a new Stripe price
  // and moves the lookup key onto it, leaving existing subscribers on the old
  // one — matching by id would fail for exactly those grandfathered customers,
  // and their subscription is the one that must keep working.
  const planKey = item.price.metadata[planKeyMetadataField];
  if (planKey === undefined) {
    // Every price we publish carries this. One without it was made by hand in
    // the dashboard, and guessing which plan it meant would entitle a customer
    // to something nobody decided to sell them.
    throw new AppError({
      code: 'billing/unlabelled-price',
      statusCode: 500,
      message: `Stripe price ${priceId} carries no "${planKeyMetadataField}", so what it sells cannot be told.`,
      details: { priceId },
    });
  }
  const plan = plans.get(planKey);
  if (plan === undefined) {
    throw new AppError({
      code: 'billing/unknown-price',
      statusCode: 500,
      message: `Stripe price ${priceId} names no plan we configure.`,
      details: { priceId, planKey, configured: [...plans.keys()] },
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

/** Where a plan key is recorded on the Stripe objects we create. */
export const planKeyMetadataField = 'planKey';

/** The lookup key naming the price that currently sells a plan. */
function lookupKeyFor(plan: Plan): string {
  return `lotusbuild_${plan.key}`;
}

/**
 * The Stripe price that sells this plan right now, created if it does not exist.
 *
 * Configuration owns the amount, so Stripe is brought into line with it rather
 * than the other way round — no price ids are pasted between a dashboard and a
 * plan document, and there is no window where the two disagree.
 *
 * Idempotent through the lookup key: an unchanged amount finds the existing
 * price and creates nothing. A changed amount publishes a new price and moves
 * the lookup key onto it, which is the only thing Stripe permits — prices are
 * immutable. The old price stays active and its subscribers stay on the terms
 * they agreed to, which is why `readSubscription` resolves plans through the
 * price's metadata instead of the current catalogue.
 */
export async function ensurePriceId(
  stripe: Stripe,
  plan: Plan,
  onError: (error: Error) => void,
): Promise<string> {
  const price = plan.price;
  if (price === undefined) {
    throw new EntitlementConfigError(
      `Plan "${plan.key}" carries no price, so it cannot be sold.`,
    );
  }

  const lookupKey = lookupKeyFor(plan);
  const existing = await throughStripe(
    'look up a price',
    () => stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 }),
    onError,
  );

  const current = existing.data[0];
  const matches =
    current !== undefined &&
    current.unit_amount === price.amountMinor &&
    current.currency === price.currency &&
    current.recurring !== null &&
    current.recurring.interval === price.interval;
  if (matches) {
    return current.id;
  }

  const metadata = { [planKeyMetadataField]: plan.key };
  const created = await throughStripe(
    'publish a price',
    () =>
      stripe.prices.create({
        currency: price.currency,
        unit_amount: price.amountMinor,
        recurring: { interval: price.interval },
        lookup_key: lookupKey,
        // Takes the key off whichever price held it, so the next checkout sells
        // this one while existing subscriptions keep billing on the old.
        transfer_lookup_key: true,
        metadata,
        // Reuse the product a previous price already belongs to, so a price
        // change does not scatter a new product per revision across Stripe.
        ...(current === undefined
          ? { product_data: { name: plan.name, metadata } }
          : { product: typeof current.product === 'string' ? current.product : current.product.id }),
      }),
    onError,
  );
  return created.id;
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
