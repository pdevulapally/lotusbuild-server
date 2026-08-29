import assert from 'node:assert/strict';
import { test } from 'node:test';
import type Stripe from 'stripe';

import { parsePlan, parseRegistry, type Plan } from '../src/entitlements/schema.ts';
import { planKeyMetadataField, readSubscription, translateStatus } from '../src/billing/stripe.ts';
import type { Fields } from '../src/support/documents.ts';
import { planDocuments, registryDocument } from '../src/seed/config.ts';

const registry = parseRegistry(registryDocument as unknown as Fields, 'config/registry');
const plans: ReadonlyMap<string, Plan> = new Map(
  planDocuments.map((document) => {
    const plan = parsePlan(document as unknown as Fields, `plans/${document.key}`, registry);
    return [plan.key, plan];
  }),
);

const hour = 3600;
const now = Math.floor(Date.now() / 1000);

/** A subscription shaped the way Stripe actually sends one. */
function subscription(options: {
  planKey?: string | undefined;
  status?: string | undefined;
  items?: number | undefined;
  periodStart?: number | undefined;
  periodEnd?: number | undefined;
}): Stripe.Subscription {
  const metadata = options.planKey === undefined ? {} : { [planKeyMetadataField]: options.planKey };
  const item = {
    price: { id: 'price_live_1', metadata },
    // The period lives on the ITEM, not the subscription — see the test below.
    current_period_start: options.periodStart === undefined ? now : options.periodStart,
    current_period_end: options.periodEnd === undefined ? now + hour : options.periodEnd,
  };
  return {
    id: 'sub_1',
    customer: 'cus_1',
    status: options.status === undefined ? 'active' : options.status,
    items: { data: Array.from({ length: options.items === undefined ? 1 : options.items }, () => item) },
  } as unknown as Stripe.Subscription;
}

test('a paid subscription resolves to its plan', () => {
  const state = readSubscription(subscription({ planKey: 'pro' }), plans);
  assert.equal(state.planKey, 'pro');
  assert.equal(state.status, 'ACTIVE');
  assert.equal(state.customerId, 'cus_1');
});

test('the billing period is read from the item, not the subscription', () => {
  // Regression: on recent Stripe API versions `subscription.current_period_end`
  // is undefined and only the item carries the period. Reading the wrong one
  // produces a period that never compares true, so every paid plan silently
  // stops entitling — a failure with no error anywhere.
  const start = now - hour;
  const end = now + hour;
  const state = readSubscription(
    subscription({ planKey: 'pro', periodStart: start, periodEnd: end }),
    plans,
  );
  assert.equal(state.currentPeriodStart.getTime(), start * 1000);
  assert.equal(state.currentPeriodEnd.getTime(), end * 1000);
});

test('a price with no plan metadata is refused, not guessed', () => {
  // A price created by hand in the dashboard. Guessing which plan it meant
  // would entitle a customer to something nobody decided to sell them.
  assert.throws(() => readSubscription(subscription({ planKey: undefined }), plans), /unlabelled|planKey/i);
});

test('a price naming an unknown plan is refused', () => {
  assert.throws(() => readSubscription(subscription({ planKey: 'enterprise' }), plans));
});

test('a subscription carrying several plans is refused', () => {
  // Taking the first of several would charge for one thing and entitle another.
  assert.throws(() => readSubscription(subscription({ planKey: 'pro', items: 2 }), plans));
  assert.throws(() => readSubscription(subscription({ planKey: 'pro', items: 0 }), plans));
});

test('an inverted or empty billing period is refused', () => {
  for (const [start, end] of [
    [now, now - hour],
    [now, now],
  ]) {
    assert.throws(() =>
      readSubscription(subscription({ planKey: 'pro', periodStart: start, periodEnd: end }), plans),
    );
  }
});

test('unpaid states translate to PAST_DUE, not to something entitling', () => {
  assert.equal(translateStatus('past_due'), 'PAST_DUE');
  assert.equal(translateStatus('unpaid'), 'PAST_DUE');
});

test('dead states translate to CANCELED', () => {
  for (const status of ['canceled', 'paused', 'incomplete_expired']) {
    assert.equal(translateStatus(status), 'CANCELED');
  }
});

test('an unrecognised Stripe status throws instead of defaulting', () => {
  // Defaulting an unknown status either grants a plan nobody paid for or
  // revokes one somebody did. Refusing loudly is the only safe reading.
  assert.throws(() => translateStatus('some_future_status'), /cannot read/i);
});

test('only trialing and active entitle', () => {
  // The seeded list is the whole grace policy: adding PAST_DUE here is what
  // turns the paid period into a retry window while Stripe re-attempts a card.
  assert.deepEqual([...registry.entitlingSubscriptionStatuses], ['TRIALING', 'ACTIVE']);
});
