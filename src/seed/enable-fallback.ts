import { parseArgs } from 'node:util';

import { EnvironmentError, loadConfig } from '../config/index.ts';
import { parsePlan, parseRegistry } from '../entitlements/schema.ts';
import { ConfigurationStore, plansCollectionPath, registryDocumentPath } from '../entitlements/store.ts';
import { initialiseFirebase } from '../firebase.ts';
import { fallbackAllowances, fallbackPolicyDocument, withFallbackAllowances, withFallbackPolicy, type FallbackChange } from './fallback-rows.ts';

/**
 * Switches on the approved fallback lane by editing live configuration: the two
 * fallback meters and the policy on the registry, and bounded, non-billing
 * allowances on every eligible plan.
 *
 *   node --env-file=.env dist/seed/enable-fallback.js            show what would change
 *   node --env-file=.env dist/seed/enable-fallback.js --apply    make the change
 *
 * The default is a dry run. Applying happens in one transaction that re-reads
 * every document, proves the edited set valid through the same parsers the API
 * uses, and writes only the touched fields. Premium meters, limits and every
 * other plan field are untouched. The API and runner pick the change up when
 * their cached configuration expires; no restart.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { apply: { type: 'boolean', default: false } }, strict: true });
  const config = loadConfig();
  const { firestore } = initialiseFirebase(config);
  const registryRef = firestore.doc(registryDocumentPath);

  const outcome = await firestore.runTransaction(async (transaction) => {
    const registrySnapshot = await transaction.get(registryRef);
    if (!registrySnapshot.exists) throw new Error(`${registryDocumentPath} does not exist in "${config.FIREBASE_PROJECT_ID}"; seed it first.`);
    const planRefs = fallbackAllowances.map((allowance) => firestore.doc(`${plansCollectionPath}/${allowance.planKey}`));
    const planSnapshots = await Promise.all(planRefs.map((ref) => transaction.get(ref)));

    const registry = withFallbackPolicy(registrySnapshot.data() ?? {});
    const parsedRegistry = parseRegistry(registry.fields, registryDocumentPath);
    const changes: { path: string; changes: readonly FallbackChange[] }[] = [{ path: registryDocumentPath, changes: registry.changes }];
    const planWrites: { ref: FirebaseFirestore.DocumentReference; meterLimits: unknown }[] = [];
    planSnapshots.forEach((snapshot, index) => {
      const allowance = fallbackAllowances[index]!;
      if (!snapshot.exists) throw new Error(`${snapshot.ref.path} does not exist in "${config.FIREBASE_PROJECT_ID}".`);
      const plan = withFallbackAllowances(snapshot.data() ?? {}, allowance);
      parsePlan(plan.fields, snapshot.ref.path, parsedRegistry);
      changes.push({ path: snapshot.ref.path, changes: plan.changes });
      if (plan.changes.length > 0) planWrites.push({ ref: snapshot.ref, meterLimits: plan.fields['meterLimits'] });
    });

    if (values.apply === true) {
      if (registry.changes.length > 0) transaction.update(registryRef, { meters: registry.fields['meters'], fallback: fallbackPolicyDocument });
      for (const write of planWrites) transaction.update(write.ref, { meterLimits: write.meterLimits });
    }
    return changes;
  });

  process.stdout.write(`Project "${config.FIREBASE_PROJECT_ID}":\n`);
  let total = 0;
  for (const document of outcome) {
    for (const change of document.changes) {
      total += 1;
      process.stdout.write(`  ${document.path} ${change.path}: ${JSON.stringify(change.from)} -> ${JSON.stringify(change.to)}\n`);
    }
  }
  if (total === 0) { process.stdout.write('  nothing to change: the fallback lane is already configured.\n'); return; }
  if (values.apply !== true) { process.stdout.write('Dry run: nothing was written. Pass --apply to make this change.\n'); return; }

  const { registry } = await new ConfigurationStore(firestore, 1000).get();
  process.stdout.write(`Applied. Fallback is ${registry.fallback?.model ?? 'unset'} via ${registry.fallback?.provider ?? 'unset'} for ${registry.fallback?.eligiblePlanKeys.join(', ') ?? 'no plans'}.\n`);
}

main().catch((error: unknown) => {
  if (error instanceof EnvironmentError) { process.stderr.write(`${error.message}\n`); process.exit(1); }
  throw error;
});
