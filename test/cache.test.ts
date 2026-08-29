import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { cached } from '../src/support/cache.ts';

test('concurrent misses collapse into a single load', async () => {
  // This is what stops a burst of traffic on the public pricing page becoming
  // a burst of traffic at Stripe and Firestore. Without it, /plans has no
  // protection at all beyond its rate limit.
  let loads = 0;
  const entry = cached(60_000, async () => {
    loads += 1;
    await sleep(10);
    return loads;
  });

  const results = await Promise.all([entry.get(), entry.get(), entry.get(), entry.get()]);
  assert.equal(loads, 1);
  assert.deepEqual(results, [1, 1, 1, 1]);
});

test('a failed load does not wedge the cache permanently', async () => {
  // If the rejected promise were held, one transient Firestore blip would
  // replay the same failure for the whole TTL.
  let attempts = 0;
  const entry = cached(60_000, async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error('transient');
    }
    return 'recovered';
  });

  await assert.rejects(() => entry.get(), /transient/);
  assert.equal(await entry.get(), 'recovered');
  assert.equal(attempts, 2);
});

test('a value is reloaded once its TTL has passed', async () => {
  let loads = 0;
  const entry = cached(20, async () => {
    loads += 1;
    return loads;
  });

  assert.equal(await entry.get(), 1);
  assert.equal(await entry.get(), 1);
  await sleep(40);
  assert.equal(await entry.get(), 2);
});

test('invalidate forces the next read to reload', async () => {
  let loads = 0;
  const entry = cached(60_000, async () => {
    loads += 1;
    return loads;
  });

  await entry.get();
  entry.invalidate();
  assert.equal(await entry.get(), 2);
});

test('a TTL that would disable caching is refused', () => {
  // A zero or negative TTL silently turns every cached read into a live one.
  for (const ttl of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => cached(ttl, async () => 'x'), /TTL/);
  }
});
