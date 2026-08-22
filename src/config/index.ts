import { asEnum, asList, asPort, asString, asUrl, loadEnv } from './env.ts';

export { EnvironmentError } from './env.ts';

/**
 * Every variable the process needs to boot. Adding a dependency (Firestore,
 * E2B, Redis) means adding its variables here — nothing reads `process.env`
 * directly anywhere else, so this object is the complete configuration surface.
 */
const spec = {
  NODE_ENV: asEnum('deployment mode', ['development', 'production', 'test']),
  LOG_LEVEL: asEnum('pino log level', ['trace', 'debug', 'info', 'warn', 'error', 'fatal']),
  HOST: asString('interface to bind (127.0.0.1 behind a reverse proxy, 0.0.0.0 otherwise)'),
  PORT: asPort('TCP port to listen on'),
  PUBLIC_API_URL: asUrl('externally reachable base URL of this API', {
    protocols: ['https:', 'http:'],
  }),
  CORS_ALLOWED_ORIGINS: asList(
    'browser origins permitted to call this API',
    asUrl('allowed origin', { protocols: ['https:', 'http:'] }),
  ),
} as const;

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(source: Readonly<Record<string, string | undefined>> = process.env) {
  return loadEnv(spec, source);
}
