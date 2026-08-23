import { hostname } from 'node:os';

import Anthropic from '@anthropic-ai/sdk';
import pino from 'pino';

import { EnvironmentError, loadRunnerConfig } from '../config/index.ts';
import { EntitlementService } from '../entitlements/service.ts';
import { ConfigurationStore } from '../entitlements/store.ts';
import { SubscriptionCache } from '../entitlements/subscription-cache.ts';
import { initialiseFirebase } from '../firebase.ts';
import { MeteringService } from '../metering/service.ts';
import { ProjectRepository } from '../projects/repository.ts';
import { connectRedis } from '../redis/client.ts';
import { E2BAdapter } from '../sandboxes/e2b.ts';
import type { SandboxAdapter } from '../sandboxes/provider.ts';
import { SandboxService } from '../sandboxes/service.ts';
import { SessionEvents } from '../sessions/events.ts';
import { SessionRepository } from '../sessions/repository.ts';
import { UserRepository } from '../users/repository.ts';
import { SessionRunner, runUntilStopped } from './loop.ts';

/**
 * The build runner.
 *
 * A separate process from the API on purpose: an agent turn holds a sandbox for
 * minutes and streams a model for as long as it takes, and none of that belongs
 * in the event loop answering HTTP requests. They share Firestore, Redis and
 * every repository — the split is operational, not architectural.
 */
async function main(): Promise<void> {
  const config = loadRunnerConfig();
  const log = pino({ level: config.LOG_LEVEL });

  // Derived rather than configured: two runners on one box must not share an
  // identity, and a restarted process must not inherit the lease its predecessor
  // held. Both fall out of the pid.
  const runnerId = `${hostname()}:${process.pid}`;

  const firebase = initialiseFirebase(config);
  const redis = await connectRedis(
    config,
    (error) => {
      log.error({ err: error }, 'redis');
    },
    runnerId,
  );
  const subscriber = redis.duplicate({ connectionName: `${runnerId}-events` });
  subscriber.on('error', (error: Error) => {
    log.error({ err: error }, 'redis subscriber');
  });
  await subscriber.connect();

  const configuration = new ConfigurationStore(
    firebase.firestore,
    config.CONFIG_CACHE_TTL_SECONDS * 1000,
  );
  // Proven before any work is claimed, so a broken plan is a refusal to start
  // rather than a session that fails the moment it is picked up.
  await configuration.get();

  const entitlements = new EntitlementService(
    firebase.firestore,
    configuration,
    new SubscriptionCache(redis, config.SUBSCRIPTION_CACHE_TTL_SECONDS),
  );
  const users = new UserRepository(firebase.firestore);
  const projects = new ProjectRepository(firebase.firestore, users, entitlements);
  const metering = new MeteringService(firebase.firestore, configuration);

  // Which provider serves which platform is in the registry; this map is only
  // what this deployment is able to start. A platform pointing at something
  // absent fails loudly when a build asks for it, never silently elsewhere.
  const adapters = new Map<string, SandboxAdapter>([
    ['e2b', new E2BAdapter(config.E2B_API_KEY, config.E2B_DOMAIN)],
  ]);

  const runner = new SessionRunner({
    runnerId,
    anthropic: new Anthropic({
      apiKey: config.ANTHROPIC_API_KEY,
      baseURL: config.ANTHROPIC_BASE_URL.toString(),
    }),
    sessions: new SessionRepository(
      firebase.firestore,
      projects,
      entitlements,
      configuration,
      metering,
      config.SESSION_LEASE_SECONDS,
    ),
    projects,
    entitlements,
    configuration,
    metering,
    sandboxes: new SandboxService(configuration, metering, adapters),
    events: new SessionEvents(redis, subscriber, {
      retentionSeconds: config.SESSION_EVENT_RETENTION_SECONDS,
      maxPerSession: config.SESSION_EVENT_MAX_PER_SESSION,
      onListenerError: (error, sessionId) => {
        log.error({ err: error, sessionId }, 'session event delivery failed');
      },
    }),
    limits: {
      maxSteps: config.AGENT_MAX_STEPS,
      maxOutputTokens: config.ANTHROPIC_MAX_OUTPUT_TOKENS,
      toolOutputMaxChars: config.AGENT_TOOL_OUTPUT_MAX_CHARS,
      commandTimeoutMs: config.AGENT_COMMAND_TIMEOUT_SECONDS * 1000,
      previewReadyTimeoutSeconds: config.PREVIEW_READY_TIMEOUT_SECONDS,
    },
    heartbeatSeconds: config.RUNNER_HEARTBEAT_SECONDS,
    // A turn reads the whole conversation so far. Bounded by the same ceiling
    // that bounds a message listing, so one enormous session cannot be loaded
    // into memory in full.
    messageHistoryLimit: config.AGENT_MESSAGE_HISTORY_LIMIT,
    log,
  });

  // A signal stops us taking new work. The session in hand is finished first —
  // killing it would leave a sandbox running and a lease to wait out.
  let running = true;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      log.info({ signal }, 'finishing the current session, then stopping');
      running = false;
    });
  }

  log.info({ runnerId }, 'runner started');
  await runUntilStopped(runner, {
    idlePollSeconds: config.RUNNER_IDLE_POLL_SECONDS,
    shouldContinue: () => running,
    log,
  });

  await Promise.all([redis.quit(), subscriber.quit()]);
  log.info({ runnerId }, 'runner stopped');
}

main().catch((error: unknown) => {
  if (error instanceof EnvironmentError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  }
  process.exit(1);
});
