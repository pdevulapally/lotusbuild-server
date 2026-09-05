import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { BillingRepository } from '../src/billing/repository.ts';
import { currentSubscription, type StripeSubscriptionState } from '../src/billing/stripe.ts';
import type { SubscriptionCache } from '../src/entitlements/subscription-cache.ts';
import type Stripe from 'stripe';

// Serial transactions model Firestore's committed view, including rollback on
// failure. External Stripe reads deliberately run outside this critical section.
function fixture() {
  const data = new Map<string, Record<string, unknown>>();
  let tail = Promise.resolve();
  const db = {
    doc: (path: string) => ({ path }),
    runTransaction<T>(work: (tx: unknown) => Promise<T>): Promise<T> {
      const result = tail.then(async () => {
        const pending = new Map(data);
        const tx = {
          get: async (ref: { path: string }) => ({ exists: pending.has(ref.path), data: () => pending.get(ref.path) }),
          set: (ref: { path: string }, fields: Record<string, unknown>) => pending.set(ref.path, fields),
          delete: (ref: { path: string }) => pending.delete(ref.path),
        };
        const answer = await work(tx);
        data.clear();
        for (const entry of pending) data.set(...entry);
        return answer;
      });
      tail = result.then(() => {}, () => {});
      return result;
    },
  };
  const invalidations: string[] = [];
  const repository = new BillingRepository(db as unknown as Firestore,
    { invalidate: async (uid: string) => { invalidations.push(uid); } } as unknown as SubscriptionCache, 3600);
  return { repository, data, invalidations };
}

test('linked children and accounts awaiting erasure cannot acquire a billing customer mapping', async () => {
  for (const collection of ['familyLinks', 'accountErasures']) {
    const h = fixture();
    h.data.set(`${collection}/alice`, { status: 'PENDING' });
    await assert.rejects(h.repository.linkCustomer('alice', 'cus_test'), { code: 'billing/account-restricted' });
    assert.equal(h.data.has('stripeCustomers/cus_test'), false);
  }
});

test('an in-progress webhook is retryable; only completion permits duplicate acknowledgement', async () => {
  const { repository } = fixture();
  const claim = await repository.claimEvent('evt_1');
  assert.equal(claim.kind, 'claimed');
  if (claim.kind !== 'claimed') throw new Error('expected claim');
  await assert.rejects(repository.claimEvent('evt_1'), { code: 'billing/processing', statusCode: 503 });
  await repository.completeEvent('evt_1', claim.token);
  assert.deepEqual(await repository.claimEvent('evt_1'), { kind: 'completed' });
});

test('a replaced webhook worker cannot complete or remove the successor claim', async () => {
  const { repository, data } = fixture();
  const old = await repository.claimEvent('evt_2');
  if (old.kind !== 'claimed') throw new Error('expected claim');
  data.get('stripeEvents/evt_2')!['leaseUntil'] = Timestamp.fromMillis(0);
  const next = await repository.claimEvent('evt_2');
  if (next.kind !== 'claimed') throw new Error('expected claim');
  await assert.rejects(repository.completeEvent('evt_2', old.token), { code: 'billing/processing' });
  await repository.releaseEvent('evt_2', old.token);
  assert.equal(data.get('stripeEvents/evt_2')!['token'], next.token);
  await repository.completeEvent('evt_2', next.token);
});

test('parallel checkout requests share one operation and retain its original price', async () => {
  const { repository } = fixture();
  const operations = await Promise.all(Array.from({ length: 12 }, () => repository.checkoutOperation('u', 'pro', 'price_1')));
  assert.equal(new Set(operations.map((operation) => operation.id)).size, 1);
  assert.deepEqual(await repository.checkoutOperation('u', 'pro', 'price_2'), operations[0]);
  await assert.rejects(repository.checkoutOperation('u', 'max', 'price_3'), { code: 'billing/checkout-pending' });
});

test('subscription synchronization rejects concurrent reads and fences a stale worker after takeover', async () => {
  const { repository, data } = fixture();
  let resolve!: (state: StripeSubscriptionState | null) => void;
  let entered!: () => void;
  const reading = new Promise<void>((done) => { entered = done; });
  const stale = repository.synchronizeSubscription('u', () => {
    entered();
    return new Promise((done) => { resolve = done; });
  });
  await reading;
  await assert.rejects(repository.synchronizeSubscription('u', async () => null), { code: 'billing/processing' });
  data.get('billingSynchronization/u')!['leaseUntil'] = Timestamp.fromMillis(0);
  const active: StripeSubscriptionState = { planKey: 'pro', status: 'ACTIVE', customerId: 'cus_1',
    currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 1000) };
  await repository.synchronizeSubscription('u', async () => active);
  resolve(null);
  await assert.rejects(stale, { code: 'billing/processing' });
  assert.equal(data.get('subscriptions/u')!['planKey'], 'pro');
});

test('multiple live subscriptions are refused, while canceled history cannot mask the current one', () => {
  const canceled = { status: 'canceled' } as Stripe.Subscription;
  const active = { status: 'active' } as Stripe.Subscription;
  assert.equal(currentSubscription([canceled, active]), active);
  assert.throws(() => currentSubscription([active, active]), { code: 'billing/multiple-subscriptions' });
});
