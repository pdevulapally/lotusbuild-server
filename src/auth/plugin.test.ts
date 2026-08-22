import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AppError } from '../http/errors.ts';
import { bearerToken } from './plugin.ts';

function rejection(header: string | undefined): AppError {
  try {
    bearerToken(header);
  } catch (error) {
    assert.ok(error instanceof AppError, `expected AppError, got ${String(error)}`);
    return error;
  }
  assert.fail(`expected ${JSON.stringify(header)} to be rejected`);
}

test('a missing Authorization header is reported distinctly from a malformed one', () => {
  assert.equal(rejection(undefined).code, 'auth/missing-token');
  assert.equal(rejection('').code, 'auth/malformed-header');
});

test('rejects anything that is not exactly "Bearer <token>"', () => {
  for (const header of ['Basic abc', 'Bearer', 'Bearer a b', 'abc', ' Bearer abc']) {
    assert.equal(rejection(header).code, 'auth/malformed-header', `for header: ${header}`);
  }
});

test('every rejection is a 401 and never leaks the token back to the caller', () => {
  for (const header of [undefined, '', 'Basic sekrit-value', 'Bearer a b']) {
    const error = rejection(header);
    assert.equal(error.statusCode, 401);
    assert.doesNotMatch(error.message, /sekrit-value/);
  }
});

test('accepts a well-formed header, case-insensitively on the scheme', () => {
  assert.equal(bearerToken('Bearer abc.def.ghi'), 'abc.def.ghi');
  assert.equal(bearerToken('bearer abc.def.ghi'), 'abc.def.ghi');
});
