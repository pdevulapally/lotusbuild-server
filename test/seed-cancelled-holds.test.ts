import assert from 'node:assert/strict';
import test from 'node:test';

import { Timestamp } from 'firebase-admin/firestore';

import { planCancelledHoldClosure } from '../src/seed/cancelled-holds.ts';

const now = new Date('2026-11-02T12:00:00Z');
const tokenMeterKeys = new Set(['ai.tokens.input', 'ai.tokens.output']);
const stuck = { ownerUid: 'u', status: 'RUNNING', cancelRequested: true, claimedBy: 'runner:1', claimableAt: Timestamp.fromMillis(now.getTime() + 3_600_000), heartbeatAt: Timestamp.fromMillis(now.getTime() - 3_600_000),
  reservationIds: ['cap'], specialistReservationIds: ['seconds', 'out'] };
const reservations = new Map<string, Record<string, unknown>>([
  ['cap', { meterKey: 'sandbox.concurrent.web', status: 'RELEASED', inFlight: false, estimatedQuantity: 1, sandboxExternalId: 'vm' }],
  ['seconds', { meterKey: 'sandbox.seconds', status: 'SETTLED', inFlight: true, observedQuantity: 47, estimatedQuantity: 1800, sandboxExternalId: 'vm' }],
  ['out', { meterKey: 'ai.tokens.output', status: 'OPEN', inFlight: true, estimatedQuantity: 16000 }],
]);

test('only the cut-off model-token hold of a stopped, lease-expired session is marked for settlement', () => {
  const plan = planCancelledHoldClosure({ sessionId: 's', session: stuck, reservations, tokenMeterKeys, leaseSeconds: 60, now });
  assert.equal(plan.ownerUid, 'u');
  assert.deepEqual(plan.holds.map((hold) => [hold.id, hold.verdict]), [['cap', 'already-closed'], ['seconds', 'already-closed'], ['out', 'settle']]);
  assert.equal(plan.holds[2]?.estimatedQuantity, 16000);
});

test('holds the service would refuse are reported, never marked', () => {
  const refused = new Map(reservations);
  refused.set('out', { meterKey: 'ai.tokens.output', status: 'OPEN', inFlight: true, estimatedQuantity: 16000, sandboxExternalId: 'vm' });
  refused.set('other', { meterKey: 'storage.bytes', status: 'OPEN', inFlight: true, estimatedQuantity: 5 });
  refused.set('seen', { meterKey: 'ai.tokens.input', status: 'OPEN', inFlight: true, observedQuantity: 3, estimatedQuantity: 5 });
  refused.set('idle', { meterKey: 'ai.tokens.input', status: 'OPEN', inFlight: false, estimatedQuantity: 5 });
  const session = { ...stuck, specialistReservationIds: ['seconds', 'out', 'other', 'seen', 'idle'] };
  const plan = planCancelledHoldClosure({ sessionId: 's', session, reservations: refused, tokenMeterKeys, leaseSeconds: 60, now });
  assert.deepEqual(plan.holds.filter((hold) => hold.verdict === 'settle'), []);
  assert.deepEqual(plan.holds.slice(2).map((hold) => hold.verdict), ['resource-hold', 'not-a-token-meter', 'has-usage', 'not-in-flight']);
});

test('a session that is not a stopped, lease-expired run is refused outright', () => {
  assert.throws(() => planCancelledHoldClosure({ sessionId: 's', session: undefined, reservations, tokenMeterKeys, leaseSeconds: 60, now }), /does not exist/);
  assert.throws(() => planCancelledHoldClosure({ sessionId: 's', session: { ...stuck, cancelRequested: false }, reservations, tokenMeterKeys, leaseSeconds: 60, now }), /without a pending cancellation/);
  assert.throws(() => planCancelledHoldClosure({ sessionId: 's', session: { ...stuck, status: 'IDLE' }, reservations, tokenMeterKeys, leaseSeconds: 60, now }), /nothing to close/);
  assert.throws(() => planCancelledHoldClosure({ sessionId: 's', session: { ...stuck, heartbeatAt: Timestamp.fromMillis(now.getTime() - 10_000) }, reservations, tokenMeterKeys, leaseSeconds: 60, now }), /live lease/);
  assert.throws(() => planCancelledHoldClosure({ sessionId: 's', session: stuck, reservations: new Map(), tokenMeterKeys, leaseSeconds: 60, now }), /does not exist/);
});
