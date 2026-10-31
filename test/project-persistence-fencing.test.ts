import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ResolvedEntitlements, type UserEntitlements } from '../src/entitlements/service.ts';
import type { SandboxProvider } from '../src/entitlements/schema.ts';
import { AppError } from '../src/http/errors.ts';
import {
  ProjectPersistence,
  type SnapshotPublisher,
} from '../src/projects/persistence.ts';
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

const project: Project = {
  id: 'project-1',
  ownerUid: 'user-1',
  name: 'Project',
  description: undefined,
  platform: 'web',
  status: 'draft', visibility: 'private',
  snapshotBytes: 0,
  snapshot: { kind: 'none' },
  activeSessionId: 'session-1',
  createdAt: new Date(0),
};

function lease(runnerId: string, token: string): SessionLease {
  return { sessionId: 'session-1', runnerId, token };
}

function leaseLost(authority: SessionLease): AppError {
  return new AppError({
    code: 'session/lease-lost',
    statusCode: 409,
    message: `Lease ${authority.token} is stale.`,
  });
}

class FakePublisher implements SnapshotPublisher {
  current: SessionLease;
  published: UploadedSnapshot | undefined;
  accountedBytes = 0;
  readonly previous: StoredSnapshot;

  constructor(current: SessionLease, previous: StoredSnapshot = { kind: 'none' }) {
    this.current = current;
    this.previous = previous;
  }

  async assertPersistenceLease(authority: SessionLease): Promise<void> {
    if (
      authority.sessionId !== this.current.sessionId ||
      authority.runnerId !== this.current.runnerId ||
      authority.token !== this.current.token
    ) {
      throw leaseLost(authority);
    }
  }

  async reserveSnapshotUpload(): Promise<void> {}

  async publishSnapshot(
    authority: SessionLease,
    _entitlements: UserEntitlements,
    snapshot: UploadedSnapshot,
  ): Promise<{ readonly projectId: string; readonly previous: StoredSnapshot }> {
    await this.assertPersistenceLease(authority);
    this.published = snapshot;
    this.accountedBytes = snapshot.bytes;
    return { projectId: project.id, previous: this.previous };
  }
}

class FakeSnapshotStorage implements SnapshotStorage {
  readonly uploaded: UploadedSnapshot = {
    objectName: 'projects/project-1/snapshots/lease-a.tar.gz',
    generation: '123',
    bytes: 321,
  };
  createCalls = 0;
  inspectCalls = 0;
  removed: StoredSnapshot | undefined;

  // These tests exercise saving only. Nothing has been stored, so the honest
  // answer to a read is the one a missing object gets.
  async readUrl(projectId: string, snapshot: PersistedSnapshot): Promise<string> {
    throw missingSnapshotError(projectId, snapshot);
  }

  async createUpload(_projectId: string, _leaseToken: string, _bytes: number, beforeSign: (name: string, expires: Date) => Promise<void>): Promise<SnapshotUpload> {
    await beforeSign(this.uploaded.objectName, new Date(Date.now() + 60000));
    this.createCalls += 1;
    return { objectName: this.uploaded.objectName, url: 'https://storage.invalid/upload' };
  }

  async inspectUpload(objectName: string): Promise<UploadedSnapshot> {
    this.inspectCalls += 1;
    assert.equal(objectName, this.uploaded.objectName);
    return this.uploaded;
  }

  async removeStored(_projectId: string, snapshot: StoredSnapshot): Promise<void> {
    this.removed = snapshot;
  }
}

class FakeSandbox implements RunningSandbox {
  readonly externalId = 'sandbox-1';
  commands = 0;
  readonly #onUpload: () => void;

  constructor(onUpload: () => void = (): void => {}) {
    this.#onUpload = onUpload;
  }

  async runCommand(command: string): Promise<CommandOutcome> {
    this.commands += 1;
    if (command.includes('curl -sf -X PUT')) {
      assert.match(command, /x-goog-if-generation-match: 0/);
      this.#onUpload();
    }
    return { exitCode: 0, stdout: command.includes('stat -c') ? '321\n' : 'committed=yes\n', stderr: '' };
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

function persistence(publisher: FakePublisher, snapshots: FakeSnapshotStorage): ProjectPersistence {
  return new ProjectPersistence(
    publisher,
    snapshots,
    { name: 'LotusBuild', email: 'builder@example.invalid' },
    1000,
  );
}

async function save(
  service: ProjectPersistence,
  sandbox: RunningSandbox,
  authority: SessionLease,
): Promise<void> {
  await service.save({
    sandbox,
    provider,
    project,
    entitlements,
    authority,
    commitMessage: 'test',
  });
}

test('current lease owner publishes immutable snapshot and accounting', async () => {
  const authority = lease('runner-a', 'lease-a');
  const publisher = new FakePublisher(authority);
  const snapshots = new FakeSnapshotStorage();
  const sandbox = new FakeSandbox();

  await save(persistence(publisher, snapshots), sandbox, authority);

  assert.deepEqual(publisher.published, snapshots.uploaded);
  assert.equal(publisher.accountedBytes, snapshots.uploaded.bytes);
  assert.equal(snapshots.createCalls, 1);
  assert.equal(snapshots.inspectCalls, 1);
  assert.equal(snapshots.removed, undefined);
});

test('runner replaced before persistence cannot begin a save', async () => {
  const stale = lease('runner-a', 'lease-a');
  const publisher = new FakePublisher(lease('runner-b', 'lease-b'));
  const snapshots = new FakeSnapshotStorage();
  const sandbox = new FakeSandbox();

  await assert.rejects(save(persistence(publisher, snapshots), sandbox, stale), {
    code: 'session/lease-lost',
  });
  assert.equal(sandbox.commands, 0);
  assert.equal(snapshots.createCalls, 0);
  assert.equal(publisher.published, undefined);
  assert.equal(publisher.accountedBytes, 0);
});

test('lease takeover during upload cannot publish or change accounting', async () => {
  const stale = lease('runner-a', 'lease-a');
  const publisher = new FakePublisher(stale);
  const snapshots = new FakeSnapshotStorage();
  const sandbox = new FakeSandbox(() => {
    publisher.current = lease('runner-b', 'lease-b');
  });

  await assert.rejects(save(persistence(publisher, snapshots), sandbox, stale), {
    code: 'session/lease-lost',
  });
  assert.equal(snapshots.createCalls, 1);
  assert.equal(snapshots.inspectCalls, 1);
  assert.equal(publisher.published, undefined);
  assert.equal(publisher.accountedBytes, 0);
  assert.equal(snapshots.removed, undefined);
});

test('different lease epochs for the same runner identity are distinguished', async () => {
  const stale = lease('runner-a', 'lease-a');
  const publisher = new FakePublisher(lease('runner-a', 'lease-b'));
  const snapshots = new FakeSnapshotStorage();

  await assert.rejects(save(persistence(publisher, snapshots), new FakeSandbox(), stale), {
    code: 'session/lease-lost',
  });
  assert.equal(publisher.published, undefined);
  assert.equal(publisher.accountedBytes, 0);
});

test('ordinary failure cleanup can persist partial work while its lease remains current', async () => {
  const authority = lease('runner-a', 'lease-a');
  const publisher = new FakePublisher(authority);
  const snapshots = new FakeSnapshotStorage();
  const sandbox = new FakeSandbox();

  // SessionRunner uses the same save operation while handling an ordinary
  // model/tool failure. The durable lease checks, rather than the failure
  // category itself, decide whether that partial workspace may be published.
  await save(persistence(publisher, snapshots), sandbox, authority);

  assert.deepEqual(publisher.published, snapshots.uploaded);
  assert.equal(publisher.accountedBytes, snapshots.uploaded.bytes);
  assert.equal(snapshots.createCalls, 1);
});
