import assert from 'node:assert/strict';
import test from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { AnthropicProvider, ModelProviders, OpenRouterProvider, describeOpenRouterModel, estimateInputTokens } from '../src/models/provider.ts';
import { AppError } from '../src/http/errors.ts';
import { fixtureModels } from './support/models.ts';

const row = (overrides: Record<string, unknown> = {}) => ({ id: 'vendor/model:free', context_length: 131072, top_provider: { max_completion_tokens: 8192 },
  supported_parameters: ['tools', 'max_tokens'], architecture: { input_modalities: ['text', 'image'] }, ...overrides });

test('an OpenRouter catalog row is admitted only when every relied-upon field is present and sane', () => {
  assert.deepEqual(describeOpenRouterModel(row()), { id: 'vendor/model:free', efforts: [], maxInputTokens: 131072, maxOutputTokens: 8192, imageInput: true, tools: true });
  assert.equal(describeOpenRouterModel(row({ supported_parameters: ['max_tokens'] }))?.tools, false);
  assert.equal(describeOpenRouterModel(row({ architecture: { input_modalities: ['text'] } }))?.imageInput, false);
  for (const broken of [row({ context_length: undefined }), row({ context_length: 0 }), row({ top_provider: {} }), row({ supported_parameters: 'tools' }),
    row({ architecture: {} }), row({ id: 'bad id' }), null, 'vendor/model:free']) assert.equal(describeOpenRouterModel(broken), undefined);
});

test('the OpenRouter input estimate is explicit, never zero, and overstates text and images', () => {
  const text = estimateInputTokens({ model: 'vendor/model:free', messages: [{ role: 'user', content: 'x'.repeat(3000) }] });
  assert.equal(text.estimated, true);
  assert.ok(text.inputTokens >= 1000, `3000 bytes should reserve at least 1000 tokens, got ${text.inputTokens}`);
  const image = estimateInputTokens({ model: 'vendor/model:free', messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] }] });
  assert.ok(image.inputTokens >= 1600);
  assert.ok(estimateInputTokens({ model: 'vendor/model:free', messages: [] }).inputTokens >= 1);
});

function openRouter(catalog: unknown, configured: readonly string[], status = 200) {
  const writes: string[] = [];
  const provider = new OpenRouterProvider({} as Anthropic, { baseURL: new URL('https://openrouter.example/api/v1'), redis: { set: async (key: string) => { writes.push(key); return 'OK'; } },
    ttlSeconds: 60, configuredModels: async () => configured,
    fetch: (async (url: string | URL | Request) => { assert.equal(String(url), 'https://openrouter.example/api/v1/models'); return new Response(JSON.stringify(catalog), { status }); }) as typeof fetch });
  return { provider, writes };
}

test('OpenRouter admits only configured, tool-capable models from its live catalog', async () => {
  const { provider, writes } = openRouter({ data: [row(), row({ id: 'vendor/other:free' }), row({ id: 'vendor/no-tools:free', supported_parameters: [] })] }, ['vendor/model:free', 'vendor/no-tools:free']);
  const info = await provider.describe('vendor/model:free', new AbortController().signal);
  assert.equal(info.id, 'vendor/model:free');
  assert.equal((await provider.models.get('vendor/model:free')).maxOutputTokens, 8192);
  await assert.rejects(provider.describe('vendor/other:free', new AbortController().signal), /not configured/);
  await assert.rejects(provider.describe('vendor/no-tools:free', new AbortController().signal), /not configured/);
  await assert.rejects(provider.models.get('vendor/other:free'), (error: unknown) => error instanceof AppError && error.code === 'session/model-unavailable');
  assert.deepEqual(writes, ['ai:openrouter-catalog']);
  const count = await provider.countInputTokens({ model: 'vendor/model:free', messages: [{ role: 'user', content: 'hello' }] }, new AbortController().signal);
  assert.equal(count.estimated, true);
});

test('an OpenRouter catalog outage or malformed catalog is an error, not an empty allowlist', async () => {
  await assert.rejects(openRouter({ data: [row()] }, ['vendor/model:free'], 503).provider.describe('vendor/model:free', new AbortController().signal), /status 503/);
  await assert.rejects(openRouter({ models: [] }, ['vendor/model:free']).provider.describe('vendor/model:free', new AbortController().signal), /unexpected shape/);
});

test('Anthropic metadata is verified directly: id, context, output ceiling, efforts and image input', async () => {
  const client = (model: unknown) => ({ models: { retrieve: async () => model }, messages: { countTokens: async () => ({ input_tokens: 7 }) } } as unknown as Anthropic);
  const metadata = { id: 'claude-fixture', capabilities: { effort: { low: { supported: true }, medium: { supported: false } }, image_input: { supported: true } }, max_input_tokens: 1000, max_tokens: 100 };
  const info = await new AnthropicProvider(client(metadata), fixtureModels).describe('claude-fixture', new AbortController().signal);
  assert.deepEqual(info, { id: 'claude-fixture', efforts: ['low'], maxInputTokens: 1000, maxOutputTokens: 100, imageInput: true, tools: true });
  assert.deepEqual((await new AnthropicProvider(client({ ...metadata, capabilities: { image_input: { supported: false } } }), fixtureModels).describe('claude-fixture', new AbortController().signal)).efforts, []);
  for (const broken of [{ ...metadata, id: 'alias' }, { ...metadata, capabilities: null }, { ...metadata, max_input_tokens: null }, { ...metadata, max_tokens: 0 },
    { ...metadata, capabilities: { ...metadata.capabilities, effort: { low: { supported: false } } } }]) {
    await assert.rejects(new AnthropicProvider(client(broken), fixtureModels).describe('claude-fixture', new AbortController().signal));
  }
  const count = await new AnthropicProvider(client(metadata), fixtureModels).countInputTokens({ model: 'claude-fixture', messages: [] }, new AbortController().signal);
  assert.deepEqual(count, { inputTokens: 7, estimated: false });
});

test('a provider the runner was not configured with is reported unavailable, not substituted', () => {
  const providers = new ModelProviders([new AnthropicProvider({} as Anthropic, fixtureModels)]);
  assert.equal(providers.has('openrouter'), false);
  assert.throws(() => providers.get('openrouter'), (error: unknown) => error instanceof AppError && error.code === 'fallback/provider-unavailable' && error.statusCode === 503);
  assert.throws(() => new ModelProviders([new AnthropicProvider({} as Anthropic, fixtureModels), new AnthropicProvider({} as Anthropic, fixtureModels)]), /registered twice/);
});
