import Anthropic from '@anthropic-ai/sdk';
import type { ModelInfo } from '@anthropic-ai/sdk/resources/models';
import type { Redis } from 'ioredis';
import { aiEfforts, type AiEffort } from '../entitlements/build-admission.ts';
import type { UserEntitlements } from '../entitlements/service.ts';
import { AppError } from '../http/errors.ts';
import { cached, type Cached } from '../support/cache.ts';

const catalogKey = 'ai:model-catalog';
const maximumModels = 256;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const providerEfforts = { low: 'low', standard: 'medium', high: 'high', xhigh: 'xhigh' } as const;

export interface ModelDescriptor {
  readonly id: string;
  readonly name: string;
  readonly efforts: readonly AiEffort[];
  readonly maxOutputTokens: number;
}

export interface ModelResolver {
  get(id: string): Promise<ModelDescriptor>;
}

export function describeModel(id: string, model: ModelInfo): ModelDescriptor | undefined {
  if (!identifier.test(id) || (model as ModelInfo & { lifecycle?: string }).lifecycle === 'retired' || model.capabilities == null ||
    !Number.isSafeInteger(model.max_tokens) || model.max_tokens! <= 0) return undefined;
  const effort = model.capabilities.effort;
  if (typeof model.display_name !== 'string' || !model.display_name.trim() || model.display_name.length > 160 ||
    !effort || typeof effort.supported !== 'boolean') return undefined;
  const efforts = effort.supported ? aiEfforts.filter(level => effort[providerEfforts[level]]?.supported === true) : [];
  if (effort.supported && efforts.length === 0) return undefined;
  return { id, name: model.display_name, maxOutputTokens: model.max_tokens!, efforts };
}

export function modelOutputConfig(model: ModelDescriptor, effort: AiEffort) {
  if (model.efforts.length === 0) return undefined;
  if (!model.efforts.includes(effort)) {
    throw new AppError({ code: 'session/effort-unsupported', statusCode: 400,
      message: 'This model does not support the selected effort. Choose a supported effort and start a new session.' });
  }
  return { effort: providerEfforts[effort] };
}

export class ProviderModels implements ModelResolver {
  readonly #catalog: Cached<readonly ModelDescriptor[]>;

  constructor(client: Anthropic, redis: Pick<Redis, 'set'>, ttlSeconds: number,
    configuredModels: () => Promise<readonly string[]>) {
    this.#catalog = cached(ttlSeconds * 1000, async () => {
      const rows = new Map<string, ModelDescriptor>();
      let inspected = 0;
      for await (const model of client.models.list({ limit: 100 }, { timeout: 15_000, maxRetries: 0 })) {
        if (inspected++ >= maximumModels) break;
        const row = describeModel(model.id, model);
        if (row !== undefined) rows.set(row.id, row);
      }
      const aliases = [...new Set(await configuredModels())].filter(id => identifier.test(id));
      if (aliases.length > maximumModels) throw new Error('Configured model catalog exceeds its budget.');
      for (const id of aliases) {
        if (rows.has(id)) continue;
        try {
          const row = describeModel(id, await client.models.retrieve(id, {}, { timeout: 15_000, maxRetries: 0 }));
          if (row !== undefined) rows.set(id, row);
        } catch (error) {
          if (!(error instanceof Anthropic.APIError) || error.status !== 404) throw error;
        }
      }
      const models = [...rows.values()];
      await redis.set(catalogKey, JSON.stringify({models, expiresAt: Date.now() + ttlSeconds * 1000}), 'EX', ttlSeconds * 2);
      return models;
    });
  }

  async refresh(): Promise<void> { await this.#catalog.get(); }

  async get(id: string): Promise<ModelDescriptor> {
    const model = (await this.#catalog.get()).find(row => row.id === id);
    if (model === undefined) throw new AppError({ code: 'session/model-unavailable', statusCode: 400,
      message: 'This model is no longer available. Refresh the model list and select another model.' });
    return model;
  }
}

export async function allowedModelCatalog(redis: Pick<Redis, 'get'>, entitlements: UserEntitlements): Promise<readonly ModelDescriptor[]> {
  const raw = await redis.get(catalogKey);
  if (raw === null) return [];
  let rows: unknown;
  try {
    const snapshot = JSON.parse(raw);
    if (!snapshot || !Number.isSafeInteger(snapshot.expiresAt) || snapshot.expiresAt <= Date.now()) return [];
    rows = snapshot.models;
  } catch { return []; }
  if (!Array.isArray(rows) || rows.length > maximumModels * 2) return [];
  const maximum = aiEfforts.indexOf(entitlements.capabilities.string('ai.effort') as AiEffort);
  if (maximum < 0 || !entitlements.capabilities.boolean('ai.run')) return [];
  return rows.filter((row): row is ModelDescriptor => row !== null && typeof row === 'object' &&
    typeof row.id === 'string' && identifier.test(row.id) && typeof row.name === 'string' && row.name.length > 0 && row.name.length <= 160 &&
    Number.isSafeInteger(row.maxOutputTokens) && row.maxOutputTokens > 0 && Array.isArray(row.efforts) &&
    row.efforts.every((effort: unknown) => aiEfforts.includes(effort as AiEffort)) &&
    entitlements.capabilities.allows('ai.model.allowlist', row.id))
    .filter(row => row.efforts.length === 0 || row.efforts.some(effort => aiEfforts.indexOf(effort) <= maximum))
    .map(row => ({ id: row.id, name: row.name, maxOutputTokens: row.maxOutputTokens,
      efforts: aiEfforts.filter(effort => row.efforts.includes(effort) && aiEfforts.indexOf(effort) <= maximum) }));
}

export function assertModelSelection(models: readonly ModelDescriptor[], id: string, effort?: AiEffort): void {
  const model = models.find(row => row.id === id);
  if (model === undefined) throw new AppError({ code: 'session/model-unavailable', statusCode: 503,
    message: 'Model capabilities are unavailable. Refresh the model list before starting a session.' });
  if (effort !== undefined && !model.efforts.includes(effort)) throw new AppError({
    code: 'session/effort-unsupported', statusCode: 400,
    message: 'The selected effort is not available for this model on your plan.' });
}
