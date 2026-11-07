import { timed } from '../diagnostics/timing.ts';
import type { Firestore } from 'firebase-admin/firestore';

import { type Cached, cached } from '../support/cache.ts';
import { aiRatesDocumentPath, aiRatesVersionPath, parseAiRateTable, type AiRateTable } from './rates.ts';
import { DocumentShapeError } from '../support/documents.ts';
import {
  type Plan,
  type Registry,
  assertSandboxAllowancesAreUsable,
  parsePlan,
  parseRegistry,
} from './schema.ts';

/**
 * Where configuration lives. The whole registry is one document rather than a
 * collection of small ones because it is read together and never in part: a
 * collection would cost one billed read per capability, per meter and per
 * provider on every cache miss.
 */
export const registryDocumentPath = 'config/registry';
export const plansCollectionPath = 'plans';
export { aiRatesDocumentPath } from './rates.ts';

export interface Configuration {
  readonly registry: Registry;
  readonly plans: ReadonlyMap<string, Plan>;
  /** Unified-token rate table; undefined until `config/aiRates` is seeded (shadow accounting then records no unified figure). */
  readonly rates: AiRateTable | undefined;
}

/**
 * Reads and validates the whole configuration as one unit, then holds it for a
 * TTL. Registry and plans are loaded together deliberately — a plan can only be
 * validated against the registry it references, so caching them separately would
 * allow a half-updated pair to be seen as valid.
 */
export class ConfigurationStore {
  readonly #entry: Cached<Configuration>;
  readonly #firestore: Firestore;
  /** Archived tables never change once written, so one read per version per process is enough. */
  readonly #archivedRates = new Map<string, Promise<AiRateTable>>();

  constructor(firestore: Firestore, ttlMs: number) {
    this.#firestore = firestore;
    this.#entry = cached(ttlMs, async (): Promise<Configuration> => {
      const [registrySnapshot, planSnapshots, ratesSnapshot] = await timed('configuration.firestore', () => Promise.all([
        firestore.doc(registryDocumentPath).get(),
        firestore.collection(plansCollectionPath).get(),
        firestore.doc(aiRatesDocumentPath).get(),
      ]));

      if (!registrySnapshot.exists) {
        throw new DocumentShapeError(
          `${registryDocumentPath} does not exist. The configuration has not been seeded.`,
        );
      }

      const registry = parseRegistry(registrySnapshot.data() ?? {}, registryDocumentPath);

      const plans = new Map<string, Plan>();
      for (const snapshot of planSnapshots.docs) {
        const where = `${plansCollectionPath}/${snapshot.id}`;
        const plan = parsePlan(snapshot.data(), where, registry);
        if (plan.key !== snapshot.id) {
          // The document id is what every reference uses; a mismatched key field
          // would make the same plan resolve differently depending on the path in.
          throw new DocumentShapeError(
            `${where}: the document id and its "key" field ("${plan.key}") disagree.`,
          );
        }
        plans.set(plan.key, plan);
      }

      if (!plans.has(registry.defaultPlanKey)) {
        throw new DocumentShapeError(
          `${registryDocumentPath}: defaultPlanKey "${registry.defaultPlanKey}" names no plan, so ` +
            'a user without a subscription could not be entitled at all.',
        );
      }

      const defaultPlan = plans.get(registry.defaultPlanKey);
      if (defaultPlan !== undefined && defaultPlan.price !== undefined) {
        // Everyone already holds the default plan, so putting it up for sale
        // would charge for something the buyer cannot fail to have.
        throw new DocumentShapeError(
          `${plansCollectionPath}/${defaultPlan.key}: the default plan carries a price, but the ` +
            'plan everybody already has cannot be sold.',
        );
      }

      if (registry.fallback !== undefined) {
        for (const key of registry.fallback.eligiblePlanKeys) {
          const plan = plans.get(key);
          if (plan === undefined) throw new DocumentShapeError('Fallback policy names an absent plan.');
          for (const meterKey of [registry.fallback.inputTokenMeterKey, registry.fallback.outputTokenMeterKey]) {
            const limit = plan.meterLimits.get(meterKey);
            if (limit === undefined || limit.hardLimit <= 0 || limit.overageEnabled) throw new DocumentShapeError('Fallback requires explicit bounded allowances without automatic overage for every eligible plan.');
          }
        }
      }
      assertSandboxAllowancesAreUsable(registry, [...plans.values()], registry.sandboxTimeMeterKey);

      const rates = ratesSnapshot.exists ? parseAiRateTable(ratesSnapshot.data() ?? {}, aiRatesDocumentPath) : undefined;
      return { registry, plans, rates };
    });
  }

  get(): Promise<Configuration> {
    return timed('configuration.get', () => this.#entry.get());
  }

  /**
   * The rate table a hold was admitted under, by version: the current table when
   * it still carries that version, otherwise the archived copy. A version found
   * nowhere is an error the caller must surface, never a different table — the
   * reservation says what it was priced at, and settlement may not re-price it.
   */
  async ratesByVersion(version: string): Promise<AiRateTable> {
    const { rates } = await this.get();
    if (rates !== undefined && rates.version === version) return rates;
    let pending = this.#archivedRates.get(version);
    if (pending === undefined) {
      const path = aiRatesVersionPath(version);
      pending = this.#firestore.doc(path).get().then((snapshot) => {
        if (!snapshot.exists) throw new DocumentShapeError(`${path} does not exist: the rate table this hold was admitted under is unavailable.`);
        const table = parseAiRateTable(snapshot.data() ?? {}, path);
        if (table.version !== version) throw new DocumentShapeError(`${path} carries version "${table.version}", not "${version}".`);
        return table;
      });
      pending.catch(() => this.#archivedRates.delete(version));
      this.#archivedRates.set(version, pending);
    }
    return pending;
  }

  /** Forces the next read to reload, after configuration is edited by hand. */
  invalidate(): void {
    this.#entry.invalidate();
  }
}
