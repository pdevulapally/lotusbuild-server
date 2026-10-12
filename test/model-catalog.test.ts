import assert from 'node:assert/strict';
import test from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import type { ModelInfo } from '@anthropic-ai/sdk/resources/models';
import type { Redis } from 'ioredis';
import { ResolvedEntitlements, type UserEntitlements } from '../src/entitlements/service.ts';
import type { EntitlementValue } from '../src/entitlements/values.ts';
import { allowedModelCatalog, assertModelSelection, describeModel, modelOutputConfig, ProviderModels } from '../src/models/catalog.ts';

function model(supported: boolean, levels = ['low', 'medium', 'high']) {
  return {id: 'provider-model-v1', display_name: 'Provider model', max_tokens: 8192,
    capabilities: {effort: {supported, ...Object.fromEntries(['low', 'medium', 'high', 'xhigh', 'max'].map(level => [level, {supported: supported && levels.includes(level)}]))}}} as unknown as ModelInfo;
}
const native = describeModel('native-alias', model(false))!;
const adjustable = describeModel('adjustable-alias', model(true))!;
function account(allowlist: string[] = [], effort = 'standard'): UserEntitlements {
  return {capabilities: new ResolvedEntitlements(new Map<string, EntitlementValue>([
    ['ai.run', {kind: 'boolean', value: true}], ['ai.effort', {kind: 'string', value: effort}],
    ['ai.model.allowlist', {kind: 'stringList', value: allowlist}],
  ]))} as UserEntitlements;
}
function snapshot(models: unknown[], expiresAt = Date.now() + 60_000) {
  return {get: async () => JSON.stringify({models, expiresAt})} as Pick<Redis, 'get'>;
}

test('effort support and aliases are derived exclusively from provider metadata', () => {
  assert.deepEqual(native.efforts, []);
  assert.deepEqual(adjustable.efforts, ['low', 'standard', 'high']);
  assert.deepEqual(describeModel('future-model', model(true, ['medium', 'xhigh']))?.efforts, ['standard', 'xhigh']);
  assert.equal(modelOutputConfig(native, 'high'), undefined);
  assert.deepEqual(modelOutputConfig(adjustable, 'standard'), {effort: 'medium'});
  assert.throws(() => modelOutputConfig(adjustable, 'xhigh'), /does not support/);
});
test('retired, malformed, missing and unsafe provider metadata is not selectable', () => {
  for (const metadata of [{...model(true), lifecycle: 'retired'}, {...model(true), capabilities: null},
    {...model(true), capabilities: {}}, {...model(true), max_tokens: 0}, {...model(true), display_name: ''}]) {
    assert.equal(describeModel('alias', metadata as ModelInfo), undefined);
  }
  assert.equal(describeModel('invalid/id', model(true)), undefined);
  assert.equal(describeModel('alias', model(true, ['max'])), undefined);
});
test('account allowlists intersect provider models and plan effort ceilings', async () => {
  assert.deepEqual(await allowedModelCatalog(snapshot([native, adjustable]), account(['adjustable-alias'])),
    [{...adjustable, efforts: ['low', 'standard']}]);
  assert.equal((await allowedModelCatalog(snapshot([native, adjustable]), account())).length, 2);
  assert.deepEqual(await allowedModelCatalog(snapshot([native]), account([], 'unknown')), []);
  assert.deepEqual(await allowedModelCatalog(snapshot([{...adjustable, efforts: ['high']}]), account([], 'low')), []);
});
test('expired or corrupt shared catalog fails closed and strips unrecognized fields', async () => {
  assert.deepEqual(await allowedModelCatalog(snapshot([native], Date.now() - 1), account()), []);
  assert.deepEqual(await allowedModelCatalog({get: async () => 'broken'} as Pick<Redis, 'get'>, account()), []);
  assert.deepEqual(await allowedModelCatalog(snapshot([{...native, privateField: 'never public'}]), account()), [native]);
  assert.deepEqual(await allowedModelCatalog(snapshot([{...native, efforts: ['invalid']}]), account()), []);
});
test('explicit unsupported efforts and unavailable models are rejected before admission', () => {
  assertModelSelection([native], native.id);
  assert.throws(() => assertModelSelection([native], native.id, 'low'), /not available/);
  assert.throws(() => assertModelSelection([adjustable], adjustable.id, 'xhigh'), /not available/);
  assert.throws(() => assertModelSelection([], adjustable.id), /unavailable/);
});
test('runner publishes only descriptors, retrieves configured aliases, and coalesces refreshes', async () => {
  let listed = 0;
  const retrieved: string[] = [];
  let published = '';
  const client = {models: {list: async function* () {listed++; yield model(true);}, retrieve: async (id: string) => {retrieved.push(id); return model(false);}}} as unknown as Anthropic;
  const redis = {set: async (_key: string, value: string) => {published = value; return 'OK';}} as unknown as Pick<Redis, 'set'>;
  const catalog = new ProviderModels(client, redis, 60, async () => ['native-alias', 'native-alias']);
  await Promise.all([catalog.refresh(), catalog.refresh()]);
  assert.equal(listed, 1);
  assert.deepEqual(retrieved, ['native-alias']);
  assert.deepEqual(await catalog.get('native-alias'), native);
  assert.ok(JSON.parse(published).expiresAt > Date.now());
  assert.equal(published.includes('capabilities'), false);
  await assert.rejects(catalog.get('missing'), /no longer available/);
});
test('failed provider refresh does not fall back to invented capabilities or publish', async () => {
  let written = false;
  const client = {models: {list: async function* () {throw new Error('provider unavailable');}}} as unknown as Anthropic;
  const redis = {set: async () => {written = true;}} as unknown as Pick<Redis, 'set'>;
  const catalog = new ProviderModels(client, redis, 60, async () => []);
  await assert.rejects(catalog.get('any-model'), /provider unavailable/);
  assert.equal(written, false);
});
