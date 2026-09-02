import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SandboxProvider } from '../src/entitlements/schema.ts';
import { ResolvedEntitlements, type UserEntitlements } from '../src/entitlements/service.ts';
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

const entitlements: UserEntitlements = {
  planKey: 'test',
  planName: 'Test',
  subscriptionStatus: undefined,
  capabilities: new ResolvedEntitlements(new Map()),
  meterLimits: new Map(),
  rateLimits: new Map(),
};

/** What the project pointed at before this save, and what it points at after. */
const superseded: StoredSnapshot = {
  kind: 'immutable',
  objectName: 'projects/project-1/snapshots/lease-old.tar.gz',
  generation: '7',
};

const supersededBytes = 100;

const uploaded: UploadedSnapshot = {
  objectName: 'projects/project-1/snapshots/lease-a.tar.gz',
  generation: '8',
  bytes: 321,
};

const authority: SessionLease = {
  sessionId: 'session-1',
  runnerId: 'runner-a',
  token: 'lease-a',
};

const project: Project = {
  id: 'project-1',
  ownerUid: 'user-1',
  name: 'Project',
  description: undefined,
  platform: 'web',
  status: 'draft',
  snapshotBytes: supersededBytes,
  snapshot: superseded,
  activeSessionId: 'session-1',
  createdAt: new Date(0),
};

/** A cleanup error that is not a 404, so the store would genuinely raise it. */
class BucketUnavailable extends Error {
  readonly code = 503;
}

class FakePublisher implements SnapshotPublisher {
  publishCalls = 0;
  /** What the project document points at. Starts at the superseded snapshot. */
  authoritative: StoredSnapshot = superseded;
  accountedBytes = supersededBytes;
  readonly #publishFails: boolean;

  constructor(publishFails = false) {
    this.#publishFails = publishFails;
  }

  async assertPersistenceLease(_authority: SessionLease): Promise<void> {}

  async publishSnapshot(
    _authority: SessionLease,
    _entitlements: UserEntitlements,
    snapshot: UploadedSnapshot,
  ): Promise<{ readonly projectId: string; readonly previous: StoredSnapshot }> {
    this.publishCalls += 1;
    if (this.#publishFails) {
      throw new AppError({
        code: 'session/lease-lost',
        statusCode: 409,
        message: 'This runner no longer owns the persistence lease for the session.',
      });
    }
    const previous = this.authoritative;
    this.authoritative = {
      kind: 'immutable',
      objectName: snapshot.objectName,
      generation: snapshot.generation,
    };
    this.accountedBytes = snapshot.bytes;
    return { projectId: project.id, previous };
  }
}

type Removal = 'deleted' | 'already-absent' | 'unavailable';

class FakeSnapshotStorage implements SnapshotStorage {
  readonly removals: StoredSnapshot[] = [];
  readonly #removal: Removal;

  constructor(removal: Removal = 'deleted') {
    this.#removal = removal;
  }

  async readUrl(projectId: string, snapshot: PersistedSnapshot): Promise<string> {
    throw missingSnapshotError(projectId, snapshot);
  }

  async createUpload(_projectId: string, _leaseToken: string): Promise<SnapshotUpload> {
    return { objectName: uploaded.objectName, url: 'https://storage.invalid/upload' };
  }

  async inspectUpload(_objectName: string): Promise<UploadedSnapshot> {
    return uploaded;
  }

  async removeStored(_projectId: string, snapshot: StoredSnapshot): Promise<void> {
    this.removals.push(snapshot);
    if (this.#removal === 'unavailable') {
      throw new BucketUnavailable('the bucket could not be reached');
    }
    // 'already-absent' resolves: SnapshotStore.removeStored passes
    // `ignoreNotFound: true`, and the SDK suppresses only a 404 — a generation
    // mismatch or any other failure still raises, as 'unavailable' does.
  }
}

class FakeSandbox implements RunningSandbox {
  readonly externalId = 'sandbox-1';

  async runCommand(_command: string): Promise<CommandOutcome> {
    return { exitCode: 0, stdout: 'committed=yes\n', stderr: '' };
  }

  async writeFile(_path: string, _content: string): Promise<void> {}
  async readFile(_path: string): Promise<string> {
    return '';
  }
  previewUrl(_port: number): string {
    return 'https://preview.invalid';
  }
  async stop(): Promise<void> {}
}

function save(publisher: FakePublisher, snapshots: FakeSnapshotStorage) {
  return new ProjectPersistence(
    publisher,
    snapshots,
    { name: 'LotusBuild', email: 'builder@example.invalid' },
    1000,
  ).save({
    sandbox: new FakeSandbox(),
    provider,
    project,
    entitlements,
    authority,
    commitMessage: 'test',
  });
}

test('a publication that fails leaves the previous snapshot authoritative', async () => {
  const publisher = new FakePublisher(true);
  const snapshots = new FakeSnapshotStorage();

  await assert.rejects(save(publisher, snapshots), { code: 'session/lease-lost' });

  assert.deepEqual(publisher.authoritative, superseded);
  assert.equal(publisher.accountedBytes, supersededBytes);
  // Nothing was superseded, so nothing may be collected.
  assert.deepEqual(snapshots.removals, []);
});

test('a publication and cleanup that both succeed report an ordinary save', async () => {
  const publisher = new FakePublisher();
  const snapshots = new FakeSnapshotStorage();

  const outcome = await save(publisher, snapshots);

  assert.equal(outcome.bytes, uploaded.bytes);
  assert.equal(outcome.committed, true);
  assert.equal(outcome.cleanupFailure, undefined);
  assert.deepEqual(snapshots.removals, [superseded]);
});

test('a cleanup failure after publication still reports a committed save', async () => {
  const publisher = new FakePublisher();
  const snapshots = new FakeSnapshotStorage('unavailable');

  const outcome = await save(publisher, snapshots);

  assert.equal(outcome.bytes, uploaded.bytes);
  assert.equal(outcome.committed, true);
  // Observable: the caller is handed the object it must collect and the reason.
  assert.notEqual(outcome.cleanupFailure, undefined);
  assert.deepEqual(outcome.cleanupFailure?.superseded, superseded);
  assert.ok(outcome.cleanupFailure?.cause instanceof BucketUnavailable);
});

test('a cleanup failure rolls nothing back', async () => {
  const publisher = new FakePublisher();
  const snapshots = new FakeSnapshotStorage('unavailable');

  await save(publisher, snapshots);

  assert.deepEqual(publisher.authoritative, {
    kind: 'immutable',
    objectName: uploaded.objectName,
    generation: uploaded.generation,
  });
  assert.equal(publisher.accountedBytes, uploaded.bytes);
  // No second publication, so no attempt to restore the old pointer or gauge.
  assert.equal(publisher.publishCalls, 1);
});

test('cleanup targets the superseded generation and never the new one', async () => {
  const publisher = new FakePublisher();
  const snapshots = new FakeSnapshotStorage();

  await save(publisher, snapshots);

  assert.equal(snapshots.removals.length, 1);
  assert.deepEqual(snapshots.removals[0], superseded);
  assert.notDeepEqual(snapshots.removals[0], publisher.authoritative);
});

test('an obsolete snapshot that is already gone is not a cleanup failure', async () => {
  const publisher = new FakePublisher();
  const snapshots = new FakeSnapshotStorage('already-absent');

  const outcome = await save(publisher, snapshots);

  assert.equal(outcome.cleanupFailure, undefined);
  assert.deepEqual(snapshots.removals, [superseded]);
});

test('a cleanup failure cannot displace the failure a partial save was preserving', async () => {
  const publisher = new FakePublisher();
  const snapshots = new FakeSnapshotStorage('unavailable');

  // The runner reaches this same call while already handling an agent failure,
  // and only replaces that failure's reason if the save itself throws. It does
  // not, so the original reason survives and the build fails for what broke it.
  await assert.doesNotReject(save(publisher, snapshots));
});
