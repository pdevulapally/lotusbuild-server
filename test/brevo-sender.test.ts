import assert from 'node:assert/strict';
import test from 'node:test';

import { BrevoEmailSender } from '../src/email/brevo.ts';
import type { VerificationEmail } from '../src/email/sender.ts';

const message: VerificationEmail = {
  to: 'person@example.test',
  code: '123456',
  expiresInMinutes: 10,
};

test('Brevo sender uses the transactional email endpoint and expected payload', async () => {
  const originalFetch = globalThis.fetch;
  const apiKey = 'brevo-test-api-key';
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response(null, { status: 202 });
  };

  try {
    await new BrevoEmailSender(apiKey, 'verify@example.test').sendVerificationCode(message);
    assert.equal(requestUrl, 'https://api.brevo.com/v3/smtp/email');
    assert.equal(requestInit?.method, 'POST');
    assert.deepEqual(Object.fromEntries(new Headers(requestInit?.headers)), {
      'api-key': apiKey,
      accept: 'application/json',
      'content-type': 'application/json',
    });
    assert.deepEqual(JSON.parse(String(requestInit?.body)), {
      sender: { name: 'LotusBuild', email: 'verify@example.test' },
      to: [{ email: 'person@example.test' }],
      subject: 'Your LotusBuild verification code',
      textContent:
        'Your LotusBuild verification code is 123456.\n\n' +
        'It expires in 10 minutes. If you did not request it, you can ignore this email.',
      htmlContent:
        '<div style="font-family:Arial,sans-serif;color:#181716;line-height:1.6">' +
        '<p>Your LotusBuild verification code is:</p>' +
        '<p style="font-size:30px;font-weight:700;letter-spacing:8px;margin:20px 0">123456</p>' +
        '<p>It expires in 10 minutes. If you did not request it, you can ignore this email.</p>' +
        '</div>',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Brevo non-2xx responses become safe delivery-unavailable errors', async () => {
  const originalFetch = globalThis.fetch;
  const apiKey = 'brevo-test-api-key';
  const providerBody = `provider response mentions ${apiKey}`;
  globalThis.fetch = async () => new Response(providerBody, { status: 500 });

  try {
    await assert.rejects(
      () => new BrevoEmailSender(apiKey, 'verify@example.test').sendVerificationCode(message),
      (error: unknown) => {
        const safeError = error as { code?: string; message?: string; statusCode?: number; details?: unknown };
        assert.equal(safeError.code, 'email/delivery-unavailable');
        assert.equal(safeError.statusCode, 503);
        assert.equal(safeError.message, 'The verification email could not be sent. Try again shortly.');
        assert.equal(JSON.stringify(safeError.details ?? {}).includes(apiKey), false);
        assert.equal(JSON.stringify(safeError).includes(apiKey), false);
        assert.equal(JSON.stringify(safeError).includes(providerBody), false);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Brevo fetch failures become the same safe delivery-unavailable error', async () => {
  const originalFetch = globalThis.fetch;
  const apiKey = 'brevo-test-api-key';
  globalThis.fetch = async () => { throw new Error(`network error included ${apiKey}`); };

  try {
    await assert.rejects(
      () => new BrevoEmailSender(apiKey, 'verify@example.test').sendVerificationCode(message),
      (error: unknown) => {
        const safeError = error as { code?: string; message?: string; statusCode?: number; details?: unknown };
        assert.equal(safeError.code, 'email/delivery-unavailable');
        assert.equal(safeError.statusCode, 503);
        assert.equal(safeError.message, 'The verification email could not be sent. Try again shortly.');
        assert.equal(JSON.stringify(safeError.details ?? {}).includes(apiKey), false);
        assert.equal(safeError.message?.includes(apiKey), false);
        assert.equal(JSON.stringify(safeError).includes(apiKey), false);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
