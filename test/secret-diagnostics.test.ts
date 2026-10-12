import assert from 'node:assert/strict';
import test from 'node:test';
import { inspect } from 'node:util';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import Stripe from 'stripe';
import { Redis } from 'ioredis';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import { SnapshotStore } from '../src/storage/snapshots.ts';
import { asBoolean, asEnum, asInteger, asList, asPort, asUrl, EnvironmentError, loadEnv } from '../src/config/env.ts';
import type { Config, SharedConfig } from '../src/config/index.ts';
import { initialiseFirebase } from '../src/firebase.ts';
import { initialiseFirebaseAuth } from '../src/auth/firebase.ts';
import { connectRedis } from '../src/redis/client.ts';
import { AppError, registerErrorHandler, safeErrorDiagnostic, safeProviderLogger } from '../src/http/errors.ts';
import Anthropic from '@anthropic-ai/sdk';
import pino from 'pino';
import { RunnerWorkError } from '../src/runner/loop.ts';
import { registerBillingRoutes } from '../src/billing/routes.ts';
import { runUntilStopped, type SessionRunner } from '../src/runner/loop.ts';

const marker = 'synthetic-sensitive-marker';

test('I04: nested maintenance failures cannot reach structured operational logs', async () => {
  const records: unknown[] = [];
  let active = true;
  const error = new AggregateError([new Error(`Bearer ${marker}`), { stderr: `DATABASE_URL=${marker}` }], marker,
    { cause: new Error(marker) });
  await runUntilStopped({ runOnce: async () => { active = false; return true; } } as unknown as SessionRunner, {
    idlePollSeconds: 1, shouldContinue: () => active, maintenance: async () => { throw error; },
    log: { info: () => {}, warn: () => {}, error: (details, message) => records.push({ details, message }) },
  });
  assert.equal(records.length, 1);
  assert.equal(inspect(records, { depth: 10 }).includes(marker), false);
  assert.ok(JSON.stringify(records).includes('error/aggregate'));
});

test('runtime diagnostics allow only known codes and numeric status/exit metadata', () => {
  const error = new AppError({ code: 'usage/limit-reached', statusCode: 429, message: marker,
    details: { headers: { authorization: `Bearer ${marker}` }, environment: marker }, cause: new Error(marker) });
  const result = safeErrorDiagnostic(error);
  assert.equal(result.category, 'usage/limit-reached');
  assert.equal(result.statusCode, 429);
  assert.equal(result.nestedCount, 1);
  safe(result);
  assert.equal(safeErrorDiagnostic(new AppError({ code: marker, statusCode: 400, message: marker })).category, 'application/error');
  const command = Object.assign(new Error(marker), { stderr: `DATABASE_URL=postgres://user:${marker}@example`, stdout: marker,
    command: marker, exitCode: 7, response: { body: marker }, status: 503, headers: { authorization: marker } });
  assert.deepEqual(safeErrorDiagnostic(command), { category: 'error/runtime', statusCode: 503, exitCode: 7 });
  safe(safeErrorDiagnostic({ message: marker, stack: marker, name: marker, code: marker, status: marker, url: marker }));
  assert.deepEqual(safeErrorDiagnostic(marker), { category: 'error/unknown' });
  const env = safeErrorDiagnostic(new EnvironmentError([`REDIS_URL is invalid: ${marker}`, `${marker} is invalid`]));
  assert.deepEqual(env, { category: 'configuration/invalid', configurationKeys: ['REDIS_URL'] });
  safe(env);
});

test('nested diagnostics handle causes, arrays, cycles, getters and large payloads without dumping them', () => {
  let getterCalls = 0;
  const nested = new AggregateError([new Error(marker), new AppError({ code: 'usage/reconciliation-required', statusCode: 409, message: marker })], marker);
  Object.defineProperty(nested, 'payload', { get: () => { getterCalls++; throw new Error(marker); } });
  Object.defineProperty(nested, 'toJSON', { value: () => { throw new Error(marker); } });
  Object.defineProperty(nested, 'cause', { value: nested });
  const result = safeErrorDiagnostic(nested);
  safe(result);
  assert.equal(result.nestedCount, 3);
  assert.ok(result.nestedCategories?.includes('usage/reconciliation-required'));
  assert.equal(result.truncated, true);
  const huge = new Array(1000000).fill(nested);
  const large = safeErrorDiagnostic(huge);
  assert.equal(large.nestedCount, 1000000);
  assert.equal(large.truncated, true);
  assert.ok(JSON.stringify(large).length < 3000);
  const getters = Object.defineProperties({}, Object.fromEntries(['cause', 'errors', 'message', 'status', 'code'].map((key) =>
    [key, { get: () => { getterCalls++; throw new Error(marker); } }])));
  safe(safeErrorDiagnostic(getters));
  const proxy = Proxy.revocable({}, {}); proxy.revoke();
  assert.deepEqual(safeErrorDiagnostic(proxy.proxy), { category: 'error/unknown' });
  assert.equal(getterCalls, 0);
});

test('runner diagnostics preserve existing primary and cleanup categories, never exception text', () => {
  const error = new RunnerWorkError(new AppError({ code: 'session/lease-lost', statusCode: 409, message: marker }), 'workspace/save-failed');
  Object.defineProperty(error, 'cause', { value: new Error(marker) });
  const result = safeErrorDiagnostic(error);
  assert.equal(result.category, 'runner/work-failed');
  assert.equal(result.primaryCategory, 'session/lease-lost');
  assert.equal(result.secondaryStage, 'workspace/save-failed');
  safe(result);
  safe(safeErrorDiagnostic(new RunnerWorkError(new Error(marker), marker)));
});

test('runner failure logging preserves propagation and safe primary/cleanup categories', async () => {
  const records: unknown[] = [];
  let active = true;
  const failure = new RunnerWorkError(new AppError({ code: 'session/cancelled', statusCode: 409, message: marker }), 'sandbox/cleanup-failed');
  await assert.rejects(runUntilStopped({ runOnce: async () => { active = false; throw failure; } } as unknown as SessionRunner, {
    shouldContinue: () => active, idlePollSeconds: 1,
    log: { info: () => {}, warn: () => {}, error: (details, message) => records.push({ details, message }) },
  }), (error) => error === failure);
  assert.equal(records.length, 1);
  safe(records);
  assert.ok(JSON.stringify(records).includes('session/cancelled'));
  assert.ok(JSON.stringify(records).includes('sandbox/cleanup-failed'));
});

test('actual HTTP/Pino boundary excludes SDK body, headers, causes and arbitrary details', async (t) => {
  const records: Record<string, unknown>[] = [];
  const app = Fastify({ logger: { stream: { write: (line: string) => records.push(JSON.parse(line)) } } });
  t.after(() => app.close()); registerErrorHandler(app);
  app.get('/provider', () => { throw Object.assign(new Error(marker, { cause: new Error(marker) }), {
    status: 503, headers: { authorization: marker }, response: { body: marker }, payload: marker,
  }); });
  const response = await app.inject('/provider');
  assert.equal(response.statusCode, 500);
  const logged = records.find((row) => row['msg'] === 'unhandled error')!;
  assert.deepEqual(logged['diagnostic'], { category: 'error/runtime', statusCode: 503, nestedCount: 1, nestedCategories: ['error/runtime'] });
  safe(records); assert.equal(response.body.includes(marker), false);
});

test('installed Anthropic SDK debug logging cannot bypass safe operational diagnostics', async () => {
  const records: unknown[] = [];
  const log = pino({ level: 'debug' }, { write: (line: string) => records.push(JSON.parse(line)) });
  const client = new Anthropic({ apiKey: marker, logLevel: 'debug', logger: safeProviderLogger(log, 'anthropic'), maxRetries: 0,
    fetch: async () => new Response(JSON.stringify({ error: { type: 'api_error', message: marker } }), { status: 500 }) });
  await assert.rejects(client.messages.countTokens({ model: 'fixture', messages: [{ role: 'user', content: marker }] }));
  assert.ok(records.length > 0);
  safe(records);
  assert.ok(JSON.stringify(records).includes('anthropic'));
});

test('Pino err serializer also protects framework-generated errors with nested payloads', () => {
  const records: Record<string, unknown>[] = [];
  const log = pino({ serializers: { err: safeErrorDiagnostic } }, { write: (line: string) => records.push(JSON.parse(line)) });
  log.error({ err: new AggregateError([Object.assign(new Error(marker), { response: { body: marker }, headers: { authorization: marker } })], marker) }, 'framework failure');
  assert.equal(records.length, 1);
  assert.deepEqual(records[0]!['err'], { category: 'error/aggregate', nestedCount: 1, nestedCategories: ['error/runtime'] });
  safe(records);
});
function safe(error: unknown): boolean {
  const rendered = [String(error), inspect(error, { depth: 8 }), JSON.stringify(error)].join('\n');
  assert.equal(rendered.includes(marker), false, 'Error contains a sensitive value');
  return true;
}

test('environment validators reject raw values without embedding them in errors or serialization', () => {
  const specs = {
    REDIS_URL: asUrl('Redis endpoint', { protocols: ['redis:', 'rediss:'] }),
    PORT: asPort('Listening port'),
    LIMIT: asInteger('Limit', { min: 1, max: 10 }),
    MODE: asEnum('Mode', ['test', 'production']),
    ENABLED: asBoolean('Enabled'),
    ORIGINS: asList('Origins', asUrl('Origin', { protocols: ['https:'] })),
  };
  assert.throws(() => loadEnv(specs, Object.fromEntries(Object.keys(specs).map((key) => [key, marker]))), (error) => {
    assert.ok(error instanceof EnvironmentError);
    for (const key of Object.keys(specs)) assert.ok(error.message.includes(key));
    return safe(error);
  });
  assert.throws(() => specs.REDIS_URL.parse(`${marker}://user:password@host/?token=secret#secret`), safe);
  assert.throws(() => specs.REDIS_URL.parse(`redis://user:${marker}@[invalid`), safe);
  assert.throws(() => specs.REDIS_URL.parse('not a url'), /expected an absolute URL/);
  assert.throws(() => specs.REDIS_URL.parse('https://example.test'), /expected protocol redis: or rediss:/);
  assert.equal(specs.REDIS_URL.parse('rediss://localhost:6379').protocol, 'rediss:');
});

test('both Firebase loaders reject malformed service-account input without copying values', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'lotus-safe-account-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, 'account.json');
  for (const load of [initialiseFirebase, initialiseFirebaseAuth]) {
    const config = { FIREBASE_SERVICE_ACCOUNT_FILE: path, FIREBASE_PROJECT_ID: 'expected-project' } as Config;
    assert.throws(() => load({ ...config, FIREBASE_SERVICE_ACCOUNT_FILE: marker + '\0' }), safe);
    writeFileSync(path, `{"private_key":"${marker}"`);
    assert.throws(() => load(config), safe);
    writeFileSync(path, JSON.stringify({ project_id: marker, client_email: 'fixture@example.test', private_key: marker }));
    assert.throws(() => load(config), (error) => {
      assert.ok(error instanceof EnvironmentError && error.message.includes('FIREBASE_PROJECT_ID'));
      return safe(error);
    });
  }
});

test('Redis authentication failures cannot copy AUTH arguments into callback or startup diagnostics', async (t) => {
  const failure = Object.assign(new Error(marker), { command: { name: 'auth', args: [marker] } });
  const logged: Error[] = [];
  t.mock.method(Redis.prototype, 'connect', async function (this: Redis) {
    this.emit('error', failure); throw failure;
  });
  await assert.rejects(connectRedis({ REDIS_URL: new URL(`redis://user:${marker}@localhost`) } as SharedConfig,
    (error) => logged.push(error), 'test'), (error) => {
    assert.ok(error instanceof EnvironmentError && error.message.includes('REDIS_URL'));
    return safe(error);
  });
  assert.equal(logged.length, 1);
  safe(logged[0]);
});

test('bucket configuration rejection does not copy the configured value or provider error', async (t) => {
  const app = initializeApp({ projectId: 'offline-test' }, 'secret-diagnostic-storage');
  t.after(() => deleteApp(app));
  let exists = false;
  t.mock.method(getStorage(app), 'bucket', () => ({ exists: async () => {
    if (!exists) return [false];
    throw new Error(marker);
  } }));
  const store = new SnapshotStore(app, marker, 60);
  await assert.rejects(store.assertReachable(), safe);
  exists = true;
  await assert.rejects(store.assertReachable(), safe);
});

test('Redis readiness failures and unexpected replies do not disclose server content', async (t) => {
  t.mock.method(Redis.prototype, 'connect', async () => {});
  const config = { REDIS_URL: new URL('redis://localhost') } as SharedConfig;
  const ping = t.mock.method(Redis.prototype, 'ping', async () => { throw new Error(marker); });
  await assert.rejects(connectRedis(config, () => {}, 'test'), safe);
  ping.mock.mockImplementation(async () => marker as never);
  await assert.rejects(connectRedis(config, () => {}, 'test'), safe);
});

test('malformed internal environment remains generic at the actual HTTP boundary and safe in logs', async (t) => {
  let logs = '';
  const app = Fastify({ logger: { stream: { write: (line: string) => { logs += line; } } } });
  t.after(() => app.close());
  registerErrorHandler(app);
  app.get('/failure', () => loadEnv({ REDIS_URL: asUrl('Redis', { protocols: ['redis:'] }) }, { REDIS_URL: marker }));
  const response = await app.inject('/failure');
  assert.equal(response.statusCode, 500);
  assert.equal(response.json().error.message, 'An unexpected error occurred.');
  assert.equal((response.body + logs).includes(marker), false, 'HTTP response or log contains a sensitive value');
});

test('actual Stripe signature rejection logs safe metadata without the SDK signature or payload', async (t) => {
  let logs = '';
  const app = Fastify({ logger: { stream: { write: (line: string) => { logs += line; } } } });
  t.after(() => app.close());
  app.decorate('requireAuth', async () => {});
  app.decorate('requireVerifiedEmail', async () => {});
  app.decorate('enforceRateLimit', () => async () => {});
  registerErrorHandler(app);
  registerBillingRoutes(app, {
    stripe: new Stripe('fixture-api-key'), webhookSecret: 'fixture-webhook-key', catalogueTtlMs: 1000,
  } as Parameters<typeof registerBillingRoutes>[1]);
  const response = await app.inject({ method: 'POST', url: '/webhooks/stripe',
    headers: { 'content-type': 'application/json', 'stripe-signature': marker }, payload: JSON.stringify({ secret: marker }) });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'billing/bad-signature');
  assert.ok(logs.includes('billing/bad-signature'));
  assert.equal((response.body + logs).includes(marker), false, 'Signature rejection copied sensitive input');
});

test('a Firestore error is reported by its gRPC status, and only a status can get through', () => {
  const marker = 'sk-live-marker-that-must-not-appear';
  // What Firestore threw for a query with no index: a plain Error carrying the status as a number.
  const missingIndex = Object.assign(new Error(`9 FAILED_PRECONDITION: The query requires an index. ${marker}`), { code: 9 });
  assert.deepEqual(safeErrorDiagnostic(missingIndex), { category: 'error/runtime', grpcCode: 9 });
  assert.equal(JSON.stringify(safeErrorDiagnostic(missingIndex)).includes(marker), false);

  // Anything that is not a whole number from 1 to 16 is not a status, so it is not repeated.
  for (const code of [0, 17, 9.5, -1, '9', marker, Number.NaN, null, { toString: () => marker }]) {
    assert.deepEqual(safeErrorDiagnostic(Object.assign(new Error(marker), { code })), { category: 'error/runtime' }, String(code));
  }
});
