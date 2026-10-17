import assert from 'node:assert/strict';
import test from 'node:test';
import { mutation, readMutation, writeMutation } from '../src/http/idempotency.ts';
import { MutationReplay } from '../src/http/mutation-response.ts';
import { ledger } from './support/ledger.ts';
import { ProjectRepository, type Project } from '../src/projects/repository.ts';
import { UserRepository } from '../src/users/repository.ts';
import { ResolvedEntitlements, type EntitlementService } from '../src/entitlements/service.ts';

test('project retries across repository instances create one project and increment the quota once', async () => {
  const { db, data } = ledger();
  data.set('users/u', { uid: 'u', email: 'u@example.test', projectCount: 0 });
  const capabilities = new ResolvedEntitlements(new Map([
    ['platform.web', { kind: 'boolean' as const, value: true }],
    ['projects.max', { kind: 'number' as const, value: 10 }],
  ]));
  const entitlements = { forUser: async () => ({ capabilities, planName: 'Test', planKey: 'test' }) } as unknown as EntitlementService;
  const repository = () => new ProjectRepository(db, new UserRepository(db), entitlements);
  const input = { name: 'App', description: undefined, platform: 'web' as const };
  const operation = mutation<Project>('u', 'POST /projects', 'project-operation-1', input,
    (project) => ({ statusCode: 201, body: { id: project.id, createdAt: project.createdAt.toISOString() } }));
  const results = await Promise.allSettled([repository().create('u', input, operation), repository().create('u', input, operation)]);
  const success = results.find((result) => result.status === 'fulfilled');
  const replay = results.find((result) => result.status === 'rejected');
  assert.equal(success?.status, 'fulfilled'); assert.equal(replay?.status, 'rejected');
  if (success?.status !== 'fulfilled' || replay?.status !== 'rejected') throw new Error('Expected one creation and one replay');
  assert.ok(replay.reason instanceof MutationReplay);
  assert.deepEqual(replay.reason.response.body, { id: success.value.id, createdAt: success.value.createdAt.toISOString() });
  assert.equal(data.get('users/u')?.['projectCount'], 1);
  assert.equal([...data.keys()].filter((key) => key.startsWith('projects/')).length, 1);
});

test('receipt fingerprints are canonical and keys are scoped by user and operation', async () => {
  const { db, data } = ledger();
  const make = (uid: string, scope: string, payload: unknown) => mutation<string>(uid, scope, 'same-operation-key', payload,
    (value) => ({ statusCode: 201, body: { value } }))!;
  const first = make('alice', 'create', { a: 1, b: 2 });
  await db.runTransaction(async (tx) => { await readMutation(tx, db, first); writeMutation(tx, db, first, 'accepted'); });
  await assert.rejects(db.runTransaction((tx) => readMutation(tx, db, make('alice', 'create', { b: 2, a: 1 }))), MutationReplay);
  await assert.rejects(db.runTransaction((tx) => readMutation(tx, db, make('alice', 'create', { a: 3 }))), { code: 'request/idempotency-conflict' });
  await db.runTransaction((tx) => readMutation(tx, db, make('bob', 'create', { a: 3 })));
  await db.runTransaction((tx) => readMutation(tx, db, make('alice', 'message', { a: 3 })));
  assert.equal(data.size, 1);
});

test('a failed transaction commits neither its mutation nor its receipt and can be retried', async () => {
  const { db, data } = ledger();
  const operation = mutation<string>('alice', 'create', 'rollback-operation', {}, (value) => ({ statusCode: 201, body: { value } }))!;
  await assert.rejects(db.runTransaction(async (tx) => {
    await readMutation(tx, db, operation); tx.create(db.doc('projects/p'), { ownerUid: 'alice' });
    writeMutation(tx, db, operation, 'p'); throw new Error('Abort');
  }), /Abort/);
  assert.equal(data.size, 0);
  await db.runTransaction(async (tx) => { await readMutation(tx, db, operation); writeMutation(tx, db, operation, 'p'); });
  assert.equal(data.size, 1);
});
