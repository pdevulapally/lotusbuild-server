/**
 * Argument handling for the active-session migration command.
 *
 * Separate from the script so it can be exercised without running a migration,
 * and separate from the migration so the algorithm knows nothing about argv.
 */

export const dryRunFlag = '--dry-run';
export const maintenanceFlag = '--maintenance-confirmed';

/**
 * A write run is only representable once the operator has acknowledged the
 * maintenance window, because the only way to obtain one is to ask for it.
 */
export type MigrationCommand = { readonly kind: 'dry-run' } | { readonly kind: 'write' };

/** A mistake in how the command was invoked, reported without a stack trace. */
export class MigrationUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationUsageError';
  }
}

const usage =
  `Usage:\n` +
  `  npm run migrate:project-session-guard -- ${dryRunFlag}\n` +
  `  npm run migrate:project-session-guard -- ${maintenanceFlag}\n`;

/**
 * Turns the operator's arguments into what they are allowed to do.
 *
 * A bare invocation is refused rather than treated as a write. The migration
 * pages through projects and probes each one's active sessions two at a time,
 * which is only sound while nothing else is creating, claiming or finishing
 * sessions — so a write run has to be asked for in a way nobody types by
 * accident. The flag is an acknowledgement, not evidence: nothing here can see
 * whether the API and runner are actually stopped.
 *
 * An unrecognised argument is refused too. A mistyped `--dry-run` must not
 * quietly become something else.
 */
export function parseMigrationArguments(argv: readonly string[]): MigrationCommand {
  let dryRun = false;
  let maintenanceConfirmed = false;

  for (const argument of argv) {
    if (argument === dryRunFlag) {
      dryRun = true;
    } else if (argument === maintenanceFlag) {
      maintenanceConfirmed = true;
    } else {
      throw new MigrationUsageError(`Unrecognised argument "${argument}".\n${usage}`);
    }
  }

  if (dryRun && maintenanceConfirmed) {
    throw new MigrationUsageError(
      `${dryRunFlag} and ${maintenanceFlag} ask for different things: a dry run writes nothing ` +
        `and needs no acknowledgement. Pass one or the other.\n${usage}`,
    );
  }
  if (dryRun) {
    return { kind: 'dry-run' };
  }
  if (!maintenanceConfirmed) {
    throw new MigrationUsageError(
      'This migration writes to every legacy project and is only correct while nothing else is ' +
        'touching sessions. Stop the API and runner processes first, then confirm you have done ' +
        `so with ${maintenanceFlag}. To see what it would do without writing, pass ` +
        `${dryRunFlag}.\n${usage}`,
    );
  }
  return { kind: 'write' };
}
