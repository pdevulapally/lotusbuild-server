import assert from 'node:assert/strict';
import test from 'node:test';
import type { Firestore } from 'firebase-admin/firestore';
import type { ConfigurationStore as ConfigurationStoreType } from '../src/entitlements/store.ts';
import { aiRatesV1Document, parseAiRateTable, unifiedFor } from '../src/entitlements/rates.ts';
import { ConfigurationStore } from '../src/entitlements/store.ts';
import { mergeRawUsage, rawUsageOf } from '../src/runner/agent.ts';
import { restoreCrossCheck, restoreEvidenceFields } from '../src/runner/loop.ts';
import { registryDocument, planDocuments } from '../src/seed/config.ts';

const v1 = parseAiRateTable(aiRatesV1Document, 'test');

test('the v1 rate table parses and prices exactly the live allowlist models', () => {
  assert.deepEqual([...v1.models.keys()].sort(), ['claude-haiku-4-5', 'claude-opus-5', 'claude-sonnet-5']);
  assert.equal(v1.version, 'v1');
});

test('malformed rate tables are refused rather than guessed at', () => {
  const base = JSON.parse(JSON.stringify(aiRatesV1Document)) as { models: Record<string, { tiers: Record<string, unknown>[] }> };
  const bad = (mutate: (doc: typeof base) => void): unknown => { const copy = JSON.parse(JSON.stringify(base)) as typeof base; mutate(copy); return copy; };
  assert.throws(() => parseAiRateTable(bad((d) => { d.models['claude-sonnet-5']!.tiers[0]!['input'] = { num: 1, den: 0 }; }), 'test'), /den/);
  assert.throws(() => parseAiRateTable(bad((d) => { d.models['claude-sonnet-5']!.tiers[0]!['maxInputTokens'] = 100000; }), 'test'), /unbounded/);
  assert.throws(() => parseAiRateTable(bad((d) => { delete d.models['claude-sonnet-5']!.tiers[0]!['cacheRead']; }), 'test'), /cacheRead/);
  assert.throws(() => parseAiRateTable({ ...aiRatesV1Document, version: '' }, 'test'), /version/);
});

test('unified conversion uses exact ratios to Sonnet 5 input with one ceiling per call', () => {
  assert.deepEqual(unifiedFor(v1, 'claude-haiku-4-5', { input: 1_600, output: 400 }), { unified: 1_800, tier: 0, rateVersion: 'v1' });
  assert.equal(unifiedFor(v1, 'claude-sonnet-5', { cacheRead: 10_000 })?.unified, 1_000);
  assert.equal(unifiedFor(v1, 'claude-opus-5', { output: 100 })?.unified, 1_250);
  assert.equal(unifiedFor(v1, 'claude-sonnet-5', { input: 1_000_000 })?.unified, 1_000_000);
  // 1 Haiku input token is half a unit: rounded up once, not per category.
  assert.equal(unifiedFor(v1, 'claude-haiku-4-5', { input: 1, cacheRead: 1 })?.unified, 1);
  assert.equal(unifiedFor(v1, 'claude-haiku-4-5', { input: 3, output: 1 })?.unified, 4);
  // Cache creation without a TTL split is priced at the 5-minute write rate.
  assert.equal(unifiedFor(v1, 'claude-sonnet-5', { cacheCreation: 8 })?.unified, 10);
  assert.equal(unifiedFor(v1, 'claude-sonnet-5', { cacheCreation5m: 4, cacheCreation1h: 4 })?.unified, 13);
  assert.equal(unifiedFor(v1, 'claude-sonnet-5', {})?.unified, 0);
  assert.equal(unifiedFor(v1, 'not-a-model', { input: 1 }), undefined);
  assert.throws(() => unifiedFor(v1, 'claude-sonnet-5', { input: -1 }));
});

test('a prompt over a tier boundary prices the whole request at the higher tier', () => {
  const tiered = parseAiRateTable({
    version: 't', referenceUnit: 'x',
    models: { m: { tiers: [
      { maxInputTokens: 100_000, input: { num: 1, den: 20 }, output: { num: 1, den: 4 }, cacheWrite5m: { num: 1, den: 16 }, cacheWrite1h: { num: 1, den: 10 }, cacheRead: { num: 1, den: 200 } },
      { maxInputTokens: null, input: { num: 1, den: 4 }, output: { num: 5, den: 4 }, cacheWrite5m: { num: 5, den: 16 }, cacheWrite1h: { num: 1, den: 2 }, cacheRead: { num: 1, den: 40 } },
    ] } },
  }, 'test');
  assert.deepEqual(unifiedFor(tiered, 'm', { input: 100_000, output: 100 }), { unified: 5_025, tier: 0, rateVersion: 't' });
  assert.deepEqual(unifiedFor(tiered, 'm', { input: 100_001, output: 100 }), { unified: 25_126, tier: 1, rateVersion: 't' });
  // Cached tokens count toward the prompt size that selects the tier.
  assert.equal(unifiedFor(tiered, 'm', { input: 50_000, cacheRead: 50_001 })?.tier, 1);
});

test('raw usage keeps the categories the provider reported and invents none', () => {
  assert.equal(rawUsageOf(undefined), undefined);
  assert.equal(rawUsageOf({}), undefined);
  assert.deepEqual(rawUsageOf({ input_tokens: 10, output_tokens: 2 }), { input: 10, output: 2 });
  assert.deepEqual(rawUsageOf({ input_tokens: 10, cache_read_input_tokens: null, cache_creation_input_tokens: 5, output_tokens: 2 }), { input: 10, cacheCreation: 5, output: 2 });
  assert.deepEqual(
    rawUsageOf({ input_tokens: 10, cache_creation_input_tokens: 9, cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 5 }, output_tokens: 2 }),
    { input: 10, cacheCreation5m: 4, cacheCreation1h: 5, output: 2 },
  );
  assert.deepEqual(rawUsageOf({ input_tokens: 1.5, output_tokens: -1 }), undefined);
});

function fakeFirestore(rates: unknown | undefined): Firestore {
  return {
    doc: (path: string) => ({
      get: async () => {
        if (path === 'config/registry') return { exists: true, data: () => registryDocument };
        if (path === 'config/aiRates') return rates === undefined ? { exists: false, data: () => undefined } : { exists: true, data: () => rates };
        throw new Error(`unexpected doc path: ${path}`);
      },
    }),
    collection: (path: string) => ({
      get: async () => {
        if (path !== 'plans') throw new Error(`unexpected collection path: ${path}`);
        return { docs: planDocuments.map((plan) => ({ id: plan.key, data: () => plan })) };
      },
    }),
  } as unknown as Firestore;
}

test('configuration loads without a rate table and with one', async () => {
  const absent = await new ConfigurationStore(fakeFirestore(undefined), 1000).get();
  assert.equal(absent.rates, undefined);
  assert.ok(absent.plans.size > 0);
  const present = await new ConfigurationStore(fakeFirestore(aiRatesV1Document), 1000).get();
  assert.equal(present.rates?.version, 'v1');
  await assert.rejects(new ConfigurationStore(fakeFirestore({ version: 'v2' }), 1000).get(), /config\/aiRates/);
});

import { Timestamp, type Transaction } from 'firebase-admin/firestore';
import { MeteringService } from '../src/metering/service.ts';
import { parseRegistry, parsePlan } from '../src/entitlements/schema.ts';
import { ResolvedEntitlements, type UserEntitlements } from '../src/entitlements/service.ts';
import { ledger } from './support/ledger.ts';

function meteringFixture() {
  const { db, data } = ledger();
  const registry = parseRegistry(registryDocument, 'registry');
  const plans = new Map(planDocuments.map((row) => [row.key, parsePlan(row, row.key, registry)]));
  const plan = plans.get('business')!;
  const entitlements = { planKey: plan.key, planName: plan.name, capabilities: new ResolvedEntitlements(plan.entitlements),
    meterLimits: plan.meterLimits, rateLimits: plan.rateLimits } as UserEntitlements;
  const configuration = { get: async () => ({ registry, plans, rates: undefined }) } as unknown as ConfigurationStoreType;
  const metering = new MeteringService(db, configuration);
  const meterKey = registry.inputTokenMeterKey;
  const reserve = (now: Date) => db.runTransaction((tx: Transaction) =>
    metering.reserveIn(tx, { uid: 'u', entitlements, meterKey, quantity: 100, operationId: 'op', now }));
  const record = (path: string) => data.get(path) as Record<string, unknown> | undefined;
  return { data, metering, meterKey, reserve, record };
}

const march = new Date('2026-03-31T23:50:00Z');
const april = new Date('2026-04-01T00:10:00Z');

test('a settled hold keeps its opening period, its evidence, and a durable period record', async () => {
  const f = meteringFixture();
  const hold = await f.reserve(march);
  const reservationPath = `users/u/reservations/${hold.id}`;
  assert.deepEqual(f.record(reservationPath)?.['openedPeriodStart'], Timestamp.fromDate(new Date('2026-03-01T00:00:00Z')));
  const evidence = { model: 'claude-sonnet-5', raw: { input: 60, output: 9 }, complete: true, rateVersion: 'v1', unified: 105, tier: 0 };
  assert.equal(await f.metering.settle({ uid: 'u', reservationId: hold.id, actualQuantity: 60, recordOverrun: true, now: march, evidence }), true);
  assert.deepEqual(f.record(reservationPath)?.['evidence'], evidence);
  const period = f.record(`users/u/usage/${f.meterKey}/periods/2026-03-01`);
  assert.equal(period?.['settled'], 60);
  assert.equal(period?.['settledLate'], undefined);
  assert.equal(period?.['unified'], 105);
  // Settling again changes nothing: the hold is closed.
  assert.equal(await f.metering.settle({ uid: 'u', reservationId: hold.id, actualQuantity: 60, now: march, evidence }), false);
  assert.equal(f.record(`users/u/usage/${f.meterKey}/periods/2026-03-01`)?.['settled'], 60);
});

test('a hold settled after the month turns is attributed late to its opening period while the live meter behaves as before', async () => {
  const f = meteringFixture();
  const hold = await f.reserve(march);
  assert.equal(await f.metering.settle({ uid: 'u', reservationId: hold.id, actualQuantity: 40, now: april }), true);
  const opening = f.record(`users/u/usage/${f.meterKey}/periods/2026-03-01`);
  assert.equal(opening?.['settledLate'], 40);
  assert.equal(opening?.['settled'], undefined);
  assert.equal(f.record(`users/u/usage/${f.meterKey}/periods/2026-04-01`), undefined);
  // Existing behaviour until PR C: the live usage document counts it in the current (April) period.
  const live = f.record(`users/u/usage/${f.meterKey}`);
  assert.equal(live?.['consumed'], 40);
  assert.deepEqual(live?.['periodStart'], Timestamp.fromDate(new Date('2026-04-01T00:00:00Z')));
});

test('a hold without evidence settles exactly as before and records no unified figure', async () => {
  const f = meteringFixture();
  const hold = await f.reserve(march);
  assert.equal(await f.metering.settle({ uid: 'u', reservationId: hold.id, actualQuantity: 100, now: march }), true);
  assert.equal(f.record(`users/u/reservations/${hold.id}`)?.['evidence'], undefined);
  const period = f.record(`users/u/usage/${f.meterKey}/periods/2026-03-01`);
  assert.equal(period?.['settled'], 100);
  assert.equal(period?.['unified'], undefined);
});

import { shadowEvidence } from '../src/runner/call-admission.ts';

test('shadow evidence never fails a settlement: conversion problems just leave the unified figure absent', () => {
  const raw = { input: 60, output: 9 };
  assert.deepEqual(shadowEvidence(undefined, 'claude-sonnet-5', raw), { model: 'claude-sonnet-5', raw, complete: true });
  assert.deepEqual(shadowEvidence(v1, 'retired-model', raw), { model: 'retired-model', raw, complete: true });
  assert.deepEqual(shadowEvidence(v1, 'claude-sonnet-5', raw), { model: 'claude-sonnet-5', raw, complete: true, unified: 105, tier: 0, rateVersion: 'v1' });
  const overflow = { input: Number.MAX_SAFE_INTEGER };
  assert.throws(() => unifiedFor(v1, 'claude-opus-5', overflow));
  assert.deepEqual(shadowEvidence(v1, 'claude-opus-5', overflow), { model: 'claude-opus-5', raw: overflow, complete: false });
});

test('restated usage overwrites by category and never lets a cache-creation total coexist with its breakdown', () => {
  assert.deepEqual(mergeRawUsage(undefined, { input: 5 }), { input: 5 });
  assert.deepEqual(mergeRawUsage({ input: 5, cacheRead: 3 }, undefined), { input: 5, cacheRead: 3 });
  // A later event that restates nothing about cache creation leaves the earlier split alone.
  assert.deepEqual(mergeRawUsage({ input: 5, cacheCreation5m: 4, cacheCreation1h: 1 }, { output: 9 }), { input: 5, cacheCreation5m: 4, cacheCreation1h: 1, output: 9 });
  // One that restates it as a total replaces the split outright, so nothing is counted twice.
  assert.deepEqual(mergeRawUsage({ input: 5, cacheCreation5m: 4, cacheCreation1h: 1 }, { cacheCreation: 5, output: 9 }), { input: 5, cacheCreation: 5, output: 9 });
  assert.deepEqual(mergeRawUsage({ cacheCreation: 5 }, { cacheCreation5m: 5 }), { cacheCreation5m: 5 });
});

test('restore evidence becomes summary fields only for what was reported, and the cross-check is decided only with a download figure', () => {
  assert.deepEqual(restoreEvidenceFields({}), {});
  assert.deepEqual(restoreEvidenceFields({ observedBytes: 10, httpCode: 200, archiveBytes: 10 }), { restoreObservedBytes: 10, restoreHttpCode: 200, restoreArchiveBytes: 10 });
  assert.deepEqual(restoreCrossCheck(4096, { outcome: 'initialised' }), {});
  assert.deepEqual(restoreCrossCheck(4096, { outcome: 'restored' }), {});
  assert.deepEqual(restoreCrossCheck(4096, { outcome: 'restored', observedBytes: 4096, httpCode: 200, archiveBytes: 4096 }), { restoreBytesMatch: true });
  assert.deepEqual(restoreCrossCheck(4096, { outcome: 'restored', observedBytes: 4096, httpCode: 200 }), { restoreBytesMatch: true });
  // A download shorter than the record, or an archive shorter than the download, is a mismatch to investigate, never a charge.
  assert.deepEqual(restoreCrossCheck(4096, { outcome: 'restored', observedBytes: 1024, httpCode: 200, archiveBytes: 1024 }), { restoreBytesMatch: false });
  assert.deepEqual(restoreCrossCheck(4096, { outcome: 'restored', observedBytes: 4096, httpCode: 200, archiveBytes: 2048 }), { restoreBytesMatch: false });
});

test('a period-record write that fails fails the whole settlement, which then retries once and only once', async () => {
  const { data, db } = ledger();
  const registry = parseRegistry(registryDocument, 'registry');
  const plans = new Map(planDocuments.map((row) => [row.key, parsePlan(row, row.key, registry)]));
  const plan = plans.get('business')!;
  const entitlements = { planKey: plan.key, planName: plan.name, capabilities: new ResolvedEntitlements(plan.entitlements),
    meterLimits: plan.meterLimits, rateLimits: plan.rateLimits } as UserEntitlements;
  const configuration = { get: async () => ({ registry, plans, rates: undefined }) } as unknown as ConfigurationStoreType;
  // The same ledger, with one transaction whose period-record write fails after the live documents were already written.
  let failPeriodWrites = 0;
  const flaky = { ...(db as unknown as Record<string, unknown>), runTransaction: <T>(work: (tx: Transaction) => Promise<T>) =>
    (db as unknown as { runTransaction<T>(work: (tx: unknown) => Promise<T>): Promise<T> }).runTransaction((tx) => work(new Proxy(tx as object, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property !== 'set') return value;
        return (ref: { path: string }, ...rest: unknown[]) => {
          if (ref.path.includes('/periods/') && failPeriodWrites > 0) { failPeriodWrites--; throw new Error('period record unavailable'); }
          return (value as (...args: unknown[]) => unknown).call(target, ref, ...rest);
        };
      },
    }) as Transaction)) } as unknown as Firestore;
  const metering = new MeteringService(flaky, configuration);
  const meterKey = registry.inputTokenMeterKey;
  const hold = await db.runTransaction((tx: Transaction) => metering.reserveIn(tx, { uid: 'u', entitlements, meterKey, quantity: 100, operationId: 'op', now: march }));
  const reservation = () => data.get(`users/u/reservations/${hold.id}`)!;
  const live = () => data.get(`users/u/usage/${meterKey}`)!;
  const period = () => data.get(`users/u/usage/${meterKey}/periods/2026-03-01`);
  assert.deepEqual([reservation()['status'], live()['reserved'], live()['consumed'] ?? 0], ['OPEN', 100, 0]);

  failPeriodWrites = 1;
  await assert.rejects(metering.settle({ uid: 'u', reservationId: hold.id, actualQuantity: 60, recordOverrun: true, now: march }), /period record unavailable/);
  // Nothing partial committed: the hold is still open and the live meter still carries it, so the caller's retry is safe.
  assert.deepEqual([reservation()['status'], live()['reserved'], live()['consumed'] ?? 0, period()], ['OPEN', 100, 0, undefined]);

  assert.equal(await metering.settle({ uid: 'u', reservationId: hold.id, actualQuantity: 60, recordOverrun: true, now: march }), true);
  assert.deepEqual([reservation()['status'], reservation()['settledQuantity'], live()['reserved'], live()['consumed'], period()?.['settled']], ['SETTLED', 60, 0, 60, 60]);

  // A duplicate retry after success charges nothing again and writes no second period increment.
  assert.equal(await metering.settle({ uid: 'u', reservationId: hold.id, actualQuantity: 60, recordOverrun: true, now: march }), false);
  assert.deepEqual([live()['consumed'], period()?.['settled']], [60, 60]);
  // A release attempted after settlement is likewise a no-op: the hold cannot be returned twice.
  assert.equal(await metering.release('u', hold.id), false);
  assert.deepEqual([live()['reserved'], live()['consumed']], [0, 60]);
});

test('an interrupted call is recorded as partial: its known usage stays on the hold but never enters the definitive period total', async () => {
  const f = meteringFixture();
  // Interrupted after message_start: prompt categories known, output never reported.
  const partial = shadowEvidence(v1, 'claude-haiku-4-5', { input: 7, cacheRead: 40, cacheCreation: 16 });
  assert.deepEqual(partial, { model: 'claude-haiku-4-5', raw: { input: 7, cacheRead: 40, cacheCreation: 16 }, complete: false, unified: 16, tier: 0, rateVersion: 'v1' });
  // Interrupted after message_delta: the authoritative output total arrived, so the call is complete even though it was cancelled.
  assert.equal(shadowEvidence(v1, 'claude-haiku-4-5', { input: 7, cacheRead: 40, cacheCreation: 16, output: 3 }).complete, true);
  const complete = shadowEvidence(v1, 'claude-sonnet-5', { input: 60, output: 9 });

  const first = await f.reserve(march);
  const second = await f.reserve(march);
  assert.equal(await f.metering.settle({ uid: 'u', reservationId: first.id, actualQuantity: 60, recordOverrun: true, now: march, evidence: complete }), true);
  assert.equal(await f.metering.settle({ uid: 'u', reservationId: second.id, actualQuantity: 63, recordOverrun: true, now: march, evidence: partial }), true);
  // The hold keeps the partial figure and says so; the audit trail loses nothing.
  assert.deepEqual(f.record(`users/u/reservations/${second.id}`)?.['evidence'], partial);
  // The period's definitive total is exactly the complete calls (105), neither understated by omitting
  // a complete call nor polluted by the partial one; the partial figure is aggregated apart.
  const period = f.record(`users/u/usage/${f.meterKey}/periods/2026-03-01`);
  assert.deepEqual([period?.['unified'], period?.['unifiedPartial'], period?.['settled']], [105, 16, 123]);
  // Today's meters are unaffected either way.
  assert.equal(f.record(`users/u/usage/${f.meterKey}`)?.['consumed'], 123);
});

test('output-only or promptless evidence is partial too: only a call with both authoritative figures enters the definitive total', async () => {
  const f = meteringFixture();
  const outputOnly = shadowEvidence(v1, 'claude-sonnet-5', { output: 9 });
  assert.deepEqual(outputOnly, { model: 'claude-sonnet-5', raw: { output: 9 }, complete: false, unified: 45, tier: 0, rateVersion: 'v1' });
  // Cache categories without the provider's input figure are not a complete prompt either.
  assert.equal(shadowEvidence(v1, 'claude-sonnet-5', { cacheRead: 100, output: 9 }).complete, false);
  // A zero input figure is still a reported figure; absence is what makes a call partial.
  assert.equal(shadowEvidence(v1, 'claude-sonnet-5', { input: 0, cacheRead: 100, output: 9 }).complete, true);
  const complete = shadowEvidence(v1, 'claude-sonnet-5', { input: 60, output: 9 });
  assert.deepEqual([complete.complete, complete.unified], [true, 105]);

  const first = await f.reserve(march);
  const second = await f.reserve(march);
  assert.equal(await f.metering.settle({ uid: 'u', reservationId: first.id, actualQuantity: 60, recordOverrun: true, now: march, evidence: complete }), true);
  assert.equal(await f.metering.settle({ uid: 'u', reservationId: second.id, actualQuantity: 1, recordOverrun: true, now: march, evidence: outputOnly }), true);
  assert.deepEqual(f.record(`users/u/reservations/${second.id}`)?.['evidence'], outputOnly);
  const period = f.record(`users/u/usage/${f.meterKey}/periods/2026-03-01`);
  assert.deepEqual([period?.['unified'], period?.['unifiedPartial']], [105, 45]);
});
