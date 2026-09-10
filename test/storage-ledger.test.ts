import assert from 'node:assert/strict';
import test from 'node:test';
import { Timestamp } from 'firebase-admin/firestore';
import type { ConfigurationStore } from '../src/entitlements/store.ts';
import type { UserEntitlements } from '../src/entitlements/service.ts';
import { MeteringService } from '../src/metering/service.ts';
import { SnapshotMaintenance } from '../src/storage/maintenance.ts';
import type { SnapshotStore } from '../src/storage/snapshots.ts';
import { ledger } from './support/ledger.ts';

function fixture() {
  const { db, data } = ledger();
  const configuration = { get: async () => ({ registry: { storageMeterKey: 'storage', inputTokenMeterKey: 'input', meters: new Map([
    ['storage', { key: 'storage', label: 'Storage', unit: 'bytes', kind: 'GAUGE', resetPeriod: 'NEVER' }],
    ['input', { key: 'input', label: 'Input', unit: 'tokens', kind: 'COUNTER', resetPeriod: 'NEVER' }],
  ]) } }) } as unknown as ConfigurationStore;
  const metering = new MeteringService(db, configuration);
  const entitlements = { planKey: 'test', planName: 'Test', meterLimits: new Map([
    ['storage', { hardLimit: 1000, includedAllowance: 1000, overageEnabled: false }],
    ['input', { hardLimit: 1000, includedAllowance: 1000, overageEnabled: false }],
  ]) } as unknown as UserEntitlements;
  return { db, data, metering, entitlements };
}
test('parallel snapshot reservations cannot promise the same remaining capacity', async () => {
  const h = fixture();
  const results = await Promise.allSettled(Array.from({ length: 2 }, () => h.metering.reserve({ uid: 'u', entitlements: h.entitlements, meterKey: 'storage', quantity: 600, operationId: 'upload', now: new Date() })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(h.data.get('users/u/usage/storage')?.['reserved'], 600);
});
test('storage publication retains old bytes until confirmed cleanup and cannot double-charge', async () => {
  const h = fixture();
  h.data.set('users/u/usage/storage', { consumed: 200, reserved: 0, periodStart: Timestamp.fromMillis(0) });
  const hold = await h.metering.reserve({ uid: 'u', entitlements: h.entitlements, meterKey: 'storage', quantity: 300, operationId: 'upload', now: new Date() });
  await h.db.runTransaction((tx) => h.metering.commitStorageIn(tx, 'u', hold.id, 300));
  assert.equal(h.data.get('users/u/usage/storage')?.['consumed'], 500);
  await assert.rejects(h.db.runTransaction((tx) => h.metering.commitStorageIn(tx, 'u', hold.id, 300)));
  await h.db.runTransaction((tx) => h.metering.removeStoredBytesIn(tx, 'u', 200));
  assert.equal(h.data.get('users/u/usage/storage')?.['consumed'], 300);
});
test('failed candidate cleanup preserves quota; retry releases it once', async () => {
  const h = fixture();
  const hold = await h.metering.reserve({ uid: 'u', entitlements: h.entitlements, meterKey: 'storage', quantity: 300, operationId: 'upload', now: new Date() });
  h.data.set('snapshotUploads/upload', { ownerUid: 'u', projectId: 'p', objectName: 'projects/p/snapshots/upload.tar.gz', bytes: 300, reservationId: hold.id, status: 'CANDIDATE', expiresAt: Timestamp.fromMillis(0) });
  let fail = true;
  const cleanup = new SnapshotMaintenance(h.db, h.metering, { removeRetiredUpload: async () => { if (fail) throw new Error('offline'); } } as unknown as SnapshotStore);
  await assert.rejects(cleanup.sweep(), (error: unknown) => error instanceof AggregateError && error.errors.some((cause) => cause.message === 'offline'));
  assert.equal(h.data.get('users/u/usage/storage')?.['reserved'], 300);
  fail = false;
  await cleanup.sweep(); await cleanup.sweep();
  assert.equal(h.data.get('users/u/usage/storage')?.['reserved'], 0);
  assert.equal(h.data.get('snapshotUploads/upload')?.['status'], 'DELETED');
});
test('unknown in-flight usage cannot be released and recorded overruns survive recovery', async () => {
  const h = fixture();
  const hold = await h.metering.reserve({ uid: 'u', entitlements: h.entitlements, meterKey: 'input', quantity: 10, operationId: 'call', now: new Date() });
  await h.metering.markInFlight('u', [hold.id]);
  await assert.rejects(h.metering.reconcile('u', hold.id), { code: 'usage/reconciliation-required' });
  await h.metering.recordObservedUsage('u', hold.id, 15, 'provider-request');
  await h.metering.reconcile('u', hold.id);
  assert.equal(h.data.get(`users/u/reservations/${hold.id}`)?.['overrunQuantity'], 5);
  assert.equal(h.data.get('users/u/usage/input')?.['consumed'], 15);
});

test('failed obsolete-generation cleanup keeps its charged bytes and identifiers until success', async () => {
  const h = fixture();
  h.data.set('users/u/usage/storage', { consumed: 300, reserved: 0, periodStart: Timestamp.fromMillis(0) });
  h.data.set('snapshotUploads/old', { ownerUid: 'u', projectId: 'p', objectName: 'projects/p/old', bytes: 300,
    status: 'OBSOLETE', expiresAt: Timestamp.fromMillis(0) });
  let fail = true;
  const cleanup = new SnapshotMaintenance(h.db, h.metering, { removeRetiredUpload: async () => {
    if (fail) throw new Error('Generation still exists');
  } } as unknown as SnapshotStore);
  await assert.rejects(cleanup.sweep());
  assert.equal(h.data.get('users/u/usage/storage')?.['consumed'], 300);
  assert.equal(h.data.get('snapshotUploads/old')?.['objectName'], 'projects/p/old');
  fail = false;
  await cleanup.sweep();
  await cleanup.sweep();
  assert.equal(h.data.get('users/u/usage/storage')?.['consumed'], 0);
  assert.equal(h.data.get('snapshotUploads/old')?.['objectName'], undefined);
});
