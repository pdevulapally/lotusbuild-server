import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePlan, parseRegistry } from '../src/entitlements/schema.ts';
import { planDocuments, registryDocument } from '../src/seed/config.ts';
import { withBooleanCapability } from '../src/seed/capability-row.ts';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const registry = parseRegistry(clone(registryDocument) as Record<string, unknown>, 'registry');
const free = () => clone(planDocuments.find((plan) => plan.key === 'free')!) as Record<string, unknown>;

test('turns one boolean row on and leaves the rest of the plan alone', () => {
  const before = parsePlan(free(), 'plans/free', registry);
  const edited = withBooleanCapability(free(), 'git.persistence', true);
  assert.deepEqual(edited.changes, [{ capabilityKey: 'git.persistence', from: { kind: 'boolean', value: false }, to: { kind: 'boolean', value: true } }]);
  const after = parsePlan(edited.fields, 'plans/free', registry);
  assert.deepEqual(after.entitlements.get('git.persistence'), { kind: 'boolean', value: true });
  for (const [key, value] of before.entitlements) if (key !== 'git.persistence') assert.deepEqual(after.entitlements.get(key), value);
  assert.deepEqual(after.meterLimits, before.meterLimits);
  assert.deepEqual(withBooleanCapability(edited.fields, 'git.persistence', true).changes, []);
});

test('refuses a plan without the row or without entitlements', () => {
  assert.throws(() => withBooleanCapability(free(), 'no.such', true), /no no.such entitlement row/);
  assert.throws(() => withBooleanCapability({}, 'git.persistence', true), /no entitlements array/);
});
