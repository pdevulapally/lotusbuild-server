import { ProjectFiles } from './projects/files.ts';
import { safeErrorDiagnostic } from './http/errors.ts';
import { BillingRepository } from './billing/repository.ts';
import { createStripe } from './billing/stripe.ts';
import { EnvironmentError, loadConfig } from './config/index.ts';
import { EntitlementService } from './entitlements/service.ts';
import { ConfigurationStore } from './entitlements/store.ts';
import { SubscriptionCache } from './entitlements/subscription-cache.ts';
import { MeteringService } from './metering/service.ts';
import { connectRedis, redisKeyPrefixes } from './redis/client.ts';
import { initialiseFirebase } from './firebase.ts';
import { ProjectRepository } from './projects/repository.ts';
import { SessionEvents } from './sessions/events.ts';
import { SessionRepository } from './sessions/repository.ts';
import { UserRepository } from './users/repository.ts';
import { AttachmentStore } from './attachments/store.ts';
import { SkillRepository } from './skills/repository.ts';
import { SnapshotStore } from './storage/snapshots.ts';
import { buildServer } from './server.ts';
import { PrivacyRequests } from './privacy/requests.ts';
import { FamilyService } from './family/service.ts';
import { releaseRevision } from './release.ts';
import { BrevoEmailSender } from './email/brevo.ts';
import { EmailVerificationService } from './auth/email-verification.ts';
import { keyringFromEnv } from './connections/credentials.ts';
import { ConnectionRepository } from './connections/service.ts';


async function main(): Promise<void> {
  const config = loadConfig();
  // Read once at boot: it cannot change under a running process, and an unusable
  // release file should stop the start rather than surface on the first probe.
  const revision = releaseRevision();
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
      process.stderr.write(JSON.stringify({ diagnostic: safeErrorDiagnostic(error), provider: 'redis' }) + '\n');
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

  const subscriptionCache = new SubscriptionCache(redis, config.SUBSCRIPTION_CACHE_TTL_SECONDS);
  const entitlements = new EntitlementService(
    firebase.firestore,
    configuration,
    subscriptionCache,
  );
  const snapshots = new SnapshotStore(
    firebase.app,
    config.FIREBASE_STORAGE_BUCKET,
    config.SNAPSHOT_URL_TTL_SECONDS,
  );
  const users = new UserRepository(firebase.firestore);
  // Integrations stay dormant (503 configuration_required) until at least one
  // CONNECTION_KEK_V<n> is present; the key values are never logged.
  const connectionKeyring = keyringFromEnv(process.env);
  const metering = new MeteringService(firebase.firestore, configuration);
  const projects = new ProjectRepository(
    firebase.firestore,
    users,
    entitlements,
    metering,
    configuration,
    snapshots,
    async (id) => { await redis.del(`${redisKeyPrefixes.sessionEvents}${id}`); },
  );


  // A connection in subscribe mode cannot run ordinary commands, so the event
  // stream needs its own. One for the whole process, not one per client.
  const subscriber = redis.duplicate({ connectionName: 'lotusbuild-api-events' });
  subscriber.on('error', () => {
    process.stderr.write('REDIS_URL subscriber connection error.\n');
  });
  try { await subscriber.connect(); }
  catch { throw new EnvironmentError(['REDIS_URL subscriber connection failed.']); }

  const app = buildServer(config, {
    projectFiles: new ProjectFiles(snapshots),
    ...(connectionKeyring === undefined ? {} : { connections: new ConnectionRepository(firebase.firestore, connectionKeyring) }),
    attachments: new AttachmentStore(firebase.app, config.FIREBASE_STORAGE_BUCKET),
    skills: new SkillRepository(firebase.firestore, entitlements),
    privacyRequests: new PrivacyRequests(firebase.firestore),
    family: new FamilyService(firebase.firestore, config.FAMILY_INVITATION_TTL_SECONDS),
    firebaseAuth: firebase.auth,
    emailVerification: new EmailVerificationService(
      redis,
      firebase.auth,
      new BrevoEmailSender(config.BREVO_API_KEY, config.EMAIL_VERIFICATION_FROM),
      {
        codeSecret: config.EMAIL_VERIFICATION_CODE_SECRET,
        ttlSeconds: config.EMAIL_VERIFICATION_CODE_TTL_SECONDS,
        resendSeconds: config.EMAIL_VERIFICATION_RESEND_SECONDS,
        maxAttempts: config.EMAIL_VERIFICATION_MAX_ATTEMPTS,
        perAccountDailyLimit: config.EMAIL_VERIFICATION_MAX_CODES_PER_DAY,
        dailyLimit: config.EMAIL_DAILY_SEND_LIMIT,
      },
    ),
    ...(revision === undefined ? {} : { revision }),
    redis,
    entitlements,
    metering,
    users,
    projects,
    configuration,

    stripe: createStripe(config.STRIPE_SECRET_KEY),
    billing: new BillingRepository(
      firebase.firestore,
      subscriptionCache,
      config.STRIPE_EVENT_REPLAY_WINDOW_SECONDS,
    ),
    sessions: new SessionRepository(
      firebase.firestore,
      projects,
      entitlements,
      configuration,
      metering,
      config.SESSION_LEASE_SECONDS,
    ),
    sessionEvents: new SessionEvents(redis, subscriber, {
      firestore: firebase.firestore,
      maxEventBytes: config.SESSION_EVENT_MAX_BYTES,
      retentionSeconds: config.SESSION_EVENT_RETENTION_SECONDS,
      maxPerSession: config.SESSION_EVENT_MAX_PER_SESSION,
      onListenerError: (error, sessionId) => {
        logError({ diagnostic: safeErrorDiagnostic(error), sessionId }, 'session event delivery failed');
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
  process.stderr.write(JSON.stringify({ diagnostic: safeErrorDiagnostic(error), operation: 'process-failure' }) + '\n');
  process.exit(1);
});
