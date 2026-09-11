import type { App } from 'firebase-admin/app';
import type { Redis } from 'ioredis';
import { fileURLToPath } from 'node:url';

import { EnvironmentError, type Config, type SharedConfig, loadConfig, loadRunnerConfig } from './config/index.ts';
import { type Configuration, ConfigurationStore } from './entitlements/store.ts';
import { type FirebaseServices, initialiseFirebase } from './firebase.ts';
import { connectRedis } from './redis/client.ts';
import { SnapshotStore } from './storage/snapshots.ts';
import { assertReleaseRecoveryProtocol } from './sessions/recovery-protocol.ts';

/**
 * Proves a candidate build is compatible with the environment/configuration it
 * is given — without ever starting the API or the runner.
 *
 * Reuses exactly the checks `src/index.ts` and `src/runner/index.ts` already
 * run before they open a port or claim a session: loading config, initialising
 * Firebase, connecting Redis, and reading the Firestore registry through
 * `ConfigurationStore`. None of that is reimplemented here — this module only
 * sequences those calls and reports which one, if any, failed. Run today it
 * proves nothing more than those two processes already prove at their own
 * boot; the difference is *when* it runs — before a deploy disturbs the
 * currently-running version, not after.
 */

/** Which stage first found the candidate incompatible. */
export type PreflightStage = 'config' | 'release' | 'firebase' | 'redis' | 'registry' | 'storage' | 'cleanup';

export interface PreflightSuccess {
  readonly ok: true;
  readonly summary: {
    readonly capabilities: number;
    readonly meters: number;
    readonly sandboxProviders: number;
    readonly specialists: number;
    readonly plans: number;
  };
}

export interface PreflightFailure {
  readonly ok: false;
  readonly stage: PreflightStage;
  /** Operator-readable. Never a secret value — see `problemsOf`. */
  readonly problems: readonly string[];
}

export type PreflightResult = PreflightSuccess | PreflightFailure;

export interface PreflightDependencies {
  readonly assertReleaseCompatibility: () => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly initialiseFirebase: typeof initialiseFirebase;
  readonly connectRedis: typeof connectRedis;
  /**
   * `SnapshotStore` reaches Google Cloud Storage through `getStorage(app)`,
   * which requires a genuinely registered Firebase `App` — a fake one throws
   * at the SDK boundary, not at ours. Factored out so a test can substitute a
   * fake reachability check without needing a real Firebase project to
   * register an app against.
   */
  readonly makeSnapshotStore: (
    app: App,
    bucketName: string,
    ttlSeconds: number,
  ) => Pick<SnapshotStore, 'assertReachable'>;
}

/**
 * Only the messages these functions were written to produce for an operator.
 * `EnvironmentError.problems` is already a list of exactly that; anything else
 * collapses to its own `.message` (or, failing that, `String(error)`). Every
 * function this is called against — `initialiseFirebase`, `connectRedis`,
 * `ConfigurationStore.get`, `SnapshotStore.assertReachable` — was already
 * audited to never interpolate a secret value into its error text, so nothing
 * here needs its own redaction.
 */
function problemsOf(error: unknown): readonly string[] {
  if (error instanceof EnvironmentError) {
    return error.problems;
  }
  if (error instanceof Error) {
    return [error.message];
  }
  return [String(error)];
}

/**
 * Both the API's and the runner's environment requirements, since production
 * runs them from one shared `.env` — a candidate that only satisfies one of
 * the two would boot one process and crash-loop the other. Both loaders run
 * even when the first fails, so an operator sees every missing/invalid
 * variable in one pass rather than fixing them one restart at a time.
 *
 * Only `EnvironmentError` is treated as "the candidate is incompatible" here.
 * `loadEnv` has exactly one throw path (see `src/config/env.ts`) and it is
 * this one; anything else escaping a pure parsing function is a bug in this
 * process, not a fact about the candidate, and is left to crash `main` loudly
 * rather than being reported as though an operator could fix it by editing
 * `.env`.
 */
function loadBothConfigs(
  env: Readonly<Record<string, string | undefined>>,
): { readonly ok: true; readonly apiConfig: Config } | { readonly ok: false; readonly problems: readonly string[] } {
  const problems: string[] = [];
  let apiConfig: Config | undefined;

  try {
    apiConfig = loadConfig(env);
  } catch (error) {
    if (!(error instanceof EnvironmentError)) {
      throw error;
    }
    problems.push(...error.problems);
  }

  try {
    loadRunnerConfig(env);
  } catch (error) {
    if (!(error instanceof EnvironmentError)) {
      throw error;
    }
    problems.push(...error.problems);
  }

  if (problems.length > 0 || apiConfig === undefined) {
    return { ok: false, problems };
  }
  return { ok: true, apiConfig };
}

/**
 * Closes the Redis connection this run opened, if it opened one.
 *
 * Returns a problem description rather than throwing: cleanup runs after the
 * outcome is already decided, and `finish` below folds a failure here into
 * that outcome truthfully — displacing a successful result, but never a
 * failure that was already the real reason this run rejected the candidate.
 */
async function closeRedis(redis: Redis | undefined): Promise<string | undefined> {
  if (redis === undefined) {
    return undefined;
  }
  try {
    await redis.quit();
    return undefined;
  } catch (error) {
    return `the Redis connection could not be closed cleanly — ${problemsOf(error).join('; ')}`;
  }
}

/**
 * Closes whatever Redis connection this run opened, then returns the run's
 * outcome — folding in a cleanup failure rather than losing it: displacing a
 * success (nothing else failed, so an unclean shutdown is the reason this run
 * cannot claim to be compatible), or appended alongside an existing failure
 * (which stays the reported reason).
 */
async function finish(outcome: PreflightResult, redis: Redis | undefined): Promise<PreflightResult> {
  const cleanupProblem = await closeRedis(redis);
  if (cleanupProblem === undefined) {
    return outcome;
  }
  if (outcome.ok) {
    return { ok: false, stage: 'cleanup', problems: [cleanupProblem] };
  }
  return { ok: false, stage: outcome.stage, problems: [...outcome.problems, cleanupProblem] };
}

/**
 * Runs every check, in the order a deploy needs them proven, and returns
 * without ever binding a port, claiming a session, acquiring a sandbox, or
 * writing to Firestore/Redis. Stops at the first incompatible stage — a
 * candidate whose config does not even parse gains nothing from also being
 * told its registry is unreachable.
 */
export async function runPreflight(deps: PreflightDependencies): Promise<PreflightResult> {
  const configResult = loadBothConfigs(deps.env);
  if (!configResult.ok) {
    return { ok: false, stage: 'config', problems: configResult.problems };
  }
  try { deps.assertReleaseCompatibility(); }
  catch { return { ok: false, stage: 'release', problems: ['release/recovery-protocol-incompatible'] }; }
  // `Config` (API) carries every field `SharedConfig` does, plus the API's
  // own — structurally a superset, so it satisfies `SharedConfig` directly.
  // `loadRunnerConfig` succeeded too (checked above) and parses the identical
  // shared fields from the identical source, so either config's shared half
  // would do; this just picks one.
  const shared: SharedConfig = configResult.apiConfig;

  let firebase: FirebaseServices;
  try {
    firebase = deps.initialiseFirebase(shared);
  } catch (error) {
    return { ok: false, stage: 'firebase', problems: problemsOf(error) };
  }

  let redis: Redis | undefined;
  try {
    redis = await deps.connectRedis(
      shared,
      (error) => {
        // A reconnect blip after a successful PING, in the brief window
        // before this run closes the connection. Reported, not fatal:
        // nothing here depends on the connection surviving past `finish`.
        process.stderr.write(`redis: ${error.message}\n`);
      },
      'lotusbuild-preflight',
    );
  } catch (error) {
    return { ok: false, stage: 'redis', problems: problemsOf(error) };
  }

  let configuration: Configuration;
  try {
    configuration = await new ConfigurationStore(
      firebase.firestore,
      shared.CONFIG_CACHE_TTL_SECONDS * 1000,
    ).get();
  } catch (error) {
    return finish({ ok: false, stage: 'registry', problems: problemsOf(error) }, redis);
  }

  try {
    await deps
      .makeSnapshotStore(firebase.app, shared.FIREBASE_STORAGE_BUCKET, shared.SNAPSHOT_URL_TTL_SECONDS)
      .assertReachable();
  } catch (error) {
    return finish({ ok: false, stage: 'storage', problems: problemsOf(error) }, redis);
  }

  return finish(
    {
      ok: true,
      summary: {
        capabilities: configuration.registry.capabilities.size,
        meters: configuration.registry.meters.size,
        sandboxProviders: configuration.registry.sandboxProviders.size,
        specialists: configuration.registry.specialists.size,
        plans: configuration.plans.size,
      },
    },
    redis,
  );
}

function printResult(result: PreflightResult): void {
  if (result.ok) {
    const s = result.summary;
    process.stdout.write(
      [
        'LotusBuild compatibility preflight passed',
        `registry: valid (${s.capabilities} capabilities, ${s.meters} meters, ` +
          `${s.sandboxProviders} sandbox providers, ${s.specialists} specialists)`,
        `plans: ${s.plans}`,
        'redis: reachable',
        'snapshot storage: reachable',
        '',
      ].join('\n'),
    );
    return;
  }
  process.stderr.write(
    [
      `LotusBuild compatibility preflight failed at stage "${result.stage}":`,
      ...result.problems.map((problem) => `  - ${problem}`),
      '',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const result = await runPreflight({
    assertReleaseCompatibility: assertReleaseRecoveryProtocol,
    env: process.env,
    initialiseFirebase,
    connectRedis,
    makeSnapshotStore: (app, bucketName, ttlSeconds) => new SnapshotStore(app, bucketName, ttlSeconds),
  });
  printResult(result);
  process.exitCode = result.ok ? 0 : 1;
}

// Guarded so importing this module — as the test suite does, to exercise
// `runPreflight` directly against fakes — never also runs `main` against the
// real process environment. Only running `node .../preflight.ts` (or the
// built `dist/preflight.js`) directly satisfies this.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  });
}
