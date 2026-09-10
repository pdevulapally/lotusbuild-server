import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import type { Auth } from 'firebase-admin/auth';
import { registerAuth } from '../src/auth/plugin.ts';
import { registerErrorHandler } from '../src/http/errors.ts';
import { registerProjectRoutes } from '../src/projects/routes.ts';
import { registerSessionRoutes } from '../src/sessions/routes.ts';
import type { SessionEvents } from '../src/sessions/events.ts';

import {
  type DocumentReference,
  type FieldPath,
  Timestamp,
  type Firestore,
  type Transaction,
} from 'firebase-admin/firestore';

import { ResolvedEntitlements, type EntitlementService } from '../src/entitlements/service.ts';
import type { ConfigurationStore } from '../src/entitlements/store.ts';
import { AppError } from '../src/http/errors.ts';
import type { MeteringService } from '../src/metering/service.ts';
import { ProjectRepository } from '../src/projects/repository.ts';
import { SessionRepository } from '../src/sessions/repository.ts';
import type { UserRepository } from '../src/users/repository.ts';

type Data = Record<string, unknown>;

interface StoredDocument {
  data: Data;
  version: number;
}

class TransactionConflict extends Error {}

function copy(data: Data): Data {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]),
  );
}

function comparable(value: unknown): unknown {
  return value instanceof Timestamp ? value.toMillis() : value;
}

function materialise(existing: Data, changes: Data, merge: boolean): Data {
  const result = merge ? copy(existing) : {};
  for (const [key, value] of Object.entries(changes)) {
    const kind = value?.constructor?.name;
    if (kind === 'DeleteTransform') {
      delete result[key];
    } else if (kind === 'ServerTimestampTransform') {
      result[key] = Timestamp.now();
    } else if (kind === 'NumericIncrementTransform') {
      const operand = (value as { operand: number }).operand;
      result[key] = (typeof result[key] === 'number' ? result[key] : 0) + operand;
    } else if (value !== undefined) {
      result[key] = Array.isArray(value) ? [...value] : value;
    }
  }
  return result;
}

class FakeSnapshot {
  readonly ref: FakeDocumentReference;
  readonly id: string;
  readonly exists: boolean;
  readonly #data: Data | undefined;

  constructor(ref: FakeDocumentReference, data: Data | undefined) {
    this.ref = ref;
    this.id = ref.id;
    this.exists = data !== undefined;
    this.#data = data === undefined ? undefined : copy(data);
  }

  data(): Data | undefined {
    return this.#data === undefined ? undefined : copy(this.#data);
  }
}

interface Filter {
  readonly field: string;
  readonly operator: '==' | '<=' | 'in';
  readonly value: unknown;
}

/** `undefined` field means ordering by document id, as FieldPath.documentId(). */
interface Order {
  readonly field: string | undefined;
  readonly direction: 'asc' | 'desc';
}

class FakeQuery {
  readonly firestore: FakeFirestore;
  readonly collectionPath: string;
  readonly filters: readonly Filter[];
  readonly order: Order | undefined;
  readonly maximum: number | undefined;
  readonly after: string | undefined;

  constructor(
    firestore: FakeFirestore,
    collectionPath: string,
    filters: readonly Filter[] = [],
    order?: Order,
    maximum?: number,
    after?: string,
  ) {
    this.firestore = firestore;
    this.collectionPath = collectionPath;
    this.filters = filters;
    this.order = order;
    this.maximum = maximum;
    this.after = after;
  }

  where(field: string, operator: '==' | '<=' | 'in', value: unknown): FakeQuery {
    return new FakeQuery(
      this.firestore,
      this.collectionPath,
      [...this.filters, { field, operator, value }],
      this.order,
      this.maximum,
      this.after,
    );
  }

  orderBy(field: string | FieldPath, direction: 'asc' | 'desc' = 'asc'): FakeQuery {
    return new FakeQuery(
      this.firestore,
      this.collectionPath,
      this.filters,
      { field: typeof field === 'string' ? field : undefined, direction },
      this.maximum,
      this.after,
    );
  }

  limit(maximum: number): FakeQuery {
    return new FakeQuery(
      this.firestore,
      this.collectionPath,
      this.filters,
      this.order,
      maximum,
      this.after,
    );
  }

  startAfter(cursor: string): FakeQuery {
    if (this.order?.field !== undefined) {
      throw new Error('The fake only supports cursors on document-id ordering.');
    }
    return new FakeQuery(
      this.firestore,
      this.collectionPath,
      this.filters,
      this.order,
      this.maximum,
      cursor,
    );
  }

  async get(): Promise<{ docs: readonly FakeSnapshot[]; size: number }> {
    return this.firestore.query(this);
  }
}

class FakeCollectionReference extends FakeQuery {
  doc(id?: string): FakeDocumentReference {
    return new FakeDocumentReference(
      this.firestore,
      `${this.collectionPath}/${id ?? this.firestore.nextId()}`,
    );
  }
}

class FakeDocumentReference {
  readonly firestore: FakeFirestore;
  readonly path: string;
  readonly id: string;

  constructor(firestore: FakeFirestore, path: string) {
    this.firestore = firestore;
    this.path = path;
    this.id = path.split('/').at(-1) ?? '';
  }

  collection(name: string): FakeCollectionReference {
    return new FakeCollectionReference(this.firestore, `${this.path}/${name}`);
  }

  async get(): Promise<FakeSnapshot> {
    return this.firestore.snapshot(this);
  }

  async update(data: Data): Promise<void> {
    const old = this.firestore.documents.get(this.path);
    if (old === undefined) throw new Error('Missing document.');
    this.firestore.seed(this.path, materialise(old.data, data, true));
  }
}

type Write =
  | { readonly kind: 'create'; readonly ref: FakeDocumentReference; readonly data: Data }
  | { readonly kind: 'set'; readonly ref: FakeDocumentReference; readonly data: Data }
  | { readonly kind: 'update'; readonly ref: FakeDocumentReference; readonly data: Data }
  | { readonly kind: 'delete'; readonly ref: FakeDocumentReference };

class FakeTransaction {
  readonly #firestore: FakeFirestore;
  readonly reads = new Map<string, number>();
  readonly writes: Write[] = [];

  constructor(firestore: FakeFirestore) {
    this.#firestore = firestore;
  }

  async get(
    target: FakeDocumentReference | FakeQuery,
  ): Promise<FakeSnapshot | { docs: readonly FakeSnapshot[]; size: number }> {
    if (this.writes.length > 0) throw new Error('Firestore read after write.');
    if (target instanceof FakeQuery) {
      const result = this.#firestore.query(target);
      for (const document of result.docs) {
        this.reads.set(document.ref.path, this.#firestore.version(document.ref.path));
      }
      return result;
    }
    this.reads.set(target.path, this.#firestore.version(target.path));
    return this.#firestore.snapshot(target);
  }

  create(ref: FakeDocumentReference, data: Data): this {
    this.writes.push({ kind: 'create', ref, data });
    return this;
  }

  set(ref: FakeDocumentReference, data: Data): this {
    this.writes.push({ kind: 'set', ref, data });
    return this;
  }

  update(ref: FakeDocumentReference, data: Data): this {
    this.writes.push({ kind: 'update', ref, data });
    return this;
  }

  delete(ref: FakeDocumentReference): this {
    this.writes.push({ kind: 'delete', ref });
    return this;
  }
}

class FakeFirestore {
  readonly documents = new Map<string, StoredDocument>();
  #id = 0;
  #commitTail: Promise<void> = Promise.resolve();

  nextId(): string {
    this.#id += 1;
    return `generated-${this.#id}`;
  }

  doc(path: string): FakeDocumentReference {
    return new FakeDocumentReference(this, path);
  }

  collection(path: string): FakeCollectionReference {
    return new FakeCollectionReference(this, path);
  }

  seed(path: string, data: Data): void {
    this.documents.set(path, { data: copy(data), version: this.version(path) + 1 });
  }

  version(path: string): number {
    return this.documents.get(path)?.version ?? 0;
  }

  snapshot(ref: FakeDocumentReference): FakeSnapshot {
    return new FakeSnapshot(ref, this.documents.get(ref.path)?.data);
  }

  query(query: FakeQuery): { docs: readonly FakeSnapshot[]; size: number } {
    const depth = query.collectionPath.split('/').length + 1;
    let docs = [...this.documents]
      .filter(([path]) => path.startsWith(`${query.collectionPath}/`) && path.split('/').length === depth)
      .map(([path, stored]) => new FakeSnapshot(this.doc(path), stored.data))
      .filter((snapshot) => {
        const data = snapshot.data() ?? {};
        return query.filters.every((filter) => {
          const actual = comparable(data[filter.field]);
          const expected = comparable(filter.value);
          if (filter.operator === '==') {
            return actual === expected;
          }
          if (filter.operator === '<=') {
            return (actual as number) <= (expected as number);
          }
          return Array.isArray(filter.value) && filter.value.includes(actual);
        });
      });

    if (query.order !== undefined) {
      const { field, direction } = query.order;
      docs = docs.sort((left, right) => {
        if (field === undefined) {
          const order = left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
          return direction === 'asc' ? order : -order;
        }
        const a = comparable((left.data() ?? {})[field]) as number;
        const b = comparable((right.data() ?? {})[field]) as number;
        return direction === 'asc' ? a - b : b - a;
      });
    }
    if (query.after !== undefined) {
      const cursor = query.after;
      docs = docs.filter((snapshot) => snapshot.id > cursor);
    }
    if (query.maximum !== undefined) {
      docs = docs.slice(0, query.maximum);
    }
    return { docs, size: docs.length };
  }

  async runTransaction<T>(operation: (transaction: Transaction) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const transaction = new FakeTransaction(this);
      const result = await operation(transaction as unknown as Transaction);
      try {
        await this.#commit(transaction);
        return result;
      } catch (error) {
        if (!(error instanceof TransactionConflict)) {
          throw error;
        }
      }
    }
    throw new Error('Fake transaction retry limit exceeded.');
  }

  async #commit(transaction: FakeTransaction): Promise<void> {
    const previous = this.#commitTail;
    let release = (): void => {};
    this.#commitTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      for (const [path, version] of transaction.reads) {
        if (this.version(path) !== version) {
          throw new TransactionConflict();
        }
      }
      for (const write of transaction.writes) {
        if (write.kind === 'delete') {
          this.documents.delete(write.ref.path);
          continue;
        }
        const stored = this.documents.get(write.ref.path);
        if (write.kind === 'create' && stored !== undefined) {
          throw new Error(`${write.ref.path} already exists.`);
        }
        if (write.kind === 'update' && stored === undefined) {
          throw new Error(`${write.ref.path} does not exist.`);
        }
        this.documents.set(write.ref.path, {
          data: materialise(stored?.data ?? {}, write.data, write.kind === 'update'),
          version: (stored?.version ?? 0) + 1,
        });
      }
    } finally {
      release();
    }
  }
}

const capabilities = new ResolvedEntitlements(
  new Map([
    ['ai.run', { kind: 'boolean' as const, value: true }],
    ['platform.web', { kind: 'boolean' as const, value: true }],
    ['ai.model.allowlist', { kind: 'stringList' as const, value: ['model-1'] }],
    ['ai.effort', { kind: 'string' as const, value: 'standard' }],
  ]),
);

function harness(projectIds: readonly string[] = ['project-1']) {
  const firestore = new FakeFirestore();
  const now = Timestamp.now();
  for (const projectId of projectIds) {
    firestore.seed(`projects/${projectId}`, {
      ownerUid: 'user-1',
      name: projectId,
      platform: 'web',
      status: 'draft',
      activeSessionId: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  const entitlementValue = {
    planKey: 'test',
    planName: 'Test',
    subscriptionStatus: undefined,
    capabilities,
    meterLimits: new Map([['builds.started', { hardLimit: 100, includedAllowance: 100, overageEnabled: false }]]),
    rateLimits: new Map(),
  };
  const entitlements = {
    forUser: async () => entitlementValue,
  } as unknown as EntitlementService;
  const configuration = {
    get: async () => ({ registry: { buildMeterKey: 'builds.started' } }),
  } as unknown as ConfigurationStore;
  const meterRef = firestore.doc('test-meter/user-1');
  // Reservation ledger the fake release reads, so a test can put a hold into any
  // of the states the real service distinguishes.
  const reservations = new Map<string, 'OPEN' | 'SETTLED' | 'RELEASED' | 'BROKEN'>();
  const metering = {
    consumeIn: async (transaction: Transaction) => {
      const snapshot = await transaction.get(meterRef as unknown as DocumentReference);
      const consumed = (snapshot.data()?.['consumed'] as number | undefined) ?? 0;
      transaction.set(meterRef as unknown as DocumentReference, { consumed: consumed + 1 });
      return { meterKey: 'builds.started', consumed: consumed + 1, periodStart: new Date() };
    },
    refundIn: async (transaction: Transaction) => {
      const snapshot = await transaction.get(meterRef as unknown as DocumentReference);
      const consumed = (snapshot.data()?.['consumed'] as number | undefined) ?? 0;
      transaction.set(meterRef as unknown as DocumentReference, { consumed: consumed - 1 });
      return { meterKey: 'builds.started', consumed: consumed - 1, periodStart: new Date() };
    },
    // Mirrors the real contract: only OPEN holds are released, closed ones are
    // skipped without an accounting write, and a contradictory ledger throws.
    releaseIn: async (
      _transaction: Transaction,
      _uid: string,
      reservationIds: readonly string[],
    ): Promise<readonly string[]> => {
      const released: string[] = [];
      for (const reservationId of reservationIds) {
        const state = reservations.get(reservationId);
        if (state === undefined) {
          throw new Error(`No reservation ${reservationId} for user-1.`);
        }
        if (state === 'BROKEN') {
          throw new Error(`Usage for user-1 disagrees with reservation ${reservationId}.`);
        }
        if (state !== 'OPEN') {
          continue;
        }
        reservations.set(reservationId, 'RELEASED');
        released.push(reservationId);
      }
      return released;
    },
  } as unknown as MeteringService;
  const projects = new ProjectRepository(
    firestore as unknown as Firestore,
    {} as UserRepository,
    entitlements,
  );
  const sessions = new SessionRepository(
    firestore as unknown as Firestore,
    projects,
    entitlements,
    configuration,
    metering,
    60,
  );

  return {
    firestore,
    projects,
    sessions,
    reservations,
    project: (id = 'project-1') => firestore.documents.get(`projects/${id}`)?.data,
    session: (id: string) => firestore.documents.get(`sessions/${id}`)?.data,
    activeSessions: () =>
      [...firestore.documents]
        .filter(([path, stored]) =>
          path.startsWith('sessions/') &&
          path.split('/').length === 2 &&
          (stored.data['status'] === 'QUEUED' || stored.data['status'] === 'RUNNING'),
        )
        .map(([path]) => path.split('/')[1]),
    charges: () => (firestore.documents.get('test-meter/user-1')?.data['consumed'] as number | undefined) ?? 0,
    seedSession: (
      id: string,
      projectId: string,
      status: 'QUEUED' | 'RUNNING' | 'IDLE' | 'FAILED',
      specialistReservationIds: readonly string[] = [],
    ) => {
      firestore.seed(`sessions/${id}`, {
        projectId,
        ownerUid: 'user-1',
        status,
        model: 'model-1',
        effort: 'standard',
        reservationIds: [],
        specialistReservationIds: [...specialistReservationIds],
        messageCount: 1,
        ...(status === 'QUEUED' ? { claimableAt: Timestamp.fromMillis(0) } : {}),
        ...(status === 'RUNNING'
          ? { claimedBy: 'runner-1', leaseToken: 'seed-token', heartbeatAt: now, claimableAt: Timestamp.fromMillis(Date.now() + 60000) }
          : {}),
        createdAt: now,
        updatedAt: now,
      });
    },
  };
}

function isConflict(result: PromiseSettledResult<unknown>): boolean {
  return (
    result.status === 'rejected' &&
    result.reason instanceof AppError &&
    result.reason.code === 'project/session-active'
  );
}

test('concurrent creation activates and charges exactly one session', async () => {
  const h = harness();
  const results = await Promise.allSettled([
    h.sessions.create('user-1', 'project-1', { prompt: 'first', model: 'model-1' }),
    h.sessions.create('user-1', 'project-1', { prompt: 'second', model: 'model-1' }),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(isConflict).length, 1);
  assert.equal(h.activeSessions().length, 1);
  assert.equal(h.project()?.['activeSessionId'], h.activeSessions()[0]);
  assert.equal(h.charges(), 1);
});

test('concurrent resume activates exactly one inactive session', async () => {
  const h = harness();
  h.seedSession('session-a', 'project-1', 'IDLE');
  h.seedSession('session-b', 'project-1', 'FAILED');

  const results = await Promise.allSettled([
    h.sessions.appendPrompt('user-1', 'session-a', 'resume a'),
    h.sessions.appendPrompt('user-1', 'session-b', 'resume b'),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(isConflict).length, 1);
  assert.equal(h.activeSessions().length, 1);
  assert.equal(h.project()?.['activeSessionId'], h.activeSessions()[0]);
  assert.equal(h.charges(), 1);
});

test('normal lifecycle retains the guard while running and releases it on idle', async () => {
  const h = harness();
  const created = await h.sessions.create('user-1', 'project-1', { prompt: 'build', model: 'model-1' });
  const claimed = await h.sessions.claim('runner-1', new Date());

  assert.equal(claimed?.id, created.id);
  assert.equal(h.project()?.['activeSessionId'], created.id);
  await h.sessions.finish(created.id, { sessionId: created.id, runnerId: 'runner-1', token: String(h.session(created.id)?.['leaseToken']) }, { status: 'IDLE' });
  assert.equal(h.session(created.id)?.['status'], 'IDLE');
  assert.equal(h.project()?.['activeSessionId'], null);
});

test('failed completion releases the project guard', async () => {
  const h = harness();
  const created = await h.sessions.create('user-1', 'project-1', { prompt: 'build', model: 'model-1' });
  await h.sessions.claim('runner-1', new Date());
  await h.sessions.finish(created.id, { sessionId: created.id, runnerId: 'runner-1', token: String(h.session(created.id)?.['leaseToken']) }, { status: 'FAILED', error: 'stopped' });

  assert.equal(h.session(created.id)?.['status'], 'FAILED');
  assert.equal(h.project()?.['activeSessionId'], null);
});

test('queued cancellation releases the project guard and refunds the build', async () => {
  const h = harness();
  const created = await h.sessions.create('user-1', 'project-1', { prompt: 'build', model: 'model-1' });
  await h.sessions.cancel('user-1', created.id);

  assert.equal(h.session(created.id)?.['status'], 'FAILED');
  assert.equal(h.project()?.['activeSessionId'], null);
  assert.equal(h.charges(), 0);
});

test('running cancellation retains the guard until failed finalization', async () => {
  const h = harness();
  const created = await h.sessions.create('user-1', 'project-1', { prompt: 'build', model: 'model-1' });
  await h.sessions.claim('runner-1', new Date());
  await h.sessions.cancel('user-1', created.id);

  assert.equal(h.session(created.id)?.['status'], 'RUNNING');
  assert.equal(h.project()?.['activeSessionId'], created.id);
  await h.sessions.finish(created.id, { sessionId: created.id, runnerId: 'runner-1', token: String(h.session(created.id)?.['leaseToken']) }, { status: 'FAILED', error: 'Cancelled by user' });
  assert.equal(h.session(created.id)?.['status'], 'FAILED');
  assert.equal(h.project()?.['activeSessionId'], null);
});

test('a stale running session cannot clear another session guard', async () => {
  const h = harness();
  h.seedSession('session-a', 'project-1', 'RUNNING');
  h.seedSession('session-b', 'project-1', 'QUEUED');
  h.firestore.seed('projects/project-1', {
    ...h.project(),
    activeSessionId: 'session-b',
  });

  await assert.rejects(
    h.sessions.finish('session-a', { sessionId: 'session-a', runnerId: 'runner-1', token: 'seed-token' }, { status: 'FAILED', error: 'stale' }),
    (error: unknown) => error instanceof AppError && error.code === 'session/project-guard-lost',
  );
  assert.equal(h.session('session-a')?.['status'], 'RUNNING');
  assert.equal(h.project()?.['activeSessionId'], 'session-b');
});

test('different projects may activate independently for the same user', async () => {
  const h = harness(['project-1', 'project-2']);
  const [first, second] = await Promise.all([
    h.sessions.create('user-1', 'project-1', { prompt: 'first', model: 'model-1' }),
    h.sessions.create('user-1', 'project-2', { prompt: 'second', model: 'model-1' }),
  ]);

  assert.equal(h.project('project-1')?.['activeSessionId'], first.id);
  assert.equal(h.project('project-2')?.['activeSessionId'], second.id);
  assert.equal(h.activeSessions().length, 2);
  assert.equal(h.charges(), 2);
});



/** Puts a project under a RUNNING session that still owns specialist holds. */
function holding(ids: readonly string[], states: readonly ('OPEN' | 'SETTLED' | 'RELEASED' | 'BROKEN')[]) {
  const h = harness();
  h.firestore.seed('projects/project-1', {
    ownerUid: 'user-1',
    name: 'project-1',
    platform: 'web',
    status: 'draft',
    activeSessionId: 'session-a',
    createdAt: Timestamp.fromMillis(0),
    updatedAt: Timestamp.fromMillis(0),
  });
  h.seedSession('session-a', 'project-1', 'RUNNING', ids);
  ids.forEach((id, index) => {
    const state = states[index];
    if (state !== undefined) {
      h.reservations.set(id, state);
    }
  });
  return h;
}

test('repeated family approval creates and charges one session', async () => {
  const h = harness();
  const input = { model: 'model-1', prompt: 'Build this' };
  const results = await Promise.all(Array.from({ length: 4 }, () => h.sessions.create('user-1', 'project-1', input, 'family-approved-request')));
  assert.ok(results.every((result) => result.id === 'family-approved-request'));
  assert.equal(h.firestore.documents.get('test-meter/user-1')?.data['consumed'], 1);
});

test('a former lease cannot mutate a session reclaimed by the same runner', async () => {
  const h = holding([], []);
  const stale = { sessionId: 'session-a', runnerId: 'runner-1', token: 'old-token' };
  await assert.rejects(h.sessions.heartbeat('session-a', stale));
  await assert.rejects(h.sessions.finish('session-a', stale, { status: 'IDLE' }));
  assert.equal(h.session('session-a')?.['status'], 'RUNNING');
});

test('an expired lease cannot heartbeat or finalize its own session', async () => {
  const h = holding([], []);
  h.firestore.seed('sessions/session-a', { ...h.session('session-a'), claimableAt: Timestamp.fromMillis(0) });
  const expired = { sessionId: 'session-a', runnerId: 'runner-1', token: 'seed-token' };
  await assert.rejects(h.sessions.heartbeat('session-a', expired));
  await assert.rejects(h.sessions.finish('session-a', expired, { status: 'IDLE' }));
  assert.equal(h.project()?.['activeSessionId'], 'session-a');
});

for (const outcome of [
  { status: 'IDLE' as const },
  { status: 'FAILED' as const, error: 'something broke' },
]) {
  test(`${outcome.status} finalisation closes a specialist hold it still owns`, async () => {
    const h = holding(['hold-1'], ['OPEN']);

    await h.sessions.finish('session-a', { sessionId: 'session-a', runnerId: 'runner-1', token: 'seed-token' }, outcome);

    assert.equal(h.reservations.get('hold-1'), 'RELEASED');
    assert.equal(h.session('session-a')?.['status'], outcome.status);
    // Terminal, and carrying nothing: the ids go with the finalisation.
    assert.equal(
      Object.prototype.hasOwnProperty.call(h.session('session-a') ?? {}, 'specialistReservationIds'),
      false,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(h.session('session-a') ?? {}, 'claimableAt'),
      false,
    );
    assert.equal(h.project()?.['activeSessionId'], null);
  });
}

for (const closed of ['SETTLED', 'RELEASED'] as const) {
  test(`an already-${closed} hold is dropped from the session without re-accounting`, async () => {
    const h = holding(['hold-1'], [closed]);

    await h.sessions.finish('session-a', { sessionId: 'session-a', runnerId: 'runner-1', token: 'seed-token' }, { status: 'IDLE' });

    // Untouched: no second accounting event for a hold that already closed.
    assert.equal(h.reservations.get('hold-1'), closed);
    assert.equal(h.session('session-a')?.['status'], 'IDLE');
    assert.equal(
      Object.prototype.hasOwnProperty.call(h.session('session-a') ?? {}, 'specialistReservationIds'),
      false,
    );
  });
}

test('a hold that cannot be released prevents the session becoming terminal', async () => {
  const h = holding(['hold-1'], ['BROKEN']);

  await assert.rejects(
    h.sessions.finish('session-a', { sessionId: 'session-a', runnerId: 'runner-1', token: 'seed-token' }, { status: 'IDLE' }),
    /disagrees with reservation hold-1/,
  );

  // Nothing committed: still RUNNING, still claimable, still holding the guard.
  assert.equal(h.session('session-a')?.['status'], 'RUNNING');
  assert.deepEqual(h.session('session-a')?.['specialistReservationIds'], ['hold-1']);
  assert.notEqual(h.session('session-a')?.['claimableAt'], undefined);
  assert.equal(h.project()?.['activeSessionId'], 'session-a');
});

test('retrying finalisation after a transient release failure is safe', async () => {
  const h = holding(['hold-1', 'hold-2'], ['BROKEN', 'OPEN']);

  await assert.rejects(h.sessions.finish('session-a', { sessionId: 'session-a', runnerId: 'runner-1', token: 'seed-token' }, { status: 'IDLE' }), /disagrees/);
  // The whole transaction rolled back, so the second hold was not released
  // either — there is no half-finalised state to reconcile.
  assert.equal(h.reservations.get('hold-2'), 'OPEN');

  // An operator repairs the ledger and the next runner tries again.
  h.reservations.set('hold-1', 'OPEN');
  await h.sessions.finish('session-a', { sessionId: 'session-a', runnerId: 'runner-1', token: 'seed-token' }, { status: 'IDLE' });

  assert.equal(h.reservations.get('hold-1'), 'RELEASED');
  assert.equal(h.reservations.get('hold-2'), 'RELEASED');
  assert.equal(h.session('session-a')?.['status'], 'IDLE');
});

async function routeApp(h: ReturnType<typeof harness>, append: SessionEvents['append'] = async (_id, type, data) => ({ id: '1-0', type, data })) {
  const app = Fastify({ logger: false });
  registerAuth(app, { verifyIdToken: async () => ({ uid: 'user-1', auth_time: Date.now() / 1000, exp: Date.now() / 1000 + 3600 }) } as unknown as Auth);
  registerErrorHandler(app);
  app.decorate('enforceRateLimit', () => async () => {});
  registerProjectRoutes(app, h.projects);
  registerSessionRoutes(app, h.sessions, { append } as SessionEvents,
    { heartbeatSeconds: 15, maxConnections: 10, maxConnectionsPerUser: 2, maxBufferedBytes: 1024, reauthenticate: async () => {} });
  return app;
}
const authHeaders = { authorization: 'Bearer fixture-token' };
function authority(h: ReturnType<typeof harness>, id: string, runnerId = 'runner-1') {
  return { sessionId: id, runnerId, token: String(h.session(id)?.['leaseToken']) };
}

test('whitespace project writes are refused and other tenants remain claimable', async () => {
  const h = harness(['project-1', 'project-2']);
  const first = await h.sessions.create('user-1', 'project-1', { model: 'model-1', prompt: 'Build one' });
  const second = await h.sessions.create('user-1', 'project-2', { model: 'model-1', prompt: 'Build two' });
  h.firestore.seed('projects/project-2', { ...h.project('project-2'), ownerUid: 'user-2' });
  h.firestore.seed(`sessions/${second.id}`, { ...h.session(second.id), ownerUid: 'user-2' });
  const app = await routeApp(h);
  try {
    for (const name of [' ', '\t', '\u00a0']) {
      await assert.rejects(h.projects.update('user-1', 'project-1', { name }), { code: 'project/invalid-name' });
      await assert.rejects(h.projects.create('user-1', { name, description: undefined, platform: 'web' }), { code: 'project/invalid-name' });
    }
    const response = await app.inject({ method: 'PATCH', url: '/projects/project-1', headers: authHeaders, payload: { name: '   ' } });
    assert.equal(response.statusCode, 400);
    assert.equal(h.project()?.['name'], 'project-1');
    const claims = [await h.sessions.claim('runner-1'), await h.sessions.claim('runner-2')];
    assert.deepEqual(new Set(claims.map((s) => s?.id)), new Set([first.id, second.id]));
  } finally { await app.close(); }
});

test('a cancelled running session can resume without inheriting its cancellation', async () => {
  const h = harness();
  const created = await h.sessions.create('user-1', 'project-1', { model: 'model-1', prompt: 'Initial' });
  await h.sessions.claim('runner-1');
  const oldLease = authority(h, created.id);
  await h.sessions.cancel('user-1', created.id);
  await h.sessions.finish(created.id, oldLease, { status: 'FAILED', error: 'Cancelled by user' });
  const resumed = await h.sessions.appendPrompt('user-1', created.id, 'Resume');
  assert.equal(resumed.cancelRequested, undefined);
  assert.equal(h.session(created.id)?.['cancelRequested'], undefined);
  await h.sessions.claim('runner-2');
  await h.sessions.heartbeat(created.id, authority(h, created.id, 'runner-2'));
  await assert.rejects(h.sessions.heartbeat(created.id, oldLease));
  assert.equal(h.charges(), 2);
});

test('a message accepted after the last dequeue is scheduled and charged exactly once', async () => {
  const h = harness();
  const created = await h.sessions.create('user-1', 'project-1', { model: 'model-1', prompt: 'Initial' });
  await h.sessions.claim('runner-1');
  const oldLease = authority(h, created.id);
  assert.equal(await h.sessions.dequeueNextMessage(created.id, oldLease), undefined);
  await h.sessions.enqueueMessage('user-1', created.id, 'Late follow-up');
  assert.equal(await h.sessions.finish(created.id, oldLease, { status: 'IDLE' }), 'QUEUED');
  assert.equal(h.project()?.['activeSessionId'], created.id);
  assert.equal(h.charges(), 1);
  const next = await h.sessions.claim('runner-2');
  assert.equal(next?.queuedTurnPending, true);
  const newLease = authority(h, created.id, 'runner-2');
  assert.equal(await h.sessions.startPendingTurn(created.id, newLease), true);
  assert.equal(h.charges(), 2);
  await assert.rejects(h.sessions.startPendingTurn(created.id, newLease), /no pending turn/);
  assert.equal(h.charges(), 2);
  assert.equal((await h.sessions.listMessages('user-1', created.id, 100)).at(-1)?.content, 'Late follow-up');
  assert.equal(await h.sessions.dequeueNextMessage(created.id, newLease), undefined);
  assert.equal(await h.sessions.finish(created.id, newLease, { status: 'IDLE' }), 'IDLE');
});

test('cancelling an unstarted late follow-up does not refund the completed turn', async () => {
  const h = harness();
  const created = await h.sessions.create('user-1', 'project-1', { model: 'model-1', prompt: 'Initial' });
  await h.sessions.claim('runner-1');
  await h.sessions.enqueueMessage('user-1', created.id, 'Late follow-up');
  await h.sessions.finish(created.id, authority(h, created.id), { status: 'IDLE' });
  await h.sessions.cancel('user-1', created.id);
  assert.equal(h.charges(), 1);
  assert.equal(h.project()?.['activeSessionId'], null);
  assert.equal(await h.sessions.claim('runner-2'), undefined);
});

test('enqueue racing finalization is either scheduled or explicitly refused', async () => {
  for (let attempt = 0; attempt < 4; attempt++) {
    const h = harness();
    const created = await h.sessions.create('user-1', 'project-1', { model: 'model-1', prompt: 'Initial' });
    await h.sessions.claim('runner-1');
    const lease = authority(h, created.id);
    const [enqueue] = await Promise.allSettled([
      h.sessions.enqueueMessage('user-1', created.id, 'Concurrent follow-up'),
      h.sessions.finish(created.id, lease, { status: 'IDLE' }),
    ]);
    if (enqueue.status === 'fulfilled') {
      assert.equal(h.session(created.id)?.['status'], 'QUEUED');
      assert.equal(h.project()?.['activeSessionId'], created.id);
    } else {
      assert.equal(h.session(created.id)?.['status'], 'IDLE');
    }
  }
});

test('steering survives Redis failure and is consumed once into durable history', async () => {
  const h = harness();
  const created = await h.sessions.create('user-1', 'project-1', { model: 'model-1', prompt: 'Initial' });
  await h.sessions.claim('runner-1');
  const lease = authority(h, created.id);
  const app = await routeApp(h, async () => { throw new Error('Redis offline'); });
  try {
    const result = await app.inject({ method: 'POST', url: `/sessions/${created.id}/messages`, headers: authHeaders,
      payload: { steer: true, prompt: 'Preserve customer records' } });
    assert.equal(result.statusCode, 200);
    assert.equal(h.session(created.id)?.['pendingSteer'], 'Preserve customer records');
    await assert.rejects(h.sessions.queueSteerMessage('other-user', created.id, 'Intrusion'), { code: 'session/not-found' });
    await h.sessions.queueSteerMessage('user-1', created.id, 'Preserve all records');
    await assert.rejects(h.sessions.drainSteerMessage(created.id, { ...lease, token: 'stale' }));
    assert.equal(await h.sessions.drainSteerMessage(created.id, lease), 'Preserve all records');
    assert.equal(await h.sessions.drainSteerMessage(created.id, lease), undefined);
    const messages = await h.sessions.listMessages('user-1', created.id, 100);
    assert.equal(messages.length, 2);
    assert.equal(messages.at(-1)?.content, 'Preserve all records');
    assert.equal(h.charges(), 1);
    await h.sessions.cancel('user-1', created.id);
    const rejected = await app.inject({ method: 'POST', url: `/sessions/${created.id}/messages`, headers: authHeaders,
      payload: { steer: true, prompt: 'Too late' } });
    assert.equal(rejected.statusCode, 409);
  } finally { await app.close(); }
});

test('steering accepted after the last step is scheduled without an additional build charge', async () => {
  const h = harness();
  const created = await h.sessions.create('user-1', 'project-1', { model: 'model-1', prompt: 'Initial' });
  await h.sessions.claim('runner-1');
  await h.sessions.queueSteerMessage('user-1', created.id, 'Late correction');
  assert.equal(await h.sessions.finish(created.id, authority(h, created.id), { status: 'IDLE' }), 'QUEUED');
  await h.sessions.claim('runner-2');
  assert.equal(await h.sessions.startPendingTurn(created.id, authority(h, created.id, 'runner-2')), true);
  assert.equal(h.charges(), 1);
  assert.equal((await h.sessions.listMessages('user-1', created.id, 100)).at(-1)?.content, 'Late correction');
});
