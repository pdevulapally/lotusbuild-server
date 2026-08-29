import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveCapability, type CapabilityDefinition } from '../src/entitlements/merge.ts';
import type { EntitlementValue } from '../src/entitlements/values.ts';

const capability = (
  mergeStrategy: CapabilityDefinition['mergeStrategy'],
  valueKind: CapabilityDefinition['valueKind'],
): CapabilityDefinition => ({ key: 'test.capability', valueKind, mergeStrategy, label: 'Test' });

const from = (sourceKey: string, precedence: number, value: EntitlementValue) => ({
  sourceKey,
  precedence,
  value,
});

const number = (value: number): EntitlementValue => ({ kind: 'number', value });
const bool = (value: boolean): EntitlementValue => ({ kind: 'boolean', value });
const list = (value: readonly string[]): EntitlementValue => ({ kind: 'stringList', value });

test('MAX takes the most generous contribution regardless of order', () => {
  const definition = capability('MAX', 'number');
  const ascending = resolveCapability(definition, [
    from('plan', 0, number(3)),
    from('grant', 1, number(25)),
  ]);
  const descending = resolveCapability(definition, [
    from('grant', 1, number(25)),
    from('plan', 0, number(3)),
  ]);
  assert.deepEqual(ascending, descending);
  assert.equal(ascending.value, 25);
});

test('OVERRIDE lets the highest precedence win, not the last one supplied', () => {
  const resolved = resolveCapability(capability('OVERRIDE', 'string'), [
    from('grant', 5, { kind: 'string', value: 'xhigh' }),
    from('plan', 0, { kind: 'string', value: 'low' }),
  ]);
  assert.equal(resolved.value, 'xhigh');
});

test('INTERSECTION keeps only what every source allows', () => {
  const resolved = resolveCapability(capability('INTERSECTION', 'stringList'), [
    from('plan', 0, list(['haiku', 'sonnet', 'opus'])),
    from('trial', 1, list(['haiku', 'sonnet'])),
  ]);
  assert.deepEqual([...(resolved.value as readonly string[])].sort(), ['haiku', 'sonnet']);
});

test('sources sharing a precedence are refused', () => {
  // Equal precedence makes the winner depend on arrival order, which is a
  // silent and irreproducible authorisation result.
  assert.throws(
    () =>
      resolveCapability(capability('OVERRIDE', 'boolean'), [
        from('plan', 1, bool(true)),
        from('promo', 1, bool(false)),
      ]),
    /precedence/i,
  );
});

test('a contribution of the wrong kind is refused', () => {
  assert.throws(() =>
    resolveCapability(capability('MAX', 'number'), [from('plan', 0, bool(true))]),
  );
});

test('a strategy that cannot apply to the declared kind is refused', () => {
  assert.throws(() =>
    resolveCapability(capability('INTERSECTION', 'number'), [from('plan', 0, number(1))]),
  );
});

test('resolving with no contributions is refused rather than returning a default', () => {
  // Falling back here would invent an entitlement nobody granted.
  assert.throws(() => resolveCapability(capability('MAX', 'number'), []));
});
