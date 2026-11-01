import { parseArgs } from 'node:util';

import { EnvironmentError, loadConfig } from '../config/index.ts';
import { parsePlan, parseRegistry } from '../entitlements/schema.ts';
import { ConfigurationStore, plansCollectionPath, registryDocumentPath } from '../entitlements/store.ts';
import { initialiseFirebase } from '../firebase.ts';
import { withBooleanCapability } from './capability-row.ts';

/**
 * Switches on git persistence for a plan by editing one entitlement row of its
 * live plan document. Defaults to the Free plan. The fallback lane only switches
 * models from a durable checkpoint, which needs this capability, so without it
 * a plan's users see "checkpoint unavailable" instead of a model switch.
 *
 *   node --env-file=.env dist/seed/enable-persistence.js            show what would change
 *   node --env-file=.env dist/seed/enable-persistence.js --apply    make the change
 *   node --env-file=.env dist/seed/enable-persistence.js --plan pro --apply
 *
 * The default is a dry run. Applying replaces only the `entitlements` field,
 * inside a transaction that re-reads the registry, so the edited plan is proved
 * valid before anything is written. The API and runner pick the change up when
 * their cached configuration expires; no restart.
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
    const edited = withBooleanCapability(planSnapshot.data() ?? {}, 'git.persistence', true);
    parsePlan(edited.fields, planPath, registry);
    if (values.apply === true && edited.changes.length > 0) transaction.update(ref, { entitlements: edited.fields['entitlements'] });
    return edited.changes;
  });

  process.stdout.write(`Project "${config.FIREBASE_PROJECT_ID}", ${planPath}:\n`);
  if (outcome.length === 0) { process.stdout.write('  nothing to change: git.persistence is already on.\n'); return; }
  for (const change of outcome) process.stdout.write(`  ${change.capabilityKey}: ${JSON.stringify(change.from)} -> ${JSON.stringify(change.to)}\n`);
  if (values.apply !== true) { process.stdout.write('Dry run: nothing was written. Pass --apply to make this change.\n'); return; }

  const { plans } = await new ConfigurationStore(firestore, 1000).get();
  const value = plans.get(planKey)?.entitlements.get('git.persistence');
  process.stdout.write(`Applied. ${planKey} git.persistence is now ${JSON.stringify(value)}.\n`);
}

main().catch((error: unknown) => {
  if (error instanceof EnvironmentError) { process.stderr.write(`${error.message}\n`); process.exit(1); }
  throw error;
});
