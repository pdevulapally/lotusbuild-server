import { createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { Auth } from 'firebase-admin/auth';
import type { Redis } from 'ioredis';

import type { EmailSender } from '../email/sender.ts';
import { AppError } from '../http/errors.ts';
import { redisKeyPrefixes } from '../redis/client.ts';

interface VerificationOptions {
  readonly codeSecret: string;
  readonly ttlSeconds: number;
  readonly resendSeconds: number;
  readonly maxAttempts: number;
}

export interface VerificationCodeSent {
  readonly expiresInSeconds: number;
  readonly resendAfterSeconds: number;
}

const VERIFY_SCRIPT = `
local values = redis.call('HMGET', KEYS[1], 'requestId', 'codeHash', 'attempts')
if not values[1] or values[1] ~= ARGV[1] then
  return -2
end
if values[2] == ARGV[2] then
  redis.call('DEL', KEYS[1])
  return 100
end
local attempts = tonumber(values[3] or '0') - 1
if attempts <= 0 then
  redis.call('DEL', KEYS[1])
else
  redis.call('HSET', KEYS[1], 'attempts', attempts)
end
return attempts
`;

function normalizedEmail(value: string | undefined): string | undefined {
  const email = value?.trim().toLowerCase();
  return email === undefined || email === '' ? undefined : email;
}

export class EmailVerificationService {
  readonly #redis: Redis;
  readonly #auth: Auth;
  readonly #sender: EmailSender;
  readonly #options: VerificationOptions;

  constructor(redis: Redis, auth: Auth, sender: EmailSender, options: VerificationOptions) {
    this.#redis = redis;
    this.#auth = auth;
    this.#sender = sender;
    this.#options = options;
  }

  #codeKey(uid: string): string {
    return `${redisKeyPrefixes.emailVerification}code:${uid}`;
  }

  #cooldownKey(uid: string): string {
    return `${redisKeyPrefixes.emailVerification}cooldown:${uid}`;
  }

  #hash(uid: string, email: string, nonce: string, code: string): string {
    return createHmac('sha256', this.#options.codeSecret)
      .update(uid)
      .update('\0')
      .update(email)
      .update('\0')
      .update(nonce)
      .update('\0')
      .update(code)
      .digest('hex');
  }

  async send(uid: string): Promise<VerificationCodeSent> {
    const identity = await this.#auth.getUser(uid);
    if (identity.emailVerified) {
      return { expiresInSeconds: 0, resendAfterSeconds: 0 };
    }
    const email = normalizedEmail(identity.email);
    if (email === undefined) {
      throw new AppError({
        code: 'auth/email-unavailable',
        statusCode: 409,
        message: 'This account does not have an email address to verify.',
      });
    }

    const reserved = await this.#redis.set(
      this.#cooldownKey(uid),
      '1',
      'EX',
      this.#options.resendSeconds,
      'NX',
    );
    if (reserved !== 'OK') {
      const retryAfter = Math.max(1, await this.#redis.ttl(this.#cooldownKey(uid)));
      throw new AppError({
        code: 'auth/verification-code-cooldown',
        statusCode: 429,
        message: `Wait ${retryAfter}s before requesting another code.`,
        details: { retryAfterSeconds: retryAfter },
      });
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const nonce = randomBytes(16).toString('hex');
    const requestId = randomUUID();
    const key = this.#codeKey(uid);
    await this.#redis
      .multi()
      .hset(key, {
        requestId,
        email,
        nonce,
        codeHash: this.#hash(uid, email, nonce, code),
        attempts: String(this.#options.maxAttempts),
      })
      .expire(key, this.#options.ttlSeconds)
      .exec();

    await this.#sender.sendVerificationCode({
      to: email,
      code,
      expiresInMinutes: Math.ceil(this.#options.ttlSeconds / 60),
      idempotencyKey: requestId,
    });

    return {
      expiresInSeconds: this.#options.ttlSeconds,
      resendAfterSeconds: this.#options.resendSeconds,
    };
  }

  async verify(uid: string, code: string): Promise<void> {
    const identity = await this.#auth.getUser(uid);
    if (identity.emailVerified) {
      await this.#redis.del(this.#codeKey(uid));
      return;
    }
    const currentEmail = normalizedEmail(identity.email);
    if (currentEmail === undefined) {
      throw this.#invalidCode();
    }

    const key = this.#codeKey(uid);
    const stored = await this.#redis.hgetall(key);
    const email = normalizedEmail(stored['email']);
    const nonce = stored['nonce'];
    const requestId = stored['requestId'];
    if (email === undefined || nonce === undefined || requestId === undefined || email !== currentEmail) {
      throw this.#invalidCode();
    }

    const result = Number(await this.#redis.eval(
      VERIFY_SCRIPT,
      1,
      key,
      requestId,
      this.#hash(uid, email, nonce, code),
    ));
    if (result !== 100) {
      throw this.#invalidCode();
    }

    await this.#auth.updateUser(uid, { emailVerified: true });
    const updated = await this.#auth.getUser(uid);
    if (normalizedEmail(updated.email) !== email) {
      await this.#auth.updateUser(uid, { emailVerified: false });
      throw this.#invalidCode();
    }
  }

  #invalidCode(): AppError {
    return new AppError({
      code: 'auth/verification-code-invalid',
      statusCode: 400,
      message: 'The code is invalid or has expired. Request a new code and try again.',
    });
  }
}
