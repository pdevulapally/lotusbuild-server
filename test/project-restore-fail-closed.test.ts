import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SandboxProvider } from '../src/entitlements/schema.ts';
import type { UserEntitlements } from '../src/entitlements/service.ts';
import { AppError } from '../src/http/errors.ts';
import { ProjectPersistence, type SnapshotPublisher } from '../src/projects/persistence.ts';
import type { Project } from '../src/projects/repository.ts';
import type { CommandOutcome, RunningSandbox } from '../src/sandboxes/provider.ts';
import type { SessionLease } from '../src/sessions/repository.ts';
import {
  missingSnapshotError,
  type PersistedSnapshot,
  type SnapshotStorage,
  type SnapshotUpload,
  type StoredSnapshot,
  type UploadedSnapshot,
} from '../src/storage/snapshots.ts';

const provider: SandboxProvider = {
  platform: 'web',
  provider: 'e2b',
  template: 'test-template',
  timeoutSeconds: 60,
  memoryMb: 512,
  cpus: 1,
  concurrencyMeterKey: 'sandbox.concurrent.web',
  workdir: '/workspace',
  idleGraceSeconds: 5,
  agentInstructions: 'test',
  validationProfiles: new Map(),
};

const objectName = 'projects/project-1/snapshots/lease-a.tar.gz';

function projectWith(snapshot: StoredSnapshot, snapshotBytes: number): Project {
  return {
    id: 'project-1',
    ownerUid: 'user-1',
    name: 'Project',
    description: undefined,
    platform: 'web',
    status: 'draft', visibility: 'private',
    snapshotBytes,
    snapshot,
    activeSessionId: 'session-1',
    createdAt: new Date(0),
  };
}

/**
 * How Storage is asked for an object. An immutable snapshot carries its
 * generation, so a reference that differs only by generation is a different
 * object — which is what proves no test passes by falling back to the latest
 * version of a name.
 */
function reference(snapshot: PersistedSnapshot): string {
  return snapshot.kind === 'legacy' ? 'legacy' : `${snapshot.objectName}#${snapshot.generation}`;
}

class FakeSnapshotStorage implements SnapshotStorage {
  readonly reads: string[] = [];
  createCalls = 0;
  readonly #present: ReadonlySet<string>;

  constructor(present: readonly string[]) {
    this.#present = new Set(present);
  }

  async readUrl(projectId: string, snapshot: PersistedSnapshot): Promise<string> {
    const ref = reference(snapshot);
    this.reads.push(ref);
    if (!this.#present.has(ref)) {
      throw missingSnapshotError(projectId, snapshot);
    }
    return `https://storage.invalid/read/${encodeURIComponent(ref)}`;
  }

  async createUpload(_projectId: string, _leaseToken: string): Promise<SnapshotUpload> {
    this.createCalls += 1;
    return { objectName, url: 'https://storage.invalid/upload' };
  }

  async inspectUpload(name: string): Promise<UploadedSnapshot> {
    return { objectName: name, generation: '7', bytes: 321 };
  }

  async removeStored(_projectId: string, _snapshot: StoredSnapshot): Promise<void> {}
}

/** Restoring must never reach the publication side of persistence. */
class UnusedPublisher implements SnapshotPublisher {
  async assertPersistenceLease(_authority: SessionLease): Promise<void> {
    throw new Error('restore must not take a persistence lease');
  }

  async reserveSnapshotUpload(): Promise<void> {}

  async publishSnapshot(
    _authority: SessionLease,
    _entitlements: UserEntitlements,
    _snapshot: UploadedSnapshot,
  ): Promise<{ readonly projectId: string; readonly previous: StoredSnapshot }> {
    throw new Error('restore must not publish a snapshot');
  }
}

class RecordingSandbox implements RunningSandbox {
  readonly externalId = 'sandbox-1';
  readonly commands: string[] = [];
  readonly writes: { readonly path: string; readonly content: string }[] = [];

  async runCommand(command: string): Promise<CommandOutcome> {
    this.commands.push(command);
    return { exitCode: 0, stdout: '', stderr: '' };
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.writes.push({ path, content });
  }

  async readFile(_path: string): Promise<string> {
    return '';
  }

  previewUrl(_port: number): string {
    return 'https://preview.invalid';
  }

  async stop(): Promise<void> {}
}

function persistence(snapshots: SnapshotStorage): ProjectPersistence {
  return new ProjectPersistence(
    new UnusedPublisher(),
    snapshots,
    { name: 'LotusBuild', email: 'builder@example.invalid' },
    1000,
  );
}

function initialisedRepository(sandbox: RecordingSandbox): boolean {
  return sandbox.commands.some((command) => command.includes('git init'));
}

test('a project that has never been saved starts a repository without reading storage', async () => {
  const snapshots = new FakeSnapshotStorage([]);
  const sandbox = new RecordingSandbox();

  const outcome = await persistence(snapshots).restore(
    sandbox,
    provider,
    projectWith({ kind: 'none' }, 0),
  );

  assert.equal(outcome, 'initialised');
  assert.ok(initialisedRepository(sandbox));
  assert.deepEqual(snapshots.reads, []);
});

test('a legacy snapshot that exists is restored', async () => {
  const snapshots = new FakeSnapshotStorage(['legacy']);
  const sandbox = new RecordingSandbox();

  const outcome = await persistence(snapshots).restore(
    sandbox,
    provider,
    projectWith({ kind: 'legacy' }, 4096),
  );

  assert.equal(outcome, 'restored');
  assert.equal(initialisedRepository(sandbox), false);
  assert.deepEqual(snapshots.reads, ['legacy']);
  // The archive is fetched from the URL the read handed over, in a file.
  assert.equal(snapshots.reads.length, sandbox.writes.length);
  assert.match(sandbox.commands.join('\n'), /curl -sfL -o/);
});

test('a legacy snapshot the bucket cannot produce fails instead of starting a repository', async () => {
  const snapshots = new FakeSnapshotStorage([]);
  const sandbox = new RecordingSandbox();

  await assert.rejects(
    persistence(snapshots).restore(sandbox, provider, projectWith({ kind: 'legacy' }, 4096)),
    { code: 'project/snapshot-missing' },
  );
  assert.equal(initialisedRepository(sandbox), false);
  assert.deepEqual(sandbox.commands, []);
});

test('an immutable snapshot is restored at the exact recorded generation', async () => {
  const snapshots = new FakeSnapshotStorage([`${objectName}#7`]);
  const sandbox = new RecordingSandbox();

  const outcome = await persistence(snapshots).restore(
    sandbox,
    provider,
    projectWith({ kind: 'immutable', objectName, generation: '7' }, 4096),
  );

  assert.equal(outcome, 'restored');
  assert.equal(initialisedRepository(sandbox), false);
  assert.deepEqual(snapshots.reads, [`${objectName}#7`]);
});

test('a recorded generation that is gone fails rather than taking another generation', async () => {
  // The name is occupied by a different version. Neither it nor a fresh
  // repository is an acceptable substitute for the version the project records.
  const snapshots = new FakeSnapshotStorage([`${objectName}#7`, 'legacy']);
  const sandbox = new RecordingSandbox();

  await assert.rejects(
    persistence(snapshots).restore(
      sandbox,
      provider,
      projectWith({ kind: 'immutable', objectName, generation: '8' }, 4096),
    ),
    { code: 'project/snapshot-missing' },
  );
  assert.equal(initialisedRepository(sandbox), false);
  assert.deepEqual(sandbox.commands, []);
  assert.deepEqual(snapshots.reads, [`${objectName}#8`]);
});

test('a failed restore leaves nothing that could become a new snapshot', async () => {
  const snapshots = new FakeSnapshotStorage([]);
  const sandbox = new RecordingSandbox();

  await assert.rejects(
    persistence(snapshots).restore(
      sandbox,
      provider,
      projectWith({ kind: 'immutable', objectName, generation: '7' }, 4096),
    ),
    { code: 'project/snapshot-missing' },
  );
  // Nothing ran in the sandbox, so there is no workspace — empty or otherwise —
  // for the agent to work on, and no candidate object was ever minted.
  assert.deepEqual(sandbox.commands, []);
  assert.deepEqual(sandbox.writes, []);
  assert.equal(snapshots.createCalls, 0);
});

test('the failure tells the client nothing about where the snapshot lives', async () => {
  const snapshot: PersistedSnapshot = { kind: 'immutable', objectName, generation: '7' };
  const error = missingSnapshotError('project-1', snapshot);

  assert.ok(error instanceof AppError);
  assert.equal(error.statusCode, 500);
  assert.equal(error.message, 'The saved project could not be restored.');
  assert.deepEqual(error.details, {
    projectId: 'project-1',
    snapshot: 'immutable',
    generation: '7',
  });
  // The candidate object is named after the lease token that wrote it.
  assert.equal(JSON.stringify(error.details).includes(objectName), false);
});
