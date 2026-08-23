import { parseArgs } from 'node:util';

import { EnvironmentError, loadConfig } from '../config/index.ts';
import { EntitlementService } from '../entitlements/service.ts';
import { ConfigurationStore, plansCollectionPath, registryDocumentPath } from '../entitlements/store.ts';
import { SubscriptionCache } from '../entitlements/subscription-cache.ts';
import { initialiseFirebase } from '../firebase.ts';
import { connectRedis } from '../redis/client.ts';
import { planDocuments, registryDocument } from './config.ts';

/**
 * Writes the recovered plan and capability configuration into Firestore.
 *
 * Seeding is destructive: once running, plans and limits are rows an operator
 * edits directly, and re-running this would silently revert those edits — which
 * on a limit means either refusing paying customers or handing out capacity
 * nobody is charged for. So it refuses to overwrite unless told to, by name.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      overwrite: { type: 'boolean', default: false },
    },
    strict: true,
  });

  const config = loadConfig();
  const { firestore } = initialiseFirebase(config);

  const registryRef = firestore.doc(registryDocumentPath);
  const existing = await registryRef.get();
  if (existing.exists && values.overwrite !== true) {
    process.stderr.write(
      `${registryDocumentPath} already exists in project "${config.FIREBASE_PROJECT_ID}".\n` +
        'Re-seeding would discard any limits edited since. Pass --overwrite to replace it.\n',
    );
    process.exit(1);
  }

  const batch = firestore.batch();
  batch.set(registryRef, registryDocument);
  for (const plan of planDocuments) {
    // The document id is the plan key, so a reference can never point at a plan
    // whose key field disagrees with the path it was read from.
    batch.set(firestore.doc(`${plansCollectionPath}/${plan.key}`), plan);
  }
  await batch.commit();

  process.stdout.write(
    `Wrote ${registryDocumentPath} and ${planDocuments.length} plans to ` +
      `"${config.FIREBASE_PROJECT_ID}".\n`,
  );

  // Read it back through the same code paths the server uses. Writing valid JSON
  // is not the same as writing valid configuration: this is what proves the
  // cross-references, the allowance invariant and every merge strategy hold.
  const store = new ConfigurationStore(firestore, 1000);
  const redis = await connectRedis(
    config,
    (error) => {
      process.stderr.write(`redis: ${error.message}
`);
    },
    'lotusbuild-seed',
  );
  const { registry, plans } = await store.get();
  process.stdout.write(
    `Validated: ${registry.capabilities.size} capabilities, ${registry.meters.size} meters, ` +
      `${registry.sandboxProviders.size} sandbox providers, ${plans.size} plans.\n`,
  );

  // Resolving for a user with no subscription exercises the default-plan path,
  // which is what every new signup gets.
  const entitlements = new EntitlementService(
    firestore,
    store,
    new SubscriptionCache(redis, config.SUBSCRIPTION_CACHE_TTL_SECONDS),
  );
  const resolved = await entitlements.forUser('seed-verification-no-such-user');
  process.stdout.write(
    `Default plan resolves to "${resolved.planKey}" with ` +
      `${resolved.capabilities.keys().length} capabilities and ${resolved.meterLimits.size} limits.\n`,
  );

  await redis.quit();
}

main().catch((error: unknown) => {
  if (error instanceof EnvironmentError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  }
  process.exit(1);
});
