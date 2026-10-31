import assert from 'node:assert/strict';
import test from 'node:test';

import { withUnlimitedProjects } from '../src/seed/project-cap-row.ts';
import { planDocuments } from '../src/seed/config.ts';

test('lifting the project cap edits one entitlement row and nothing else', () => {
  const plan = { ...planDocuments[1], entitlements: planDocuments[1]!.entitlements.map((row) => ({ ...row })) } as Record<string, unknown>;
  const { fields, changes } = withUnlimitedProjects(plan);
  assert.deepEqual(changes, [{ capabilityKey: 'projects.max', from: { kind: 'number', value: 25 }, to: { kind: 'number', value: 'unlimited' } }]);
  const before = planDocuments[1]!.entitlements;
  const after = fields['entitlements'] as readonly { capabilityKey: string; value: unknown }[];
  assert.equal(after.length, before.length);
  after.forEach((row, index) => {
    if (row.capabilityKey !== 'projects.max') assert.deepEqual(row, before[index]);
  });
  assert.equal(fields['name'], plan['name']);
  assert.deepEqual(plan['entitlements'], planDocuments[1]!.entitlements, 'the input is not mutated');
});

test('an already unlimited plan reports nothing to change', () => {
  assert.deepEqual(withUnlimitedProjects(planDocuments[0] as unknown as Record<string, unknown>).changes, []);
});

test('a plan without a project cap row is refused rather than silently extended', () => {
  assert.throws(() => withUnlimitedProjects({ entitlements: [{ capabilityKey: 'ai.run', value: { kind: 'boolean', value: true } }] }), /no projects\.max/);
  assert.throws(() => withUnlimitedProjects({}), /no entitlements array/);
});
