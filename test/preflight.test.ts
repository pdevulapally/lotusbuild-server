import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { App } from 'firebase-admin/app';
import type { Auth } from 'firebase-admin/auth';
import type { Firestore } from 'firebase-admin/firestore';
import type { Redis } from 'ioredis';

import { EnvironmentError } from '../src/config/env.ts';
import type { FirebaseServices } from '../src/firebase.ts';
import { type PreflightDependencies, runPreflight } from '../src/preflight.ts';
import { registryDocument, planDocuments } from '../src/seed/config.ts';

/**
 * Every variable `loadConfig` and `loadRunnerConfig` require, satisfying every
 * min/max/enum/format rule in `src/config/index.ts` — including
 * `RUNNER_HEARTBEAT_SECONDS < SESSION_LEASE_SECONDS`. Callers override only
 * what one test cares about, via `withEnv`.
 */
function validEnv(): Record<string, string> {
  return {
    NODE_ENV: 'test',
    SESSION_EVENT_MAX_BYTES: '65536',
    FAMILY_INVITATION_TTL_SECONDS: '3600',
    LOG_LEVEL: 'error',
    FIREBASE_PROJECT_ID: 'lotusbuild-test',
    FIREBASE_SERVICE_ACCOUNT_FILE: '/tmp/does-not-need-to-exist.json',
    CONFIG_CACHE_TTL_SECONDS: '60',
    REDIS_URL: 'redis://localhost:6379',
    SUBSCRIPTION_CACHE_TTL_SECONDS: '60',
    SESSION_LEASE_SECONDS: '60',
    SESSION_EVENT_RETENTION_SECONDS: '3600',
    SESSION_EVENT_MAX_PER_SESSION: '1000',
    FIREBASE_STORAGE_BUCKET: 'lotusbuild-test.appspot.com',
    SNAPSHOT_URL_TTL_SECONDS: '300',
    HOST: '127.0.0.1',
    PORT: '4100',
    PUBLIC_API_URL: 'https://api.example.test',
    SSE_HEARTBEAT_SECONDS: '15',
    SSE_MAX_CONNECTIONS: '100',
    SSE_MAX_CONNECTIONS_PER_USER: '4',
    SSE_BUFFER_MAX_BYTES: '65536',
    HTTP_MAX_REQUESTS_PER_MINUTE: '300',
    BREVO_API_KEY: 'brevo-api-key-fixture',
    EMAIL_VERIFICATION_FROM: 'verify@mail.example.test',
    EMAIL_VERIFICATION_CODE_SECRET: 'fixture-email-code-secret-at-least-32-characters',
    EMAIL_VERIFICATION_CODE_TTL_SECONDS: '600',
    EMAIL_VERIFICATION_RESEND_SECONDS: '60',
    EMAIL_VERIFICATION_MAX_ATTEMPTS: '5',
    EMAIL_VERIFICATION_MAX_CODES_PER_DAY: '10',
    EMAIL_DAILY_SEND_LIMIT: '300',
    DESKTOP_MAX_CONNECTIONS: '20',
    DESKTOP_MAX_CONNECTIONS_PER_USER: '2',
    DESKTOP_MAX_VIEWERS_PER_SESSION: '2',
    DESKTOP_STREAM_MAX_SECONDS: '600',
    DESKTOP_PING_SECONDS: '20',
    DESKTOP_BUFFER_MAX_BYTES: '1048576',
    DESKTOP_CLIENT_MAX_BYTES_PER_SECOND: '16384',
    // Deliberately not shaped like a real Stripe secret key or webhook
    // signing secret — CI's own secret scanner greps for those exact
    // prefixes, correctly, since it cannot tell a fixture from the real
    // thing. `asString` only requires non-empty, so a plainly-fake
    // placeholder proves the same thing without tripping it.
    STRIPE_SECRET_KEY: 'stripe-secret-key-fixture',
    STRIPE_WEBHOOK_SECRET: 'stripe-webhook-secret-fixture',
    STRIPE_EVENT_REPLAY_WINDOW_SECONDS: '86400',
    STRIPE_CHECKOUT_SUCCESS_URL: 'https://example.test/done',
    STRIPE_CHECKOUT_CANCEL_URL: 'https://example.test/cancelled',
    STRIPE_PORTAL_RETURN_URL: 'https://example.test/billing',
    CORS_ALLOWED_ORIGINS: 'https://example.test',
    ANTHROPIC_API_KEY: 'sk-ant-x',
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    ANTHROPIC_MAX_OUTPUT_TOKENS: '8000',
    AGENT_MESSAGE_HISTORY_LIMIT: '40',
    AGENT_MAX_STEPS: '30',
    AGENT_COMMAND_TIMEOUT_SECONDS: '120',
    AGENT_TOOL_OUTPUT_MAX_CHARS: '20000',
    AGENT_MAX_SPECIALIST_CONSULTATIONS: '4',
    AGENT_SPECIALIST_MAX_STEPS: '10',
    GIT_AUTHOR_NAME: 'LotusBuild',
    GIT_AUTHOR_EMAIL: 'build@example.test',
    E2B_API_KEY: 'e2b_x',
    E2B_DOMAIN: 'e2b.app',
    E2B_VALIDATE_API_KEY: 'false',
    PREVIEW_READY_TIMEOUT_SECONDS: '30',
    RUNNER_IDLE_POLL_SECONDS: '5',
    RUNNER_DRAIN_TIMEOUT_SECONDS: '90',
    RUNNER_HEARTBEAT_SECONDS: '10',
  };
}

function withEnv(overrides: Record<string, string | undefined>): Record<string, string | undefined> {
  return { ...validEnv(), ...overrides };
}

function fakeFirestore(): Firestore {
  return {
    doc: (path: string) => ({
      get: async () => {
        if (path !== 'config/registry') {
          throw new Error(`unexpected doc path in this fake: ${path}`);
        }
        return { exists: true, data: () => registryDocument };
      },
    }),
    collection: (path: string) => ({
      get: async () => {
        if (path !== 'plans') {
          throw new Error(`unexpected collection path in this fake: ${path}`);
        }
        return {
          docs: planDocuments.map((plan) => ({ id: plan.key, data: () => plan })),
        };
      },
    }),
  } as unknown as Firestore;
}

/** A Firestore that never resolves anything — proves it was never even asked. */
function untouchableFirestore(): Firestore {
  return {
    doc: () => {
      throw new Error('this run must never reach Firestore');
    },
    collection: () => {
      throw new Error('this run must never reach Firestore');
    },
  } as unknown as Firestore;
}

interface RedisCalls {
  connected: boolean;
  quit: number;
  writes: unknown[];
}

/** A Redis stub whose only real behaviour is remembering whether it was asked to write or quit. */
function fakeRedis(calls: RedisCalls, quitFails = false): Redis {
  const writeMethods = ['publish', 'subscribe', 'set', 'get', 'del', 'expire', 'incr', 'hset'];
  const target: Record<string, unknown> = {
    quit: async () => {
      calls.quit += 1;
      if (quitFails) {
        throw new Error('connection reset while closing');
      }
      return 'OK';
    },
  };
  for (const name of writeMethods) {
    target[name] = (...args: unknown[]) => {
      calls.writes.push([name, ...args]);
      throw new Error(`fakeRedis: unexpected call to ${name}`);
    };
  }
  return target as unknown as Redis;
}

function fakeFirebaseServices(firestore: Firestore = fakeFirestore()): FirebaseServices {
  return {
    app: {} as unknown as App,
    auth: {} as unknown as Auth,
    firestore,
  };
}

function baseDeps(overrides: Partial<PreflightDependencies> = {}): PreflightDependencies {
  const redisCalls: RedisCalls = { connected: false, quit: 0, writes: [] };
  return {
    env: validEnv(),
    assertReleaseCompatibility: () => {},
    initialiseFirebase: () => fakeFirebaseServices(),
    connectRedis: async () => {
      redisCalls.connected = true;
      return fakeRedis(redisCalls);
    },
    makeSnapshotStore: () => ({ assertReachable: async () => undefined }),
    ...overrides,
  };
}

/* -------------------------------------------------------------- config */

test('fully-valid API + runner env proceeds', async () => {
  const result = await runPreflight(baseDeps());
  assert.equal(result.ok, true);
});

test('runner drain budget is required and cannot encroach on the 30-second service-manager margin', async () => {
  for (const value of [undefined, '0', '91', 'not-a-number']) {
    const result = await runPreflight(baseDeps({ env: withEnv({ RUNNER_DRAIN_TIMEOUT_SECONDS: value }) }));
    assert.ok(!result.ok && result.stage === 'config' && result.problems.some((problem) => problem.includes('RUNNER_DRAIN_TIMEOUT_SECONDS')));
  }
});

test('malformed credential URL fails the actual config and preflight path without exposing values', async () => {
  const secrets = ['fixture-user-sensitive', 'fixture-password-sensitive', 'fixture-query-sensitive', 'fixture-fragment-sensitive'];
  const env = withEnv({ REDIS_URL: `redis://${secrets[0]}:${secrets[1]}@[invalid?token=${secrets[2]}#${secrets[3]}` });
  const result = await runPreflight(baseDeps({ env, initialiseFirebase: () => { throw new Error('Config failure must precede Firebase'); } }));
  assert.ok(!result.ok && result.stage === 'config');
  assert.ok(!result.ok && result.problems.some((problem) => problem.includes('REDIS_URL') && problem.includes('absolute URL')));
  for (const secret of secrets) assert.equal(JSON.stringify(result).includes(secret), false, 'Preflight diagnostic contains a sensitive value');
  // Exercise the real CLI renderer and both real startup error handlers, with an
  // isolated environment that fails before any external service is contacted.
  for (const entry of ['preflight.ts', 'index.ts', 'runner/index.ts']) {
    const child = spawnSync(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL(`../src/${entry}`, import.meta.url))], {
      env, encoding: 'utf8', timeout: 15000,
    });
    assert.equal(child.status, 1);
    assert.ok(child.stderr.includes('REDIS_URL'));
    for (const secret of secrets) assert.equal((child.stdout + child.stderr).includes(secret), false, 'Startup output contains a sensitive value');
  }
});

test('missing API-required env rejects', async () => {
  const deps = baseDeps({ env: withEnv({ STRIPE_SECRET_KEY: undefined }) });
  const result = await runPreflight(deps);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.stage === 'config');
  assert.ok(!result.ok && result.problems.some((p) => p.includes('STRIPE_SECRET_KEY')));
});

test('missing runner-required env rejects', async () => {
  const deps = baseDeps({ env: withEnv({ ANTHROPIC_API_KEY: undefined }) });
  const result = await runPreflight(deps);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.stage === 'config');
  assert.ok(!result.ok && result.problems.some((p) => p.includes('ANTHROPIC_API_KEY')));
});

test('multiple invalid env fields across both specs are reported together, without printing values', async () => {
  const deps = baseDeps({
    env: withEnv({
      PORT: 'not-a-port',
      STRIPE_SECRET_KEY: '   ',
      AGENT_MAX_STEPS: '0',
      E2B_API_KEY: 'super-secret-e2b-key-value',
      E2B_VALIDATE_API_KEY: 'maybe',
    }),
  });
  const result = await runPreflight(deps);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.stage === 'config');
  const problems = !result.ok ? result.problems : [];
  assert.ok(problems.some((p) => p.includes('PORT')));
  assert.ok(problems.some((p) => p.includes('STRIPE_SECRET_KEY')));
  assert.ok(problems.some((p) => p.includes('AGENT_MAX_STEPS')));
  assert.ok(problems.some((p) => p.includes('E2B_VALIDATE_API_KEY')));
  // A valid secret value is never echoed back, even for a field that did parse.
  assert.ok(!problems.some((p) => p.includes('super-secret-e2b-key-value')));
});

/* ------------------------------------------------------------- firebase */

test('Firebase initialization failure rejects', async () => {
  const deps = baseDeps({
    initialiseFirebase: () => {
      throw new EnvironmentError(['FIREBASE_SERVICE_ACCOUNT_FILE cannot be read at /tmp/x — ENOENT']);
    },
  });
  const result = await runPreflight(deps);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.stage === 'firebase');
});

test('a project/service-account mismatch rejects through the same behaviour', async () => {
  const deps = baseDeps({
    initialiseFirebase: () => {
      throw new EnvironmentError([
        'FIREBASE_SERVICE_ACCOUNT_FILE at /tmp/x belongs to project "other", but ' +
          'FIREBASE_PROJECT_ID is "lotusbuild-test".',
      ]);
    },
  });
  const result = await runPreflight(deps);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.stage === 'firebase');
  assert.ok(!result.ok && result.problems.some((p) => p.includes('belongs to project')));
});

/* --------------------------------------------------------------- redis */

test('Redis connect/auth succeeds → continues to the registry check', async () => {
  const result = await runPreflight(baseDeps());
  assert.equal(result.ok, true);
});

test('Redis unavailable rejects', async () => {
  const deps = baseDeps({
    connectRedis: async () => {
      throw new EnvironmentError(['REDIS_URL points at localhost:6379, which did not accept a connection']);
    },
  });
  const result = await runPreflight(deps);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.stage === 'redis');
});

test('Redis authentication failure rejects', async () => {
  const deps = baseDeps({
    connectRedis: async () => {
      throw new Error('NOAUTH Authentication required.');
    },
  });
  const result = await runPreflight(deps);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.stage === 'redis');
  assert.ok(!result.ok && result.problems.some((p) => p.includes('NOAUTH')));
});

test('the Redis client is closed after a successful preflight', async () => {
  const calls: RedisCalls = { connected: false, quit: 0, writes: [] };
  const deps = baseDeps({
    connectRedis: async () => fakeRedis(calls),
  });
  const result = await runPreflight(deps);
  assert.equal(result.ok, true);
  assert.equal(calls.quit, 1);
});

test('the Redis client is closed on a later registry failure, having already been opened', async () => {
  const calls: RedisCalls = { connected: false, quit: 0, writes: [] };
  const deps = baseDeps({
    connectRedis: async () => fakeRedis(calls),
    initialiseFirebase: () => fakeFirebaseServices(untouchableFirestore()),
  });
  // untouchableFirestore throws synchronously from .doc()/.collection(), which
  // ConfigurationStore.get() awaits and surfaces as a rejected promise.
  const result = await runPreflight(deps);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.stage === 'registry');
  assert.equal(calls.quit, 1);
});

test('a Redis close failure after an otherwise-successful preflight is reported, not silently dropped', async () => {
  const calls: RedisCalls = { connected: false, quit: 0, writes: [] };
  const deps = baseDeps({
    connectRedis: async () => fakeRedis(calls, true),
  });
  const result = await runPreflight(deps);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.stage === 'cleanup');
  assert.equal(calls.quit, 1);
});

test('a Redis close failure after a registry failure is appended, never displacing the real reason', async () => {
  const calls: RedisCalls = { connected: false, quit: 0, writes: [] };
  const deps = baseDeps({
    connectRedis: async () => fakeRedis(calls, true),
    initialiseFirebase: () => fakeFirebaseServices(untouchableFirestore()),
  });
  const result = await runPreflight(deps);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.stage === 'registry');
  assert.ok(!result.ok && result.problems.some((p) => p.includes('this run must never reach Firestore')));
  assert.ok(!result.ok && result.problems.some((p) => p.includes('closed cleanly')));
});

/* ------------------------------------------------------------ registry */

test('missing registry document rejects', async () => {
  const missingRegistry = {
    doc: (path: string) => ({
      get: async () => {
        if (path !== 'config/registry') {
          throw new Error(`unexpected doc path: ${path}`);
        }
        return { exists: false, data: () => undefined };
      },
    }),
    collection: () => ({ get: async () => ({ docs: [] }) }),
  } as unknown as Firestore;
  const deps = baseDeps({ initialiseFirebase: () => fakeFirebaseServices(missingRegistry) });
  const result = await runPreflight(deps);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.stage === 'registry');
  assert.ok(!result.ok && result.problems.some((p) => p.includes('has not been seeded')));
});

test('an old/malformed registry schema rejects', async () => {
  const oldShapeRegistry = {
    doc: (path: string) => ({
      get: async () => {
        if (path !== 'config/registry') {
          throw new Error(`unexpected doc path: ${path}`);
        }
        // Missing every required field, as an old-schema document would be.
        return { exists: true, data: () => ({}) };
      },
    }),
    collection: () => ({ get: async () => ({ docs: [] }) }),
  } as unknown as Firestore;
  const deps = baseDeps({ initialiseFirebase: () => fakeFirebaseServices(oldShapeRegistry) });
  const result = await runPreflight(deps);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.stage === 'registry');
});

test('an invalid plan rejects', async () => {
  const first = planDocuments[0];
  assert.ok(first !== undefined, 'fixture: planDocuments must not be empty');
  const badPlan = { ...first, key: 'mismatched-key' };
  const firestore = {
    doc: () => ({ get: async () => ({ exists: true, data: () => registryDocument }) }),
    collection: () => ({
      get: async () => ({ docs: [{ id: first.key, data: () => badPlan }] }),
    }),
  } as unknown as Firestore;
  const deps = baseDeps({ initialiseFirebase: () => fakeFirebaseServices(firestore) });
  const result = await runPreflight(deps);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.stage === 'registry');
  assert.ok(!result.ok && result.problems.some((p) => p.includes('disagree')));
});

test('an invalid cross-reference rejects', async () => {
  const brokenRegistry = { ...registryDocument, defaultPlanKey: 'no-such-plan' };
  const firestore = {
    doc: () => ({ get: async () => ({ exists: true, data: () => brokenRegistry }) }),
    collection: () => ({
      get: async () => ({ docs: planDocuments.map((plan) => ({ id: plan.key, data: () => plan })) }),
    }),
  } as unknown as Firestore;
  const deps = baseDeps({ initialiseFirebase: () => fakeFirebaseServices(firestore) });
  const result = await runPreflight(deps);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.stage === 'registry');
  assert.ok(!result.ok && result.problems.some((p) => p.includes('no-such-plan')));
});

test('a genuinely valid registry/plans succeeds', async () => {
  const result = await runPreflight(baseDeps());
  assert.equal(result.ok, true);
  assert.ok(result.ok && result.summary.plans === planDocuments.length);
  assert.ok(result.ok && result.summary.specialists === registryDocument.specialists.length);
});

/* -------------------------------------------------------------- storage */

test('an unreachable snapshot store rejects', async () => {
  const deps = baseDeps({
    makeSnapshotStore: () => ({
      assertReachable: async () => {
        throw new EnvironmentError(['FIREBASE_STORAGE_BUCKET "x" could not be reached']);
      },
    }),
  });
  const result = await runPreflight(deps);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.stage === 'storage');
});

test('a reachable snapshot store succeeds', async () => {
  let called = false;
  const deps = baseDeps({
    makeSnapshotStore: () => ({
      assertReachable: async () => {
        called = true;
      },
    }),
  });
  const result = await runPreflight(deps);
  assert.equal(result.ok, true);
  assert.equal(called, true);
});

/* ------------------------------------------------------- side effects */

test('no Firestore writes occur at any stage, including a successful run', async () => {
  let wroteSomething = false;
  const watchedFirestore = {
    doc: (path: string) => ({
      get: async () => {
        if (path !== 'config/registry') {
          throw new Error(`unexpected doc path: ${path}`);
        }
        return { exists: true, data: () => registryDocument };
      },
      set: () => {
        wroteSomething = true;
      },
      create: () => {
        wroteSomething = true;
      },
      update: () => {
        wroteSomething = true;
      },
    }),
    collection: (path: string) => ({
      get: async () => {
        if (path !== 'plans') {
          throw new Error(`unexpected collection path: ${path}`);
        }
        return { docs: planDocuments.map((plan) => ({ id: plan.key, data: () => plan })) };
      },
      doc: () => {
        wroteSomething = true;
        return { set: () => (wroteSomething = true) };
      },
    }),
    batch: () => {
      wroteSomething = true;
      return { set: () => undefined, commit: async () => undefined };
    },
    runTransaction: () => {
      wroteSomething = true;
    },
  } as unknown as Firestore;

  const deps = baseDeps({ initialiseFirebase: () => fakeFirebaseServices(watchedFirestore) });
  const result = await runPreflight(deps);
  assert.equal(result.ok, true);
  assert.equal(wroteSomething, false);
});

test('no Redis application mutation occurs — only PING-equivalent connect and quit are used', async () => {
  const calls: RedisCalls = { connected: false, quit: 0, writes: [] };
  const deps = baseDeps({ connectRedis: async () => fakeRedis(calls) });
  const result = await runPreflight(deps);
  assert.equal(result.ok, true);
  assert.deepEqual(calls.writes, []);
});

test('no API listener starts and no runner claim loop starts — preflight never imports those modules', async () => {
  const source = await import('node:fs/promises').then((fs) =>
    fs.readFile(new URL('../src/preflight.ts', import.meta.url), 'utf8'),
  );
  assert.ok(!source.includes("from './server.ts'"));
  assert.ok(!source.includes("from './runner/loop.ts'"));
  assert.ok(!source.includes('app.listen'));
  assert.ok(!source.includes('runUntilStopped'));
});

test('no sandbox is acquired/created, no Anthropic generation occurs, no Stripe API call occurs — proven by dependency shape', async () => {
  // runPreflight's own dependency contract has no sandbox, Anthropic or Stripe
  // client anywhere in it: nothing exists to call, by construction.
  const deps = baseDeps();
  const keys = Object.keys(deps).sort();
  assert.deepEqual(keys, ['assertReleaseCompatibility', 'connectRedis', 'env', 'initialiseFirebase', 'makeSnapshotStore']);
});

test('no seed/migration function is invoked', async () => {
  const source = await import('node:fs/promises').then((fs) =>
    fs.readFile(new URL('../src/preflight.ts', import.meta.url), 'utf8'),
  );
  assert.ok(!source.includes("from './seed/run.ts'"));
  assert.ok(!source.includes("from './migrations/"));
});

/* --------------------------------------------------------- diagnostics */

test('diagnostics contain no secret values', async () => {
  // Deliberately not shaped like a real Stripe/Anthropic/E2B credential — see
  // the comment on `validEnv`'s own fixtures for why: this is exactly the
  // kind of string CI's secret scanner is right to flag, fixture or not.
  const secretEnv = withEnv({
    STRIPE_SECRET_KEY: 'unique-stripe-value-should-never-appear',
    ANTHROPIC_API_KEY: 'unique-anthropic-value-should-never-appear',
    E2B_API_KEY: 'unique-e2b-value-should-never-appear',
    REDIS_URL: 'redis://:supersecretpassword@localhost:6379',
    PORT: 'not-a-port', // forces a config-stage failure, closest path to leaking a fellow value
  });
  const deps = baseDeps({ env: secretEnv });
  const result = await runPreflight(deps);
  assert.equal(result.ok, false);
  const text = !result.ok ? result.problems.join('\n') : '';
  for (const secret of [
    'unique-stripe-value-should-never-appear',
    'unique-anthropic-value-should-never-appear',
    'unique-e2b-value-should-never-appear',
    'supersecretpassword',
  ]) {
    assert.ok(!text.includes(secret), `diagnostic leaked a secret: ${secret}`);
  }
});

test('release protocol preflight rejects missing, malformed and future manifests before provider access', async (t) => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const { assertReleaseRecoveryProtocol, runnerRecoveryProtocol } = await import('../src/sessions/recovery-protocol.ts');
  const root = mkdtempSync(join(tmpdir(), 'lotus-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const url = pathToFileURL(root + '/');
  let providers = 0;
  const deps = baseDeps({ assertReleaseCompatibility: () => assertReleaseRecoveryProtocol(url),
    initialiseFirebase: () => { providers++; throw new Error('Must not initialize'); } });
  for (const contents of [undefined, '{private-invalid', '{}', 'null',
    JSON.stringify({ runnerRecoveryProtocol: runnerRecoveryProtocol() + 1 }),
    JSON.stringify({ runnerRecoveryProtocol: String(runnerRecoveryProtocol()) })]) {
    if (contents !== undefined) writeFileSync(join(root, 'release.json'), contents);
    const result = await runPreflight(deps);
    assert.deepEqual(result, { ok: false, stage: 'release', problems: ['release/recovery-protocol-incompatible'] });
  }
  assert.equal(providers, 0);
  writeFileSync(join(root, 'release.json'), JSON.stringify({ runnerRecoveryProtocol: runnerRecoveryProtocol() }));
  assertReleaseRecoveryProtocol(url);
});
