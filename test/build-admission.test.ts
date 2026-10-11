import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveAiEffort } from '../src/entitlements/build-admission.ts';
import {
  ResolvedEntitlements,
  type UserEntitlements,
} from '../src/entitlements/service.ts';
import { AppError } from '../src/http/errors.ts';

function entitlements(maximum: string): UserEntitlements {
  return {
    planKey: 'test',
    planName: 'Test',
    subscriptionStatus: undefined,
    capabilities: new ResolvedEntitlements(new Map([
      ['ai.effort', { kind: 'string', value: maximum }],
    ])),
    meterLimits: new Map(),
    rateLimits: new Map(),
  };
}

test('omitting effort keeps the plan ceiling as the default', () => {
  assert.equal(resolveAiEffort(entitlements('high')), 'high');
});

test('effort may be lowered beneath the plan ceiling', () => {
  assert.equal(resolveAiEffort(entitlements('high'), 'low'), 'low');
  assert.equal(resolveAiEffort(entitlements('high'), 'standard'), 'standard');
});

test('effort cannot exceed the plan ceiling', () => {
  assert.throws(
    () => resolveAiEffort(entitlements('standard'), 'high'),
    (error) => error instanceof AppError
      && error.code === 'session/effort-not-permitted'
      && error.statusCode === 403,
  );
});

test('an unknown configured effort fails closed', () => {
  assert.throws(
    () => resolveAiEffort(entitlements('unbounded')),
    /Unsupported configured AI effort/,
  );
});
