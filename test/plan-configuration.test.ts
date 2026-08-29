import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parsePlan, parseRegistry } from '../src/entitlements/schema.ts';
import type { Fields } from '../src/support/documents.ts';
import { planDocuments, registryDocument } from '../src/seed/config.ts';

/**
 * The seeded configuration is the fixture, so these fail if the real documents
 * stop being valid — not only if the parser regresses.
 */
const registry = parseRegistry(registryDocument as unknown as Fields, 'config/registry');

const planFor = (key: string): Fields => {
  const document = planDocuments.find((plan) => plan.key === key);
  assert.ok(document !== undefined, `the seed no longer defines a "${key}" plan`);
  return document as unknown as Fields;
};

const parse = (key: string) => parsePlan(planFor(key), `plans/${key}`, registry);

const withPrice = (key: string, price: unknown): Fields => ({ ...planFor(key), price });

test('every seeded plan parses against the seeded registry', () => {
  for (const document of planDocuments) {
    assert.doesNotThrow(() => parsePlan(document as unknown as Fields, 'plans/x', registry));
  }
});

test('the free plan cannot be sold', () => {
  // A price on the default plan means charging for something every account
  // already has. The store refuses it at load; this guards the seed itself.
  assert.equal(parse('free').price, undefined);
  assert.equal(registry.defaultPlanKey, 'free');
});

test('paid plans carry a positive recurring price', () => {
  for (const key of ['pro', 'business']) {
    const { price } = parse(key);
    assert.ok(price !== undefined, `${key} must be purchasable`);
    assert.ok(price.amountMinor > 0);
    assert.equal(price.currency, 'gbp');
    assert.equal(price.interval, 'month');
  }
});

test('the free plan is held to cheap models', () => {
  // Regression guard on the cost decision: free usage is unbounded by revenue,
  // and an Opus turn costs five times a Haiku one on both input and output.
  const models = parse('free').entitlements.get('ai.model.allowlist');
  assert.equal(models?.kind, 'stringList');
  assert.deepEqual(models?.value, ['claude-haiku-4-5']);
});

test('a zero price is refused rather than checked out for nothing', () => {
  assert.throws(() =>
    parsePlan(withPrice('pro', { amountMinor: 0, currency: 'gbp', interval: 'month' }), 'plans/pro', registry),
  );
});

test('a malformed price is refused rather than read as free', () => {
  // Absent and broken must not collapse to the same outcome: a paid plan whose
  // price fails to parse would silently become unsellable-but-free.
  for (const price of [
    'gbp2400',
    [],
    { currency: 'gbp', interval: 'month' },
    { amountMinor: 2400, interval: 'month' },
    { amountMinor: 2400, currency: 'gbp', interval: 'fortnight' },
    { amountMinor: 24.5, currency: 'gbp', interval: 'month' },
  ]) {
    assert.throws(
      () => parsePlan(withPrice('pro', price), 'plans/pro', registry),
      `${JSON.stringify(price)} should not parse`,
    );
  }
});

test('a plan cannot grant a capability the registry never declared', () => {
  const rogue: Fields = {
    ...planFor('pro'),
    entitlements: [
      { capabilityKey: 'billing.free_forever', value: { kind: 'boolean', value: true } },
    ],
  };
  assert.throws(() => parsePlan(rogue, 'plans/pro', registry));
});

test('every sandbox allowance outlives a single sandbox', () => {
  // reserve-at-max: a build reserves the provider timeout up front, so a plan
  // whose cap is below one sandbox lifetime can never start a build at all.
  const longest = Math.max(
    ...[...registry.sandboxProviders.values()].map((provider) => provider.timeoutSeconds),
  );
  for (const document of planDocuments) {
    const plan = parsePlan(document as unknown as Fields, `plans/${document.key}`, registry);
    const allowance = plan.meterLimits.get(registry.sandboxTimeMeterKey);
    assert.ok(allowance !== undefined, `${plan.key} declares no sandbox allowance`);
    assert.ok(
      allowance.hardLimit >= longest,
      `${plan.key} caps sandbox time at ${allowance.hardLimit}s, below one ${longest}s sandbox`,
    );
  }
});
