import Anthropic from '@anthropic-ai/sdk';
import type { MessageCountTokensParams } from '@anthropic-ai/sdk/resources/messages';
import type { Redis } from 'ioredis';
import { aiEfforts, type AiEffort } from '../entitlements/build-admission.ts';
import { AppError } from '../http/errors.ts';
import { cached, type Cached } from '../support/cache.ts';
import type { ModelDescriptor, ModelResolver } from './catalog.ts';

export const modelProviderKeys = ['anthropic', 'openrouter'] as const;
export type ModelProviderKey = (typeof modelProviderKeys)[number];

/** What a dispatch must know about a model before trusting it with a saved task. */
export interface FallbackModelInfo {
  readonly id: string;
  /** Empty when the model takes no effort setting, matching `ModelDescriptor.efforts`. */
  readonly efforts: readonly AiEffort[];
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly imageInput: boolean;
  readonly tools: boolean;
}

export interface TokenCount {
  readonly inputTokens: number;
  /** True when the provider offers no count endpoint and this is a conservative upper bound the stream's reported usage settles. */
  readonly estimated: boolean;
}

/**
 * One inference provider. Every provider speaks the Anthropic Messages format
 * (OpenRouter serves it natively), so the agent loop keeps a single wire shape
 * and only metadata and token counting differ per provider.
 */
export interface ModelProvider {
  readonly key: ModelProviderKey;
  readonly client: Anthropic;
  readonly models: ModelResolver;
  describe(id: string, signal: AbortSignal): Promise<FallbackModelInfo>;
  countInputTokens(params: MessageCountTokensParams, signal: AbortSignal): Promise<TokenCount>;
}

/** Providers the runner was started with. A provider named by policy but not configured is an explicit unavailable state, never a silent substitution. */
export class ModelProviders {
  readonly #providers = new Map<ModelProviderKey, ModelProvider>();

  constructor(providers: readonly ModelProvider[]) {
    for (const provider of providers) {
      if (this.#providers.has(provider.key)) throw new Error(`Model provider "${provider.key}" is registered twice.`);
      this.#providers.set(provider.key, provider);
    }
  }

  has(key: ModelProviderKey): boolean { return this.#providers.has(key); }

  get(key: ModelProviderKey): ModelProvider {
    const provider = this.#providers.get(key);
    if (provider === undefined) {
      throw new AppError({ code: 'fallback/provider-unavailable', statusCode: 503,
        message: 'The configured fallback provider is not available on this runner.', details: { provider: key } });
    }
    return provider;
  }
}

const providerEfforts = { low: 'low', standard: 'medium', high: 'high', xhigh: 'xhigh' } as const;

export class AnthropicProvider implements ModelProvider {
  readonly key = 'anthropic' as const;
  readonly client: Anthropic;
  readonly models: ModelResolver;
  constructor(client: Anthropic, models: ModelResolver) { this.client = client; this.models = models; }

  async describe(id: string, signal: AbortSignal): Promise<FallbackModelInfo> {
    const info = await this.client.models.retrieve(id, undefined, { signal });
    const capabilities = info.capabilities as { effort?: Record<string, { supported?: boolean } | undefined> | null; image_input?: { supported?: boolean } | null } | null | undefined;
    if (info.id !== id || capabilities == null || info.max_input_tokens == null || !Number.isSafeInteger(info.max_input_tokens) || info.max_input_tokens <= 0 ||
        info.max_tokens == null || !Number.isSafeInteger(info.max_tokens) || info.max_tokens <= 0) {
      throw new Error('Anthropic did not describe this model well enough to trust it with a saved task.');
    }
    const effort = capabilities.effort;
    const efforts = effort == null ? [] : aiEfforts.filter((level) => effort[providerEfforts[level]]?.supported === true);
    if (effort != null && efforts.length === 0) throw new Error('Anthropic lists no supported effort for this model.');
    return { id, efforts, maxInputTokens: info.max_input_tokens, maxOutputTokens: info.max_tokens, imageInput: capabilities.image_input?.supported === true, tools: true };
  }

  async countInputTokens(params: MessageCountTokensParams, signal: AbortSignal): Promise<TokenCount> {
    const count = await this.client.messages.countTokens(params, { signal });
    if (!Number.isSafeInteger(count.input_tokens) || count.input_tokens <= 0) throw new Error('Anthropic returned no usable input-token estimate.');
    return { inputTokens: count.input_tokens, estimated: false };
  }
}

/** Model identifiers across providers: OpenRouter's carry a vendor prefix and a variant suffix (`google/gemma-4-31b-it:free`). */
export const modelIdentifierPattern = '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$';
const identifier = new RegExp(modelIdentifierPattern);
const openRouterCatalogKey = 'ai:openrouter-catalog';
const maximumRows = 2048;
/** Conservative text estimate: real tokenisers average about four bytes per token; three overstates, so the hold is never short. */
const bytesPerToken = 3;
/** Anthropic's own ceiling for one image block (≈1.15 MP at 750 px² per token). */
const tokensPerImage = 1600;

/** The subset of an OpenRouter `/models` row this runner relies on. Anything missing disqualifies the model rather than being guessed. */
export function describeOpenRouterModel(row: unknown): FallbackModelInfo | undefined {
  if (row === null || typeof row !== 'object') return undefined;
  const fields = row as Record<string, unknown>;
  const id = fields['id'];
  const architecture = fields['architecture'] as Record<string, unknown> | undefined;
  const top = fields['top_provider'] as Record<string, unknown> | undefined;
  const context = fields['context_length'];
  const maxOutput = top?.['max_completion_tokens'];
  const parameters = fields['supported_parameters'];
  const modalities = architecture?.['input_modalities'];
  if (typeof id !== 'string' || !identifier.test(id) || !Number.isSafeInteger(context) || (context as number) <= 0 ||
      !Number.isSafeInteger(maxOutput) || (maxOutput as number) <= 0 || !Array.isArray(parameters) || !Array.isArray(modalities)) return undefined;
  return { id, efforts: [], maxInputTokens: context as number, maxOutputTokens: maxOutput as number,
    imageInput: modalities.includes('image'), tools: parameters.includes('tools') };
}

export function estimateInputTokens(params: MessageCountTokensParams): TokenCount {
  let images = 0;
  for (const message of params.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === 'image') images += 1;
      else if (block.type === 'tool_result' && Array.isArray(block.content)) images += block.content.filter((part) => part.type === 'image').length;
    }
  }
  const bytes = Buffer.byteLength(JSON.stringify({ system: params.system, messages: params.messages, tools: params.tools }), 'utf8');
  return { inputTokens: Math.max(1, Math.ceil(bytes / bytesPerToken)) + images * tokensPerImage, estimated: true };
}

/**
 * OpenRouter through its Anthropic-Messages-format endpoint. Only models the
 * live configuration names are admitted, from the provider's own catalog, so no
 * model ID enters by code. OpenRouter has no token-count endpoint; `countInputTokens`
 * returns an explicit over-estimate and the stream's usage settles the hold.
 */
export class OpenRouterProvider implements ModelProvider {
  readonly key = 'openrouter' as const;
  readonly client: Anthropic;
  readonly models: ModelResolver;
  readonly #catalog: Cached<ReadonlyMap<string, FallbackModelInfo>>;

  constructor(client: Anthropic, options: {
    readonly baseURL: URL;
    readonly redis: Pick<Redis, 'set'>;
    readonly ttlSeconds: number;
    readonly configuredModels: () => Promise<readonly string[]>;
    readonly fetch?: typeof fetch;
  }) {
    this.client = client;
    const load = options.fetch ?? fetch;
    const url = new URL(options.baseURL.toString().replace(/\/?$/, '/') + 'models');
    this.#catalog = cached(options.ttlSeconds * 1000, async () => {
      const wanted = new Set((await options.configuredModels()).filter((id) => identifier.test(id)));
      const response = await load(url, { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`OpenRouter catalog request failed with status ${response.status}.`);
      const body = (await response.json()) as { data?: unknown };
      if (!Array.isArray(body.data) || body.data.length > maximumRows) throw new Error('OpenRouter catalog has an unexpected shape.');
      const rows = new Map<string, FallbackModelInfo>();
      for (const raw of body.data) {
        const row = describeOpenRouterModel(raw);
        if (row !== undefined && wanted.has(row.id) && row.tools) rows.set(row.id, row);
      }
      const models = [...rows.values()].map((row): ModelDescriptor => ({ id: row.id, name: row.id, efforts: row.efforts, maxOutputTokens: row.maxOutputTokens }));
      await options.redis.set(openRouterCatalogKey, JSON.stringify({ models, expiresAt: Date.now() + options.ttlSeconds * 1000 }), 'EX', options.ttlSeconds * 2);
      return rows;
    });
    this.models = {
      get: async (id) => {
        const row = (await this.#catalog.get()).get(id);
        if (row === undefined) throw new AppError({ code: 'session/model-unavailable', statusCode: 400,
          message: 'This model is no longer available. Refresh the model list and select another model.' });
        return { id: row.id, name: row.id, efforts: row.efforts, maxOutputTokens: row.maxOutputTokens };
      },
    };
  }

  async refresh(): Promise<void> { await this.#catalog.get(); }

  async describe(id: string, signal: AbortSignal): Promise<FallbackModelInfo> {
    signal.throwIfAborted();
    const row = (await this.#catalog.get()).get(id);
    if (row === undefined) throw new Error('OpenRouter does not list this model with tool support, or it is not configured.');
    return row;
  }

  async countInputTokens(params: MessageCountTokensParams, signal: AbortSignal): Promise<TokenCount> {
    signal.throwIfAborted();
    return estimateInputTokens(params);
  }
}

export { providerEfforts };
