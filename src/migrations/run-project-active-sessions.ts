import { EnvironmentError, loadSharedConfig } from '../config/index.ts';
import { initialiseFirebase } from '../firebase.ts';
import { MigrationUsageError, parseMigrationArguments } from './cli.ts';
import { migrateProjectActiveSessions } from './project-active-sessions.ts';

async function main(): Promise<void> {
  // Parsed before any configuration is loaded or Firebase is reached, so a run
  // that was never authorised does not even open a connection.
  const command = parseMigrationArguments(process.argv.slice(2));
  const dryRun = command.kind === 'dry-run';

  const config = loadSharedConfig();
  const { firestore } = initialiseFirebase(config);
  const result = await migrateProjectActiveSessions(firestore, { dryRun });

  process.stdout.write(
    `${dryRun ? 'Dry run against' : 'Migrated'} "${config.FIREBASE_PROJECT_ID}": ` +
      `scanned ${result.scanned}, unlocked ${result.unlocked}, adopted ${result.adopted}, ` +
      `already migrated ${result.alreadyMigrated}, failed ${result.failures.length}.\n`,
  );

  if (result.failures.length > 0) {
    for (const failure of result.failures) {
      process.stderr.write(`${failure.projectId} [${failure.stage}]: ${failure.reason}\n`);
    }
    // Every sound project was still migrated; these are the ones an operator has
    // to look at, and the run must not read as a success while they stand.
    process.stderr.write(
      `${result.failures.length} project(s) could not be migrated. Resolve them and rerun; ` +
        'projects already migrated are validated rather than rewritten.\n',
    );
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  // A usage or environment mistake is the operator's to fix and its message was
  // written for them; a stack trace would only bury it.
  if (error instanceof MigrationUsageError || error instanceof EnvironmentError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  }
  process.exit(1);
});
