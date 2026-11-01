import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePlan, parseRegistry } from '../src/entitlements/schema.ts';
import { planDocuments, registryDocument } from '../src/seed/config.ts';
import { voiceLaunchLimits, voicePlanAllowances, withVoicePlan, withVoiceRegistry } from '../src/seed/voice-rows.ts';

test('approved voice launch grants every existing plan bounded time without modifying unrelated configuration', () => {
  const before = structuredClone({ registryDocument, planDocuments });
  const registry = withVoiceRegistry(registryDocument);
  const parsedRegistry = parseRegistry(registry, 'registry');
  assert.deepEqual(withVoiceRegistry(registry), registry);
  assert.deepEqual(Object.fromEntries(Object.entries(registry).filter(([key]) => !['capabilities', 'meters'].includes(key))),
    Object.fromEntries(Object.entries(registryDocument).filter(([key]) => !['capabilities', 'meters'].includes(key))));
  for (const plan of planDocuments) {
    const next = withVoicePlan(plan), parsed = parsePlan(next, plan.key, parsedRegistry);
    const allowance = voicePlanAllowances.find(item => item.planKey === plan.key)!;
    assert.deepEqual(parsed.entitlements.get('voice.enabled'), { kind: 'boolean', value: true });
    assert.deepEqual(parsed.entitlements.get('voice.concurrent'), { kind: 'number', value: 1 });
    assert.deepEqual(parsed.entitlements.get('voice.call.seconds'), { kind: 'number', value: allowance.callSeconds });
    assert.equal(parsed.meterLimits.get('voice.seconds')?.hardLimit, allowance.seconds);
    assert.equal(parsed.meterLimits.get('voice.cost.microgbp')?.hardLimit, 100_000_000);
    assert.equal(parsed.meterLimits.get('voice.seconds')?.overageEnabled, false);
    assert.equal(parsed.meterLimits.get('voice.cost.microgbp')?.overageEnabled, false);
    assert.deepEqual(Object.fromEntries(Object.entries(next).filter(([key]) => !['entitlements', 'meterLimits'].includes(key))),
      Object.fromEntries(Object.entries(plan).filter(([key]) => !['entitlements', 'meterLimits'].includes(key))));
    assert.deepEqual((next['entitlements'] as unknown[]).slice(0, plan.entitlements.length), plan.entitlements);
    assert.deepEqual((next['meterLimits'] as unknown[]).slice(0, plan.meterLimits.length), plan.meterLimits);
    assert.deepEqual(withVoicePlan(next), next);
  }
  assert.deepEqual({ registryDocument, planDocuments }, before);
  assert.equal(voiceLaunchLimits.globalMonthlyMicroGbp, 100 * 1_000_000);
});

test('voice launch refuses conflicting definitions, duplicate rows, missing arrays and unapproved plans', () => {
  const base = withVoiceRegistry(registryDocument), plan = withVoicePlan(planDocuments[0]);
  for (const candidate of [
    { ...registryDocument, capabilities: undefined },
    { ...registryDocument, meters: [...registryDocument.meters, { key: 'voice.seconds', kind: 'GAUGE' }] },
    { ...base, capabilities: [...base['capabilities'] as unknown[], { key: 'voice.enabled' }] },
  ]) assert.throws(() => withVoiceRegistry(candidate));
  for (const candidate of [
    { ...plan, key: 'unapproved' }, { ...plan, entitlements: undefined },
    { ...plan, meterLimits: [...plan['meterLimits'] as unknown[], { meterKey: 'voice.seconds' }] },
    { ...planDocuments[0], entitlements: [...planDocuments[0].entitlements, { capabilityKey: 'voice.enabled', value: { kind: 'boolean', value: false } }] },
  ]) assert.throws(() => withVoicePlan(candidate));
});
