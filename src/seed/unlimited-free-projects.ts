import { parseArgs } from 'node:util';

import { EnvironmentError, loadConfig } from '../config/index.ts';
import { parsePlan, parseRegistry } from '../entitlements/schema.ts';
import { ConfigurationStore, plansCollectionPath, registryDocumentPath } from '../entitlements/store.ts';
import { initialiseFirebase } from '../firebase.ts';
import { withUnlimitedProjects } from './project-cap-row.ts';

/**
 * Removes a plan's project-count cap by editing one entitlement row of its live
 * plan document. Defaults to the Free plan.
 *
 *   node --env-file=.env dist/seed/unlimited-free-projects.js            show what would change
 *   node --env-file=.env dist/seed/unlimited-free-projects.js --apply    make the change
 *   node --env-file=.env dist/seed/unlimited-free-projects.js --plan pro --apply
 *
 * The default is a dry run. Applying replaces only the `entitlements` field,
 * inside a transaction that re-reads the registry, so the edited plan is proved
 * valid against live configuration before anything is written and a concurrent
 * edit is never overwritten with a stale copy. The API picks the change up when
 * its cached configuration expires (CONFIG_CACHE_TTL_SECONDS); no restart.
 * Projects, counters and every other plan field are untouched.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { apply: { type: 'boolean', default: false }, plan: { type: 'string', default: 'free' } },
    strict: true,
  });
  const planKey = values.plan ?? 'free';
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(planKey)) throw new Error(`"${planKey}" is not a plan key.`);

  const config = loadConfig();
  const { firestore } = initialiseFirebase(config);
  const planPath = `${plansCollectionPath}/${planKey}`;
  const ref = firestore.doc(planPath);

  const outcome = await firestore.runTransaction(async (transaction) => {
    const [registrySnapshot, planSnapshot] = await Promise.all([transaction.get(firestore.doc(registryDocumentPath)), transaction.get(ref)]);
    if (!registrySnapshot.exists) throw new Error(`${registryDocumentPath} does not exist in "${config.FIREBASE_PROJECT_ID}"; seed it first.`);
    if (!planSnapshot.exists) throw new Error(`${planPath} does not exist in "${config.FIREBASE_PROJECT_ID}".`);
    const registry = parseRegistry(registrySnapshot.data() ?? {}, registryDocumentPath);
    const { fields, changes } = withUnlimitedProjects(planSnapshot.data() ?? {});
    // Proves the edited document is valid configuration before anything is written.
    parsePlan(fields, planPath, registry);
    if (values.apply === true && changes.length > 0) transaction.update(ref, { entitlements: fields['entitlements'] });
    return changes;
  });

  process.stdout.write(`Project "${config.FIREBASE_PROJECT_ID}", ${planPath}:\n`);
  if (outcome.length === 0) {
    process.stdout.write('  nothing to change: the project count is already unlimited.\n');
    return;
  }
  for (const change of outcome) process.stdout.write(`  ${change.capabilityKey}: ${JSON.stringify(change.from)} -> ${JSON.stringify(change.to)}\n`);
  if (values.apply !== true) {
    process.stdout.write('Dry run: nothing was written. Pass --apply to make this change.\n');
    return;
  }

  // Read back through the code the server uses, which also checks the plan against the registry.
  const { plans } = await new ConfigurationStore(firestore, 1000).get();
  const plan = plans.get(planKey);
  const row = plan?.entitlements.get('projects.max');
  process.stdout.write(
    `Applied. The ${plan?.name ?? planKey} plan's projects.max is now ${JSON.stringify(row?.value)}.\n` +
      `Running processes pick it up within ${config.CONFIG_CACHE_TTL_SECONDS} seconds.\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof EnvironmentError || error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
