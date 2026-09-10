import assert from 'node:assert/strict';
import test from 'node:test';
import { Timestamp } from 'firebase-admin/firestore';
import type { Redis } from 'ioredis';
import { SubscriptionCache } from '../src/entitlements/subscription-cache.ts';
import { EntitlementService, type Subscription } from '../src/entitlements/service.ts';
import { BillingRepository } from '../src/billing/repository.ts';
import { parsePlan, parseRegistry } from '../src/entitlements/schema.ts';
import { planDocuments, registryDocument } from '../src/seed/config.ts';
import { ledger } from './support/ledger.ts';

// Model Redis's atomic compare-and-set and expiry; this is not a live Lua test.
function redisFixture() {
  const values = new Map<string, { value: string; expires: number }>();
  let now = 0;
  const get = (key: string) => {
    const entry = values.get(key);
    if (entry === undefined || entry.expires <= now) { values.delete(key); return null; }
    return entry.value;
  };
  const redis = {
    get: async (key: string) => get(key),
    set: async (key: string, value: string, ex: string, ttl: number, nx: string) => {
      assert.equal(ex, 'EX'); assert.equal(nx, 'NX');
      if (get(key) !== null) return null;
      values.set(key, { value, expires: now + ttl }); return 'OK';
    },
    del: async (key: string) => Number(values.delete(key)),
    eval: async (_script: string, count: number, key: string, token: string, value: string, ttl: number) => {
      assert.equal(count, 1);
      if (get(key) !== token) return 0;
      values.set(key, { value, expires: now + ttl }); return 1;
    },
  };
  return { cache: new SubscriptionCache(redis as unknown as Redis, 60),
    advance: () => { now += 61; }, loseData: () => values.clear() };
}
const paid: Subscription = { planKey: 'pro', status: 'ACTIVE',
  currentPeriodStart: new Date(Date.now() - 60000), currentPeriodEnd: new Date(Date.now() + 3600000) };
const registry = parseRegistry(registryDocument, 'config/registry');
const plans = new Map(planDocuments.map((doc) => [doc.key, parsePlan(doc, `plans/${doc.key}`, registry)]));

for (const upgrading of [false, true]) for (const refillBeforeResume of [false, true]) {
  test(`billing invalidation rejects an old fill: upgrade=${upgrading}, new fill first=${refillBeforeResume}`, async (t) => {
    const h = ledger();
    const { cache } = redisFixture();
    const service = new EntitlementService(h.db, { get: async () => ({ registry, plans }) } as never, cache);
    const billing = new BillingRepository(h.db, cache, 3600);
    if (!upgrading) h.data.set('subscriptions/u', { ...paid,
      currentPeriodStart: Timestamp.fromDate(paid.currentPeriodStart), currentPeriodEnd: Timestamp.fromDate(paid.currentPeriodEnd) });
    let entered!: () => void;
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    const doc = h.db.doc.bind(h.db);
    t.mock.method(h.db, 'doc', (path: string) => {
      const ref = doc(path);
      if (path === 'subscriptions/u') t.mock.method(ref, 'get', async () => {
        const fields = h.data.get(path);
        const frozen = fields === undefined ? undefined : { ...fields };
        if (first) { first = false; entered(); await resume; }
        return { exists: frozen !== undefined, data: () => frozen };
      });
      return ref;
    });
    const slow = service.forUser('u');
    await paused;
    const expected = upgrading ? 'pro' : 'free';
    try {
      await billing.synchronizeSubscription('u', async () => upgrading ? { ...paid, customerId: 'cus_fixture' } : null);
      if (refillBeforeResume) assert.equal((await service.forUser('u')).planKey, expected);
    } finally { release(); await slow; }
    assert.equal((await service.forUser('u')).planKey, expected);
    assert.equal((await service.forUser('u', new Date(), true)).planKey, expected);
  });
}

for (const loss of ['expiry', 'redis-loss']) test(`a fill cannot regain ownership after ${loss}`, async () => {
  const h = redisFixture();
  const old = await h.cache.beginFill('u'); assert.ok(old);
  assert.equal(await h.cache.read('u'), undefined);
  assert.equal(await h.cache.beginFill('u'), undefined);
  if (loss === 'expiry') h.advance(); else h.loseData();
  const next = await h.cache.beginFill('u'); assert.ok(next);
  assert.notEqual(next, old);
  await h.cache.write('u', null, next);
  await h.cache.write('u', paid, old);
  assert.deepEqual(await h.cache.read('u'), { subscription: null });
});

test('ordinary cache fills preserve paid values and expire', async () => {
  const h = redisFixture();
  const token = await h.cache.beginFill('u'); assert.ok(token);
  await h.cache.write('u', paid, token);
  assert.deepEqual(await h.cache.read('u'), { subscription: paid });
  h.advance(); assert.equal(await h.cache.read('u'), undefined);
});
