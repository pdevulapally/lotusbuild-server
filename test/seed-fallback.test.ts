import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePlan, parseRegistry } from '../src/entitlements/schema.ts';
import { planDocuments, registryDocument } from '../src/seed/config.ts';
import { fallbackAllowances, fallbackPolicyDocument, withFallbackAllowances, withFallbackPolicy } from '../src/seed/fallback-rows.ts';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

test('the fallback edit yields configuration the server accepts, with premium rows untouched', () => {
  const registry = withFallbackPolicy(clone(registryDocument) as Record<string, unknown>);
  assert.equal(registry.changes.length, 3, 'two meters and the policy');
  const parsed = parseRegistry(registry.fields, 'registry');
  assert.equal(parsed.fallback?.model, fallbackPolicyDocument.model);
  assert.equal((registry.fields['meters'] as unknown[]).length, registryDocument.meters.length + 2);
  for (const allowance of fallbackAllowances) {
    const source = planDocuments.find((plan) => plan.key === allowance.planKey)!;
    const plan = withFallbackAllowances(clone(source) as Record<string, unknown>, allowance);
    assert.equal(plan.changes.length, 2);
    const result = parsePlan(plan.fields, `plans/${allowance.planKey}`, parsed);
    assert.equal(result.meterLimits.get('ai.fallback.tokens.output')?.hardLimit, allowance.outputTokens);
    assert.equal(result.meterLimits.get('ai.fallback.tokens.output')?.overageEnabled, false);
    assert.deepEqual(result.meterLimits.get('ai.tokens.output'), parsePlan(source as unknown as Record<string, unknown>, 'plans/x', parsed).meterLimits.get('ai.tokens.output'));
  }
});

test('re-running reports nothing to change', () => {
  const registry = withFallbackPolicy(clone(registryDocument) as Record<string, unknown>);
  assert.deepEqual(withFallbackPolicy(registry.fields).changes, []);
  const plan = withFallbackAllowances(clone(planDocuments[0]) as Record<string, unknown>, fallbackAllowances[0]!);
  assert.deepEqual(withFallbackAllowances(plan.fields, fallbackAllowances[0]!).changes, []);
});

test('a meter that already exists with another meaning is refused', () => {
  const registry = clone(registryDocument) as Record<string, unknown>;
  (registry['meters'] as unknown[]).push({ key: 'ai.fallback.tokens.input', unit: 'count', kind: 'GAUGE', resetPeriod: 'NEVER', label: 'x' });
  assert.throws(() => withFallbackPolicy(registry), /different definition/);
  assert.throws(() => withFallbackPolicy({}), /no meters array/);
  assert.throws(() => withFallbackAllowances({}, fallbackAllowances[0]!), /no meterLimits array/);
});
