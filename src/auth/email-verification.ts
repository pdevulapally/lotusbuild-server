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
  readonly dailyLimit: number;
  readonly perAccountDailyLimit: number;
  readonly now?: () => Date;
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

const RESERVE_DAILY_SEND_SCRIPT = `
local userCount = redis.call('INCR', KEYS[1])
if userCount == 1 then
  redis.call('EXPIRE', KEYS[1], 172800)
end
if userCount > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return -1
end
local count = redis.call('INCR', KEYS[2])
if count == 1 then
  redis.call('EXPIRE', KEYS[2], 172800)
end
if count > tonumber(ARGV[2]) then
  redis.call('DECR', KEYS[2])
  redis.call('DECR', KEYS[1])
  return -2
end
return count
`;

function retryAfterUtcMidnight(now: Date): number {
  const nextMidnightUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((nextMidnightUtc - now.getTime()) / 1000));
}

function normalizedEmail(value: string | undefined): string | undefined {
  const email = value?.trim().toLowerCase();
  return email === undefined || email === '' ? undefined : email;
}

export class EmailVerificationService {
  readonly #redis: Redis;
  readonly #auth: Auth;
  readonly #sender: EmailSender;
  readonly #options: VerificationOptions;
  readonly #now: () => Date;

  constructor(redis: Redis, auth: Auth, sender: EmailSender, options: VerificationOptions) {
    this.#redis = redis;
    this.#auth = auth;
    this.#sender = sender;
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  #codeKey(uid: string): string {
    return `${redisKeyPrefixes.emailVerification}code:${uid}`;
  }

  #cooldownKey(uid: string): string {
    return `${redisKeyPrefixes.emailVerification}cooldown:${uid}`;
  }

  #dailyKey(date: Date): string {
    return `${redisKeyPrefixes.emailVerification}daily:${date.toISOString().slice(0, 10)}`;
  }

  #userDailyKey(uid: string, date: Date): string {
    return `${redisKeyPrefixes.emailVerification}user-daily:${uid}:${date.toISOString().slice(0, 10)}`;
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

    const now = this.#now();
    const dailyKey = this.#dailyKey(now);
    const userDailyKey = this.#userDailyKey(uid, now);
    const reservation = Number(await this.#redis.eval(
      RESERVE_DAILY_SEND_SCRIPT,
      2,
      userDailyKey,
      dailyKey,
      String(this.#options.perAccountDailyLimit),
      String(this.#options.dailyLimit),
    ));
    if (reservation < 0) {
      await this.#redis.del(this.#cooldownKey(uid));
      const retryAfterSeconds = retryAfterUtcMidnight(now);
      if (reservation === -1) {
        throw new AppError({
          code: 'auth/verification-code-daily-limit',
          statusCode: 429,
          message: 'Too many codes requested today. Try again after midnight UTC.',
          details: { retryAfterSeconds },
        });
      }
      throw new AppError({
        code: 'email/daily-limit-reached',
        statusCode: 503,
        message: "We've reached today's limit for verification emails. Try again after midnight UTC.",
        details: { retryAfterSeconds },
      });
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const nonce = randomBytes(16).toString('hex');
    const requestId = randomUUID();
    const key = this.#codeKey(uid);
    try {
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
      });
    } catch (error) {
      await Promise.allSettled([
        this.#redis.decr(userDailyKey),
        this.#redis.decr(dailyKey),
        this.#redis.del(this.#cooldownKey(uid), key),
      ]);
      throw error;
    }

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
