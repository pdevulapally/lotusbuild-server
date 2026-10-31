import { timed } from '../diagnostics/timing.ts';
import type { Firestore } from 'firebase-admin/firestore';

import { type Cached, cached } from '../support/cache.ts';
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

export interface Configuration {
  readonly registry: Registry;
  readonly plans: ReadonlyMap<string, Plan>;
}

/**
 * Reads and validates the whole configuration as one unit, then holds it for a
 * TTL. Registry and plans are loaded together deliberately — a plan can only be
 * validated against the registry it references, so caching them separately would
 * allow a half-updated pair to be seen as valid.
 */
export class ConfigurationStore {
  readonly #entry: Cached<Configuration>;

  constructor(firestore: Firestore, ttlMs: number) {
    this.#entry = cached(ttlMs, async (): Promise<Configuration> => {
      const [registrySnapshot, planSnapshots] = await timed('configuration.firestore', () => Promise.all([
        firestore.doc(registryDocumentPath).get(),
        firestore.collection(plansCollectionPath).get(),
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

      return { registry, plans };
    });
  }

  get(): Promise<Configuration> {
    return timed('configuration.get', () => this.#entry.get());
  }

  /** Forces the next read to reload, after configuration is edited by hand. */
  invalidate(): void {
    this.#entry.invalidate();
  }
}
