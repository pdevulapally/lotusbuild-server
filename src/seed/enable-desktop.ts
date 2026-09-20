import { parseArgs } from 'node:util';

import { EnvironmentError, loadConfig } from '../config/index.ts';
import { parseRegistry } from '../entitlements/schema.ts';
import { ConfigurationStore, registryDocumentPath } from '../entitlements/store.ts';
import { initialiseFirebase } from '../firebase.ts';
import { type DesktopMode, type RowChange, withDesktop } from './desktop-row.ts';

/**
 * Turns the desktop on, or back off, for web builds by editing one sandbox
 * provider row of the live registry.
 *
 *   node --env-file=.env dist/seed/enable-desktop.js            show what would change
 *   node --env-file=.env dist/seed/enable-desktop.js --apply    make the change
 *   node --env-file=.env dist/seed/enable-desktop.js --disable  show the way back
 *   node --env-file=.env dist/seed/enable-desktop.js --disable --apply
 *
 * The default is a dry run. Applying replaces only the `sandboxProviders` field,
 * inside a transaction, so an edit made to the registry in the meantime is never
 * overwritten with a stale copy. The API and the runner pick the change up when
 * their cached configuration expires (CONFIG_CACHE_TTL_SECONDS); no restart.
 */
function describe(change: RowChange, showAll: boolean): string {
  const text = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value));
  if (change.field === 'agentInstructions' && !showAll) {
    return `  agentInstructions: ${text(change.from ?? '').length} -> ${text(change.to ?? '').length} characters (pass --show to print them)`;
  }
  return `  ${change.field}: ${change.from === undefined ? '(absent)' : text(change.from)} -> ${change.to === undefined ? '(absent)' : text(change.to)}`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      apply: { type: 'boolean', default: false },
      disable: { type: 'boolean', default: false },
      show: { type: 'boolean', default: false },
    },
    strict: true,
  });
  const mode: DesktopMode = values.disable === true ? 'disable' : 'enable';

  const config = loadConfig();
  const { firestore } = initialiseFirebase(config);
  const ref = firestore.doc(registryDocumentPath);

  const outcome = await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) throw new Error(`${registryDocumentPath} does not exist in "${config.FIREBASE_PROJECT_ID}"; seed it first.`);
    const { fields, changes } = withDesktop(snapshot.data() ?? {}, mode);
    // Proves the edited document is valid configuration before anything is written.
    parseRegistry(fields, registryDocumentPath);
    if (values.apply === true && changes.length > 0) transaction.update(ref, { sandboxProviders: fields['sandboxProviders'] });
    return changes;
  });

  process.stdout.write(`Project "${config.FIREBASE_PROJECT_ID}", ${registryDocumentPath}, web sandbox provider, ${mode}:\n`);
  if (outcome.length === 0) {
    process.stdout.write(`  nothing to change: it is already ${mode === 'enable' ? 'enabled' : 'disabled'}.\n`);
    return;
  }
  for (const change of outcome) process.stdout.write(`${describe(change, values.show === true)}\n`);
  if (values.apply !== true) {
    process.stdout.write('Dry run: nothing was written. Pass --apply to make this change.\n');
    return;
  }

  // Read back through the code the server uses, which also checks the plans against the registry.
  const { registry } = await new ConfigurationStore(firestore, 1000).get();
  const web = registry.sandboxProviders.get('web');
  process.stdout.write(
    `Applied. The web provider now uses template "${web?.template}" ${web?.desktop === undefined ? 'with no desktop' : `with a ${web.desktop.width}x${web.desktop.height} desktop`}.\n` +
      `Running processes pick it up within ${config.CONFIG_CACHE_TTL_SECONDS} seconds; new builds use it.\n`,
  );
}

main().catch((error: unknown) => {
  if (error instanceof EnvironmentError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exit(1);
});
