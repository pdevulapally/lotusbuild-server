import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EnvironmentError, asList, asPort, asUrl, loadEnv } from './env.ts';
import { loadConfig } from './index.ts';

/** `assert.throws` does not hand back the error, and the problem list is the point. */
function captureEnvironmentError(run: () => unknown): EnvironmentError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof EnvironmentError, `expected EnvironmentError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected the call to throw');
}

const spec = {
  PORT: asPort('port'),
  PUBLIC_API_URL: asUrl('base url', { protocols: ['https:'] }),
  ORIGINS: asList('origins', asUrl('origin', { protocols: ['https:'] })),
} as const;

test('reports every problem at once instead of only the first', () => {
  const { problems } = captureEnvironmentError(() => loadEnv(spec, { PORT: 'nope' }));

  assert.equal(problems.length, 3);
  assert.ok(problems.some((p) => p.startsWith('PORT is invalid')));
  assert.ok(problems.some((p) => p.startsWith('PUBLIC_API_URL is not set')));
  assert.ok(problems.some((p) => p.startsWith('ORIGINS is not set')));
});

test('an empty or whitespace value is missing, not a valid empty string', () => {
  const { problems } = captureEnvironmentError(() =>
    loadEnv({ PORT: asPort('port') }, { PORT: '   ' }),
  );
  assert.match(problems[0] ?? '', /^PORT is not set/);
});

test('rejects a port outside the valid range rather than coercing it', () => {
  for (const bad of ['0', '65536', '8080.5', '-1']) {
    captureEnvironmentError(() => loadEnv({ PORT: asPort('port') }, { PORT: bad }));
  }
});

test('rejects a URL whose protocol is not permitted', () => {
  captureEnvironmentError(() =>
    loadEnv({ U: asUrl('u', { protocols: ['https:'] }) }, { U: 'http://example.com' }),
  );
});

test('parses a valid environment into frozen typed values', () => {
  const env = loadEnv(spec, {
    PORT: '4100',
    PUBLIC_API_URL: 'https://api.example.com',
    ORIGINS: 'https://a.example.com, https://b.example.com',
  });

  assert.equal(env.PORT, 4100);
  assert.equal(env.PUBLIC_API_URL.host, 'api.example.com');
  assert.equal(env.ORIGINS.length, 2);
  assert.throws(() => {
    (env as unknown as Record<string, unknown>).PORT = 1;
  });
});

test('the real config refuses to load from an empty environment', () => {
  captureEnvironmentError(() => loadConfig({}));
});
