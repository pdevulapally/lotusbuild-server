import { EnvironmentError, loadConfig } from './config/index.ts';
import { EntitlementService } from './entitlements/service.ts';
import { ConfigurationStore } from './entitlements/store.ts';
import { SubscriptionCache } from './entitlements/subscription-cache.ts';
import { MeteringService } from './metering/service.ts';
import { connectRedis } from './redis/client.ts';
import { initialiseFirebase } from './firebase.ts';
import { ProjectRepository } from './projects/repository.ts';
import { SessionEvents } from './sessions/events.ts';
import { SessionRepository } from './sessions/repository.ts';
import { UserRepository } from './users/repository.ts';
import { buildServer } from './server.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  // The event fan-out is constructed before the server that owns the logger, so
  // it starts on stderr and is handed the real one as soon as it exists. An
  // error reported in that gap must still be seen.
  let logError: (details: object, message: string) => void = (details, message) => {
    process.stderr.write(`${message}: ${JSON.stringify(details)}
`);
  };
  // Credentials are proven before the port opens: a process that cannot verify
  // a token must never accept a request it would have to reject.
  const firebase = initialiseFirebase(config);
  // Redis is proven before the port opens too: rate limiting fails closed, so a
  // process that cannot reach it would refuse every request it accepted.
  const redis = await connectRedis(
    config,
    (error) => {
      process.stderr.write(`redis: ${error.message}
`);
    },
    'lotusbuild-api',
  );

  const configuration = new ConfigurationStore(
    firebase.firestore,
    config.CONFIG_CACHE_TTL_SECONDS * 1000,
  );
  // Reading configuration now turns a malformed plan or a broken sandbox
  // allowance into a refusal to start, rather than into the first user's 500.
  await configuration.get();

  const entitlements = new EntitlementService(
    firebase.firestore,
    configuration,
    new SubscriptionCache(redis, config.SUBSCRIPTION_CACHE_TTL_SECONDS),
  );
  const users = new UserRepository(firebase.firestore);
  const projects = new ProjectRepository(firebase.firestore, users, entitlements);
  const metering = new MeteringService(firebase.firestore, configuration);

  // A connection in subscribe mode cannot run ordinary commands, so the event
  // stream needs its own. One for the whole process, not one per client.
  const subscriber = redis.duplicate({ connectionName: 'lotusbuild-api-events' });
  subscriber.on('error', (error: Error) => {
    process.stderr.write(`redis subscriber: ${error.message}
`);
  });
  await subscriber.connect();

  const app = buildServer(config, {
    firebaseAuth: firebase.auth,
    redis,
    entitlements,
    users,
    projects,
    sessions: new SessionRepository(
      firebase.firestore,
      projects,
      entitlements,
      configuration,
      metering,
      config.SESSION_LEASE_SECONDS,
    ),
    sessionEvents: new SessionEvents(redis, subscriber, {
      retentionSeconds: config.SESSION_EVENT_RETENTION_SECONDS,
      maxPerSession: config.SESSION_EVENT_MAX_PER_SESSION,
      onListenerError: (error, sessionId) => {
        logError({ err: error, sessionId }, 'session event delivery failed');
      },
    }),
  });
  logError = (details, message) => {
    app.log.error(details, message);
  };

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    // Closed after the server so in-flight requests keep their store.
    await Promise.all([redis.quit(), subscriber.quit()]);
    process.exit(0);
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }

  await app.listen({ host: config.HOST, port: config.PORT });
}

main().catch((error: unknown) => {
  // Configuration problems are operator errors, not crashes: report them
  // legibly rather than as a stack trace nobody reads.
  if (error instanceof EnvironmentError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  }
  process.exit(1);
});
