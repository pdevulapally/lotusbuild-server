import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Timestamp, type Firestore } from 'firebase-admin/firestore';

import type { ConfigurationStore } from '../src/entitlements/store.ts';
import type { EntitlementService } from '../src/entitlements/service.ts';
import type { MeteringService } from '../src/metering/service.ts';
import type { ProjectRepository } from '../src/projects/repository.ts';
import {
  SessionRepository,
  messagesCollectionName,
  sessionsCollectionPath,
} from '../src/sessions/repository.ts';

/**
 * Proves `SessionRepository.listMessages` returns the most recent `limit`
 * durable messages, in chronological order — the bug this task fixes was
 * that it returned the *oldest* `limit` instead, via an ascending
 * `orderBy(FieldPath.documentId())` with no direction, which `.limit()`
 * truncates from the wrong end.
 *
 * The fake below is deliberately narrow: only what `readOwned` and
 * `listMessages` actually touch — one session document and its `messages`
 * subcollection, with real ordering/limit semantics. It exposes no write
 * path at all, which is itself proof a read-only method cannot mutate
 * durable state through it: there is nothing here to mutate.
 */

interface FakeDoc {
  readonly id: string;
  readonly fields: Record<string, unknown>;
}

class FakeDocSnapshot {
  readonly id: string;
  readonly ref: { readonly path: string };
  readonly #fields: Record<string, unknown> | undefined;

  constructor(id: string, path: string, fields: Record<string, unknown> | undefined) {
    this.id = id;
    this.ref = { path };
    this.#fields = fields;
  }

  get exists(): boolean {
    return this.#fields !== undefined;
  }

  data(): Record<string, unknown> | undefined {
    return this.#fields === undefined ? undefined : { ...this.#fields };
  }
}

/** Mimics exactly the one query shape `listMessages` issues: order, then bound, then fetch. */
class FakeMessagesQuery {
  readonly #docs: readonly FakeDoc[];
  readonly #basePath: string;
  readonly #onScan: (returned: number) => void;
  #direction: 'asc' | 'desc' = 'asc';
  #cap: number | undefined;

  constructor(docs: readonly FakeDoc[], basePath: string, onScan: (returned: number) => void) {
    this.#docs = docs;
    this.#basePath = basePath;
    this.#onScan = onScan;
  }

  // `listMessages` only ever orders by FieldPath.documentId(), never a string
  // field, so the field argument itself is not inspected here — document id
  // is the only ordering this fake understands.
  orderBy(_field: unknown, direction: 'asc' | 'desc' = 'asc'): this {
    this.#direction = direction;
    return this;
  }

  limit(maximum: number): this {
    this.#cap = maximum;
    return this;
  }

  async get(): Promise<{ readonly docs: readonly FakeDocSnapshot[] }> {
    const sorted = [...this.#docs].sort((a, b) => {
      const cmp = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      return this.#direction === 'asc' ? cmp : -cmp;
    });
    const limited = this.#cap === undefined ? sorted : sorted.slice(0, this.#cap);
    // Recorded so a test can prove the *query* was bounded — Firestore never
    // handed back more than the limit — rather than the whole collection
    // being read and sliced afterwards.
    this.#onScan(limited.length);
    return {
      docs: limited.map((doc) => new FakeDocSnapshot(doc.id, `${this.#basePath}/${doc.id}`, doc.fields)),
    };
  }
}

class FakeFirestore {
  readonly scans: number[] = [];
  readonly #sessionPath: string;
  readonly #sessionFields: Record<string, unknown>;
  readonly #messages: readonly FakeDoc[];

  constructor(sessionId: string, sessionFields: Record<string, unknown>, messages: readonly FakeDoc[]) {
    this.#sessionPath = `${sessionsCollectionPath}/${sessionId}`;
    this.#sessionFields = sessionFields;
    this.#messages = messages;
  }

  doc(path: string) {
    if (path !== this.#sessionPath) {
      throw new Error(`unexpected document path in this fake: ${path}`);
    }
    const sessionPath = this.#sessionPath;
    const sessionId = sessionPath.split('/').at(-1) ?? '';
    const fields = this.#sessionFields;
    const messages = this.#messages;
    const scans = this.scans;
    return {
      path: sessionPath,
      get: async () => new FakeDocSnapshot(sessionId, sessionPath, fields),
      collection: (name: string) => {
        if (name !== messagesCollectionName) {
          throw new Error(`unexpected subcollection in this fake: ${name}`);
        }
        return new FakeMessagesQuery(messages, `${sessionPath}/${name}`, (returned) => scans.push(returned));
      },
    };
  }
}

/** `id` sorts lexically the same as `i` numerically for every count used here (well under 100). */
function messageDocs(count: number): FakeDoc[] {
  return Array.from({ length: count }, (_, i) => ({
    id: String(i).padStart(2, '0'),
    fields: {
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message-${i}`,
      createdAt: Timestamp.fromMillis(i * 1000),
    },
  }));
}

function harness(messageCount: number) {
  const firestore = new FakeFirestore(
    'session-1',
    {
      projectId: 'project-1',
      ownerUid: 'user-1',
      status: 'RUNNING',
      model: 'model-1',
      effort: 'standard',
      messageCount,
      createdAt: Timestamp.now(),
    },
    messageDocs(messageCount),
  );
  const sessions = new SessionRepository(
    firestore as unknown as Firestore,
    {} as unknown as ProjectRepository,
    {} as unknown as EntitlementService,
    {} as unknown as ConfigurationStore,
    {} as unknown as MeteringService,
    60,
  );
  return { firestore, sessions };
}

test('more messages than the limit: returns the newest N in chronological order', async () => {
  // Durable messages 0..9 (this fake's 0-based equivalent of the task's 1..10);
  // limit 4 must return the last four — 6,7,8,9 — oldest of that window first.
  const { sessions } = harness(10);

  const messages = await sessions.listMessages('user-1', 'session-1', 4);

  assert.deepEqual(
    messages.map((m) => m.seq),
    [6, 7, 8, 9],
  );
  // Chronological: seq strictly ascending across the returned window.
  assert.ok(messages.every((m, i) => i === 0 || m.seq > (messages[i - 1]?.seq ?? -1)));
});

test('the newest user request reaches the model context once history exceeds the limit', async () => {
  // 9 durable messages, alternating user/assistant, ending on a user message —
  // exactly the moment a runner picks up a session right after appendPrompt.
  // This is the core regression: before the fix, message 8 (the newest ask)
  // was excluded entirely because the query kept messages 0..3 instead.
  const { sessions } = harness(9);

  const messages = await sessions.listMessages('user-1', 'session-1', 4);

  const last = messages.at(-1);
  assert.ok(last !== undefined);
  assert.equal(last.seq, 8);
  assert.equal(last.role, 'user');
  assert.equal(last.content, 'message-8');
  // And it really is the newest four, not some other window that happens to
  // include message 8.
  assert.deepEqual(
    messages.map((m) => m.seq),
    [5, 6, 7, 8],
  );
});

test('exactly at the limit: every message is returned in chronological order', async () => {
  const { sessions } = harness(4);

  const messages = await sessions.listMessages('user-1', 'session-1', 4);

  assert.deepEqual(
    messages.map((m) => m.seq),
    [0, 1, 2, 3],
  );
});

test('under the limit: every available message is returned in chronological order', async () => {
  const { sessions } = harness(3);

  const messages = await sessions.listMessages('user-1', 'session-1', 10);

  assert.deepEqual(
    messages.map((m) => m.seq),
    [0, 1, 2],
  );
});

test('a single-message session returns that one message correctly', async () => {
  // The floor of the domain: a session's messageCount is required to be at
  // least 1 (parseSession enforces { min: 1 }), and the very first message is
  // created atomically with the session — a zero-message session cannot
  // exist, so there is no "empty history" state to preserve or invent here.
  const { sessions } = harness(1);

  const messages = await sessions.listMessages('user-1', 'session-1', 4);

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.seq, 0);
  assert.equal(messages[0]?.role, 'user');
  assert.equal(messages[0]?.content, 'message-0');
});

test('the query itself is bounded: Firestore never hands back more than the limit', async () => {
  const { sessions, firestore } = harness(10);

  await sessions.listMessages('user-1', 'session-1', 4);

  // Exactly one query against the messages subcollection, and it returned at
  // most the requested limit — the bound is enforced by the query (limit()
  // before get()), not by reading everything and slicing afterwards.
  assert.deepEqual(firestore.scans, [4]);
});

// No dedicated HTTP-route test is added: `GET /sessions/:sessionId/messages`
// (src/sessions/routes.ts) is a thin wrapper with no ordering logic of its
// own — it calls this exact `listMessages` with a flat `limit` and maps the
// result through `toMessageResponse`, a field-projection with no reordering.
// This repository has no Fastify request-injection test harness anywhere
// today; building one solely to re-exercise a call this suite already covers
// directly would be new, unrelated test infrastructure for this focused fix.
// What matters for the route's evident contract is that the endpoint now
// reflects the session's current state rather than being permanently stuck
// on its first `limit` messages, which the tests above already prove for the
// identical call shape the route makes.
