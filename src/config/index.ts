import {
  EnvironmentError,
  type LoadedEnv,
  asBoolean,
  asEnum,
  asInteger,
  asList,
  asPort,
  asString,
  asUrl,
  loadEnv,
  asOptional,
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
  SESSION_EVENT_MAX_BYTES: asInteger('maximum serialized live event bytes', { min: 1024, max: 1048576 }),
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
    'how long progress events remain available for reconnecting clients',
    { min: 60, max: 604800 },
  ),
  SESSION_EVENT_MAX_PER_SESSION: asInteger(
    'ceiling on durable progress events held per session',
    { min: 100, max: 100000 },
  ),
  FIREBASE_STORAGE_BUCKET: asString('bucket holding the saved git repository for every project'),
  SNAPSHOT_URL_TTL_SECONDS: asInteger(
    'how long a signed upload or download URL for a project snapshot stays valid',
    { min: 60, max: 3600 },
  ),
} as const;


const apiSpec = {
  FAMILY_INVITATION_TTL_SECONDS: asInteger('lifetime of a one-use parent linking invitation', { min: 60, max: 86400 }),
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
  SSE_MAX_CONNECTIONS_PER_USER: asInteger('maximum simultaneous event streams per account per API process', { min: 1, max: 100 }),
  SSE_BUFFER_MAX_BYTES: asInteger('maximum buffered event bytes per connection', { min: 1024, max: 1048576 }),
  HTTP_MAX_REQUESTS_PER_MINUTE: asInteger('pre-authentication requests per client IP per minute', { min: 1, max: 100000 }),
  BREVO_API_KEY: asString('Brevo API key used only by the API to send transactional email', { minLength: 10 }),
  EMAIL_VERIFICATION_FROM: asString('verified sender address for email verification codes'),
  EMAIL_VERIFICATION_CODE_SECRET: asString('server-only HMAC secret for email verification codes', { minLength: 32 }),
  EMAIL_VERIFICATION_CODE_TTL_SECONDS: asInteger('lifetime of a one-use email verification code', { min: 300, max: 1800 }),
  EMAIL_VERIFICATION_RESEND_SECONDS: asInteger('minimum delay before another verification email', { min: 30, max: 300 }),
  EMAIL_VERIFICATION_MAX_ATTEMPTS: asInteger('wrong code attempts allowed before a code is invalidated', { min: 3, max: 10 }),
  EMAIL_VERIFICATION_MAX_CODES_PER_DAY: asInteger(
    'maximum verification codes that can be sent to one account per UTC day',
    { min: 3, max: 50 },
  ),
  EMAIL_DAILY_SEND_LIMIT: asInteger(
    'maximum verification emails per UTC day across all accounts; Brevo free plan allows 300 per day for the whole Brevo account, so configure at 300 or less',
    { min: 1, max: 100000 },
  ),
  STRIPE_SECRET_KEY: asString('Stripe secret key this service bills with'),
  STRIPE_WEBHOOK_SECRET: asString('signing secret for the Stripe webhook endpoint'),
  STRIPE_EVENT_REPLAY_WINDOW_SECONDS: asInteger(
    'how long a handled Stripe event id is remembered so a redelivery is not applied twice',
    { min: 3600, max: 604800 },
  ),
  STRIPE_CHECKOUT_SUCCESS_URL: asUrl('where Stripe returns a customer who completed checkout', {
    protocols: ['https:', 'http:'],
  }),
  STRIPE_CHECKOUT_CANCEL_URL: asUrl('where Stripe returns a customer who abandoned checkout', {
    protocols: ['https:', 'http:'],
  }),
  STRIPE_PORTAL_RETURN_URL: asUrl('where the Stripe billing portal returns a customer', {
    protocols: ['https:', 'http:'],
  }),
  DESKTOP_MAX_CONNECTIONS: asInteger('relayed desktop streams this process will hold at once', { min: 1, max: 1000 }),
  DESKTOP_MAX_CONNECTIONS_PER_USER: asInteger('relayed desktop streams one account may hold at once per API process', { min: 1, max: 20 }),
  DESKTOP_MAX_VIEWERS_PER_SESSION: asInteger('relayed desktop streams one session may have at once', { min: 1, max: 10 }),
  DESKTOP_STREAM_MAX_SECONDS: asInteger('hard lifetime of one relayed desktop socket before the client must fetch a new ticket', { min: 30, max: 3600 }),
  DESKTOP_PING_SECONDS: asInteger('how often a relayed desktop socket is pinged; a peer that never answers is dropped', { min: 5, max: 120 }),
  DESKTOP_BUFFER_MAX_BYTES: asInteger('maximum bytes queued for a slow desktop viewer before it is dropped', { min: 65536, max: 16777216 }),
  DESKTOP_CLIENT_MAX_BYTES_PER_SECOND: asInteger('most a view-only desktop viewer may send per second before it is dropped', { min: 1024, max: 1048576 }),
  E2B_DOMAIN: asString('E2B domain a desktop host must belong to before the relay connects to it'),
  CORS_ALLOWED_ORIGINS: asList(
    'browser origins permitted to call this API',
    asUrl('allowed origin', { protocols: ['https:', 'http:'] }),
  ),
} as const;

const runnerSpec = {
  RUNNER_DRAIN_TIMEOUT_SECONDS: asInteger(
    'maximum total runner shutdown drain; LotusBuild policy is 90s with a 120s systemd stop budget',
    { min: 1, max: 90 },
  ),
  ANTHROPIC_API_KEY: asString('key the agent calls the Anthropic API with'),
  ANTHROPIC_BASE_URL: asUrl('Anthropic API base URL', { protocols: ['https:'] }),
  OPENROUTER_API_KEY: asOptional(asString('key the fallback lane calls OpenRouter with; leave unset to keep OpenRouter fallback unavailable')),
  OPENROUTER_BASE_URL: asOptional(asUrl('OpenRouter API base URL (Anthropic-Messages-compatible), e.g. https://openrouter.ai/api/v1', { protocols: ['https:'] })),
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
  AGENT_MAX_SPECIALIST_CONSULTATIONS: asInteger(
    'specialist reviews one turn may ask for, bounding what optional consultation can cost',
    { min: 0, max: 20 },
  ),
  AGENT_SPECIALIST_MAX_STEPS: asInteger(
    'model calls one specialist review may take before it is abandoned as unavailable',
    { min: 1, max: 50 },
  ),
  GIT_AUTHOR_NAME: asString('name on the commits the agent makes inside a project'),
  GIT_AUTHOR_EMAIL: asString('email on those commits'),
  E2B_API_KEY: asString('key sandboxes are created with'),
  E2B_DOMAIN: asString('E2B domain to reach (e2b.app for their cloud, ours when self-hosted)'),
  E2B_VALIDATE_API_KEY: asBoolean(
    'whether to require the e2b_<hex> key format before calling out; false for a self-hosted ' +
      'deployment that issues keys of its own shape',
  ),
  PREVIEW_READY_TIMEOUT_SECONDS: asInteger(
    'how long to wait for a dev server to answer on its port before calling the preview failed',
    { min: 5, max: 600 },
  ),
  RUNNER_IDLE_POLL_SECONDS: asInteger(
    'how long the runner waits before looking for work again when there was none',
    { min: 1, max: 300 },
  ),
  RUNNER_CONCURRENCY: asInteger(
    'sessions one runner process works at the same time; each holds its own lease, heartbeat and sandbox',
    { min: 1, max: 16 },
  ),
  RUNNER_HEARTBEAT_SECONDS: asInteger(
    'how often the runner renews its lease while working; must be well under SESSION_LEASE_SECONDS',
    { min: 1, max: 600 },
  ),
} as const;

/** What both processes need, and all that the shared plumbing may depend on. */
/** Safe diagnostic names, derived from the authoritative specs rather than duplicated. */
export const configurationKeys: readonly string[] = Object.freeze([...new Set([
  ...Object.keys(sharedSpec), ...Object.keys(apiSpec), ...Object.keys(runnerSpec),
])]);

export type SharedConfig = LoadedEnv<typeof sharedSpec>;
export type Config = ReturnType<typeof loadConfig>;
export type RunnerConfig = ReturnType<typeof loadRunnerConfig>;

export function loadSharedConfig(
  source: Readonly<Record<string, string | undefined>> = process.env,
) {
  return loadEnv(sharedSpec, source);
}

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
  if ((config.OPENROUTER_API_KEY === undefined) !== (config.OPENROUTER_BASE_URL === undefined)) {
    throw new EnvironmentError([
      'OPENROUTER_API_KEY and OPENROUTER_BASE_URL must be set together, or both left unset to keep OpenRouter fallback unavailable.',
    ]);
  }
  return config;
}
