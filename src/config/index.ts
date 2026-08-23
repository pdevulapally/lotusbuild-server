import {
  EnvironmentError,
  type LoadedEnv,
  asEnum,
  asInteger,
  asList,
  asPort,
  asString,
  asUrl,
  loadEnv,
} from './env.ts';

export { EnvironmentError } from './env.ts';

/**
 * Nothing reads `process.env` anywhere else, so these three objects are the
 * complete configuration surface.
 *
 * They are split by which process needs them. The API has no use for a model
 * key and the runner has no port to bind, and a single list would force each to
 * hold a secret it never uses — which is how a credential ends up somewhere it
 * had no reason to be.
 */
const sharedSpec = {
  NODE_ENV: asEnum('deployment mode', ['development', 'production', 'test']),
  LOG_LEVEL: asEnum('pino log level', ['trace', 'debug', 'info', 'warn', 'error', 'fatal']),
  FIREBASE_PROJECT_ID: asString('Firebase project this service authenticates against'),
  FIREBASE_SERVICE_ACCOUNT_FILE: asString(
    'absolute path to the Firebase service account JSON (keep it mode 600, never in the image)',
  ),
  CONFIG_CACHE_TTL_SECONDS: asInteger(
    'how long plan and capability configuration is held before re-reading Firestore',
    { min: 1, max: 3600 },
  ),
  REDIS_URL: asUrl('Redis holding rate-limit counters, cached subscriptions and session events', {
    protocols: ['redis:', 'rediss:'],
  }),
  SUBSCRIPTION_CACHE_TTL_SECONDS: asInteger(
    'how long a subscription lookup is cached before Firestore is read again',
    { min: 1, max: 3600 },
  ),
  SESSION_LEASE_SECONDS: asInteger(
    'how long a runner holds a build session without a heartbeat before another may take it',
    { min: 5, max: 3600 },
  ),
  SESSION_EVENT_RETENTION_SECONDS: asInteger(
    'how long after its last event a session log stays in Redis for reconnecting clients',
    { min: 60, max: 604800 },
  ),
  SESSION_EVENT_MAX_PER_SESSION: asInteger(
    'ceiling on events held per session, bounding what one runaway build can occupy in Redis',
    { min: 100, max: 100000 },
  ),
} as const;

const apiSpec = {
  HOST: asString('interface to bind (127.0.0.1 behind a reverse proxy, 0.0.0.0 otherwise)'),
  PORT: asPort('TCP port to listen on'),
  PUBLIC_API_URL: asUrl('externally reachable base URL of this API', {
    protocols: ['https:', 'http:'],
  }),
  SSE_HEARTBEAT_SECONDS: asInteger(
    'how often a comment is written down an idle event stream to keep proxies from closing it',
    { min: 5, max: 300 },
  ),
  SSE_MAX_CONNECTIONS: asInteger(
    'open event streams this process will hold at once',
    { min: 1, max: 10000 },
  ),
  CORS_ALLOWED_ORIGINS: asList(
    'browser origins permitted to call this API',
    asUrl('allowed origin', { protocols: ['https:', 'http:'] }),
  ),
} as const;

const runnerSpec = {
  ANTHROPIC_API_KEY: asString('key the agent calls the Anthropic API with'),
  ANTHROPIC_BASE_URL: asUrl('Anthropic API base URL', { protocols: ['https:'] }),
  ANTHROPIC_MAX_OUTPUT_TOKENS: asInteger(
    'output token ceiling for one model call, which is also the most a single call can overspend',
    { min: 256, max: 200000 },
  ),
  AGENT_MESSAGE_HISTORY_LIMIT: asInteger(
    'how many past messages of a session are replayed to the model, bounding one turn of context',
    { min: 2, max: 500 },
  ),
  AGENT_MAX_STEPS: asInteger(
    'model calls one turn may take before the runner stops it, bounding a loop that never converges',
    { min: 1, max: 200 },
  ),
  AGENT_COMMAND_TIMEOUT_SECONDS: asInteger(
    'how long one shell command in a sandbox may run before it is cut off',
    { min: 5, max: 3600 },
  ),
  AGENT_TOOL_OUTPUT_MAX_CHARS: asInteger(
    'how much of a tool result is fed back to the model before it is truncated',
    { min: 500, max: 200000 },
  ),
  E2B_API_KEY: asString('key sandboxes are created with'),
  E2B_DOMAIN: asString('E2B domain to reach (e2b.app unless self-hosted)'),
  PREVIEW_READY_TIMEOUT_SECONDS: asInteger(
    'how long to wait for a dev server to answer on its port before calling the preview failed',
    { min: 5, max: 600 },
  ),
  RUNNER_IDLE_POLL_SECONDS: asInteger(
    'how long the runner waits before looking for work again when there was none',
    { min: 1, max: 300 },
  ),
  RUNNER_HEARTBEAT_SECONDS: asInteger(
    'how often the runner renews its lease while working; must be well under SESSION_LEASE_SECONDS',
    { min: 1, max: 600 },
  ),
} as const;

/** What both processes need, and all that the shared plumbing may depend on. */
export type SharedConfig = LoadedEnv<typeof sharedSpec>;
export type Config = ReturnType<typeof loadConfig>;
export type RunnerConfig = ReturnType<typeof loadRunnerConfig>;

export function loadConfig(source: Readonly<Record<string, string | undefined>> = process.env) {
  return loadEnv({ ...sharedSpec, ...apiSpec }, source);
}

export function loadRunnerConfig(
  source: Readonly<Record<string, string | undefined>> = process.env,
) {
  const config = loadEnv({ ...sharedSpec, ...runnerSpec }, source);
  if (config.RUNNER_HEARTBEAT_SECONDS >= config.SESSION_LEASE_SECONDS) {
    // Otherwise the lease expires between beats and another runner takes a
    // session that is still being worked on — two agents, one transcript.
    throw new EnvironmentError([
      `RUNNER_HEARTBEAT_SECONDS (${config.RUNNER_HEARTBEAT_SECONDS}) must be below ` +
        `SESSION_LEASE_SECONDS (${config.SESSION_LEASE_SECONDS}), or a lease expires while its ` +
        'runner is still working.',
    ]);
  }
  return config;
}
