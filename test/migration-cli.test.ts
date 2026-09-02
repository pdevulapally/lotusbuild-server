import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MigrationUsageError,
  dryRunFlag,
  maintenanceFlag,
  parseMigrationArguments,
} from '../src/migrations/cli.ts';

test('a dry run needs no maintenance acknowledgement', () => {
  assert.deepEqual(parseMigrationArguments([dryRunFlag]), { kind: 'dry-run' });
});

test('a bare invocation is refused rather than treated as a write', () => {
  assert.throws(
    () => parseMigrationArguments([]),
    (error: unknown) =>
      error instanceof MigrationUsageError &&
      // The refusal has to tell the operator both things they need: stop the
      // processes, and how to say that they have.
      /Stop the API and runner processes/.test(error.message) &&
      error.message.includes(maintenanceFlag) &&
      error.message.includes(dryRunFlag),
  );
});

test('an acknowledged run is permitted', () => {
  assert.deepEqual(parseMigrationArguments([maintenanceFlag]), { kind: 'write' });
});

test('an unrecognised argument is refused rather than ignored', () => {
  // A mistyped --dry-run must not fall through to anything else.
  assert.throws(
    () => parseMigrationArguments(['--dry-runn']),
    (error: unknown) =>
      error instanceof MigrationUsageError && error.message.includes('--dry-runn'),
  );
});

test('asking for a dry run and a write at once is refused', () => {
  assert.throws(
    () => parseMigrationArguments([dryRunFlag, maintenanceFlag]),
    (error: unknown) =>
      error instanceof MigrationUsageError && /different things/.test(error.message),
  );
});

test('a repeated flag is the same request, not a conflicting one', () => {
  assert.deepEqual(parseMigrationArguments([maintenanceFlag, maintenanceFlag]), { kind: 'write' });
});
