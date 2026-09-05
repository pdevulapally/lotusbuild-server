import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import { SnapshotStore } from '../src/storage/snapshots.ts';

test('snapshot preflight rejects public access and missing uniform access', async (t) => {
  const app = initializeApp({ projectId: 'test-offline' }, 'snapshot-boundaries');
  const storage = getStorage(app);
  let uniform = true;
  let prevention = 'enforced';
  let members: string[] = [];
  t.mock.method(storage, 'bucket', () => ({ exists: async () => [true],
    getMetadata: async () => [{ iamConfiguration: { uniformBucketLevelAccess: { enabled: uniform }, publicAccessPrevention: prevention } }],
    iam: { getPolicy: async () => [{ bindings: [{ members }] }] } }));
  const store = new SnapshotStore(app, 'offline-test', 60);
  try {
    await store.assertReachable();
    uniform = false; await assert.rejects(store.assertReachable(), /uniform/);
    uniform = true; prevention = 'inherited'; await assert.rejects(store.assertReachable(), /public access/);
    prevention = 'enforced'; members = ['allAuthenticatedUsers']; await assert.rejects(store.assertReachable(), /public IAM/);
  } finally { await deleteApp(app); }
});

test('erasure pages historic content generations, preserving zero-byte barriers', async (t) => {
  const app = initializeApp({ projectId: 'test-offline' }, 'snapshot-erasure');
  const storage = getStorage(app);
  const deleted: string[] = [];
  const requests: Record<string, unknown>[] = [];
  const saved: string[] = [];
  t.mock.method(storage, 'bucket', () => ({
    getFiles: async (options: Record<string, unknown>) => { requests.push(options); return options['pageToken'] === undefined
      ? [[{ name: 'projects/p/old', metadata: { size: '12', generation: '7' } }], { pageToken: 'next' }]
      : [[{ name: 'projects/p/barrier', metadata: { size: '0', generation: '8' } }], null]; },
    file: (name: string, options?: { generation: string }) => ({
      getMetadata: async () => [{ generation: '9' }],
      save: async (bytes: Buffer, opts: { preconditionOpts: { ifGenerationMatch: string } }) => {
        assert.equal(bytes.length, 0); assert.equal(opts.preconditionOpts.ifGenerationMatch, '9'); saved.push(name);
      },
      delete: async (opts: { ifGenerationMatch: string }) => { assert.equal(options?.generation, '7'); assert.equal(opts.ifGenerationMatch, '7'); deleted.push(name); },
    }),
  }));
  try {
    await new SnapshotStore(app, 'offline-test', 60).eraseProjectContent('p');
    assert.deepEqual(deleted, ['projects/p/old']); assert.deepEqual(saved, ['projects/p/old']);
    assert.equal(requests.length, 2);
    assert.ok(requests.every((r) => r['versions'] === true && r['autoPaginate'] === false && r['maxResults'] === 100 && r['prefix'] === 'projects/p/'));
  } finally { await deleteApp(app); }
});
