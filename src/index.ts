import { EnvironmentError, loadConfig } from './config/index.ts';
import { EntitlementService } from './entitlements/service.ts';
import { ConfigurationStore } from './entitlements/store.ts';
import { SubscriptionCache } from './entitlements/subscription-cache.ts';
import { connectRedis } from './redis/client.ts';
import { initialiseFirebase } from './firebase.ts';
import { ProjectRepository } from './projects/repository.ts';
import { UserRepository } from './users/repository.ts';
import { buildServer } from './server.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  // Credentials are proven before the port opens: a process that cannot verify
  // a token must never accept a request it would have to reject.
  const firebase = initialiseFirebase(config);
  // Redis is proven before the port opens too: rate limiting fails closed, so a
  // process that cannot reach it would refuse every request it accepted.
  const redis = await connectRedis(config, (error) => {
    process.stderr.write(`redis: ${error.message}
`);
  });

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
  const app = buildServer(config, {
    firebaseAuth: firebase.auth,
    redis,
    entitlements,
    users,
    projects: new ProjectRepository(firebase.firestore, users, entitlements),
  });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    // Closed after the server so in-flight requests keep their store.
    await redis.quit();
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
