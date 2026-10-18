import assert from 'node:assert/strict';
import test from 'node:test';
import type { Auth, UserRecord } from 'firebase-admin/auth';
import type { Redis } from 'ioredis';

import { EmailVerificationService } from '../src/auth/email-verification.ts';
import type { EmailSender, VerificationEmail } from '../src/email/sender.ts';

class FakeRedis {
  readonly hashes = new Map<string, Record<string, string>>();
  readonly strings = new Map<string, string>();
  readonly counters = new Map<string, number>();

  async set(key: string, value: string): Promise<'OK' | null> {
    if (this.strings.has(key)) return null;
    this.strings.set(key, value);
    return 'OK';
  }

  async ttl(key: string): Promise<number> {
    return this.strings.has(key) ? 60 : -2;
  }

  multi() {
    let hash: { key: string; value: Record<string, string> } | undefined;
    return {
      hset: (key: string, value: Record<string, string>) => {
        hash = { key, value };
        return this.multiResult(hash);
      },
      expire: (_key: string, _seconds: number) => this.multiResult(hash),
      exec: async () => {
        if (hash !== undefined) this.hashes.set(hash.key, { ...hash.value });
        return [];
      },
    };
  }

  private multiResult(hash: { key: string; value: Record<string, string> } | undefined) {
    return {
      expire: (_key: string, _seconds: number) => ({
        exec: async () => {
          if (hash !== undefined) this.hashes.set(hash.key, { ...hash.value });
          return [];
        },
      }),
    };
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return { ...(this.hashes.get(key) ?? {}) };
  }

  async eval(script: string, keyCount: number, ...values: string[]): Promise<number> {
    if (script.includes('local userCount')) {
      const [userDailyKey, dailyKey] = values.slice(0, keyCount);
      const [perAccountLimit, dailyLimit] = values.slice(keyCount);
      const userCount = (this.counters.get(userDailyKey!) ?? 0) + 1;
      this.counters.set(userDailyKey!, userCount);
      if (userCount > Number(perAccountLimit)) {
        this.counters.set(userDailyKey!, userCount - 1);
        return -1;
      }

      const dailyCount = (this.counters.get(dailyKey!) ?? 0) + 1;
      this.counters.set(dailyKey!, dailyCount);
      if (dailyCount > Number(dailyLimit)) {
        this.counters.set(dailyKey!, dailyCount - 1);
        this.counters.set(userDailyKey!, userCount - 1);
        return -2;
      }
      return dailyCount;
    }

    const [key, requestId, candidate] = values;
    const record = this.hashes.get(key!);
    if (record === undefined || record['requestId'] !== requestId) return -2;
    if (record['codeHash'] === candidate) {
      this.hashes.delete(key!);
      return 100;
    }
    const attempts = Number(record['attempts']) - 1;
    if (attempts <= 0) this.hashes.delete(key!);
    else record['attempts'] = String(attempts);
    return attempts;
  }

  async incr(key: string): Promise<number> {
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return next;
  }

  async decr(key: string): Promise<number> {
    const next = (this.counters.get(key) ?? 0) - 1;
    this.counters.set(key, next);
    return next;
  }

  async del(...keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      deleted += Number(this.hashes.delete(key));
      deleted += Number(this.strings.delete(key));
      deleted += Number(this.counters.delete(key));
    }
    return deleted;
  }
}

function harness(options: {
  dailyLimit?: number;
  perAccountDailyLimit?: number;
  now?: () => Date;
  sender?: EmailSender;
} = {}) {
  const redis = new FakeRedis();
  const sent: VerificationEmail[] = [];
  const identity = { uid: 'u1', email: 'Person@Example.test', emailVerified: false };
  const auth = {
    getUser: async (uid: string) => ({ ...identity, uid }) as UserRecord,
    updateUser: async (uid: string, update: { emailVerified?: boolean }) => {
      if (update.emailVerified !== undefined) identity.emailVerified = update.emailVerified;
      return { ...identity, uid } as UserRecord;
    },
  } as unknown as Auth;
  const sender: EmailSender = options.sender ?? {
    sendVerificationCode: async (message) => { sent.push(message); },
  };
  const service = new EmailVerificationService(redis as unknown as Redis, auth, sender, {
    codeSecret: 'test-secret-that-is-longer-than-thirty-two-characters',
    ttlSeconds: 600,
    resendSeconds: 60,
    maxAttempts: 5,
    dailyLimit: options.dailyLimit ?? 300,
    perAccountDailyLimit: options.perAccountDailyLimit ?? 10,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { redis, sent, identity, service };
}

test('a code is delivered but only an HMAC and nonce are stored', async () => {
  const h = harness();
  assert.deepEqual(await h.service.send('u1'), { expiresInSeconds: 600, resendAfterSeconds: 60 });
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0]!.code, /^[0-9]{6}$/);
  const stored = [...h.redis.hashes.values()][0]!;
  assert.equal(stored['email'], 'person@example.test');
  assert.notEqual(stored['codeHash'], h.sent[0]!.code);
  assert.equal(JSON.stringify(stored).includes(h.sent[0]!.code), false);
});

test('resending inside the cooldown is rejected without delivering another email', async () => {
  const h = harness();
  await h.service.send('u1');
  await assert.rejects(() => h.service.send('u1'), (error: unknown) =>
    typeof error === 'object' && error !== null && 'code' in error &&
    error.code === 'auth/verification-code-cooldown');
  assert.equal(h.sent.length, 1);
});

test('a correct code is single-use and marks the same Firebase email verified', async () => {
  const h = harness();
  await h.service.send('u1');
  await h.service.verify('u1', h.sent[0]!.code);
  assert.equal(h.identity.emailVerified, true);
  assert.equal(h.redis.hashes.size, 0);
  await h.service.verify('u1', h.sent[0]!.code);
});

test('wrong attempts consume the allowance and invalidate the code', async () => {
  const h = harness();
  await h.service.send('u1');
  const wrong = h.sent[0]!.code === '999999' ? '000000' : '999999';
  for (let attempt = 0; attempt < 5; attempt++) {
    await assert.rejects(() => h.service.verify('u1', wrong));
  }
  assert.equal(h.redis.hashes.size, 0);
  await assert.rejects(() => h.service.verify('u1', h.sent[0]!.code));
  assert.equal(h.identity.emailVerified, false);
});

test('a code cannot verify a different email on the same uid', async () => {
  const h = harness();
  await h.service.send('u1');
  h.identity.email = 'changed@example.test';
  await assert.rejects(() => h.service.verify('u1', h.sent[0]!.code));
  assert.equal(h.identity.emailVerified, false);
});

test('verification sends below the daily limit reserve the shared UTC counter', async () => {
  const now = () => new Date('2025-01-02T12:00:00.000Z');
  const h = harness({ dailyLimit: 3, now });
  await h.service.send('u1');
  await h.service.send('u2');
  assert.equal(h.sent.length, 2);
  assert.equal(h.redis.counters.get('emv:daily:2025-01-02'), 2);
});

test('the daily limit blocks another send and releases its user cooldown', async () => {
  const now = () => new Date('2025-01-02T23:00:00.000Z');
  const h = harness({ dailyLimit: 2, now });
  await h.service.send('u1');
  await h.service.send('u2');

  await assert.rejects(() => h.service.send('u3'), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'email/daily-limit-reached');
    assert.equal((error as { details?: { retryAfterSeconds?: number } }).details?.retryAfterSeconds, 3600);
    return true;
  });
  assert.equal(h.sent.length, 2);
  assert.equal(h.redis.strings.has('emv:cooldown:u3'), false);
  assert.equal(h.redis.counters.get('emv:user-daily:u3:2025-01-02'), 0);

  await assert.rejects(() => h.service.send('u3'), (error: unknown) =>
    (error as { code?: string }).code === 'email/daily-limit-reached');
  assert.equal(h.sent.length, 2);
});

test('sender failure releases the quota slot, cooldown and stored code', async () => {
  let attempts = 0;
  const sent: VerificationEmail[] = [];
  const failure = new Error('delivery failed');
  const sender: EmailSender = {
    sendVerificationCode: async (message) => {
      attempts++;
      if (attempts === 1) throw failure;
      sent.push(message);
    },
  };
  const h = harness({
    dailyLimit: 1,
    now: () => new Date('2025-01-02T12:00:00.000Z'),
    sender,
  });

  await assert.rejects(() => h.service.send('u1'), (error: unknown) => error === failure);
  assert.equal(h.redis.counters.get('emv:user-daily:u1:2025-01-02'), 0);
  assert.equal(h.redis.counters.get('emv:daily:2025-01-02'), 0);
  assert.equal(h.redis.strings.has('emv:cooldown:u1'), false);
  assert.equal(h.redis.hashes.has('emv:code:u1'), false);

  await h.service.send('u1');
  assert.equal(sent.length, 1);
  assert.equal(h.redis.counters.get('emv:daily:2025-01-02'), 1);
});

test('daily quota keys use UTC dates and start fresh at UTC midnight', async () => {
  let now = new Date('2025-01-02T23:59:59.000Z');
  const h = harness({ dailyLimit: 1, now: () => now });
  await h.service.send('u1');
  now = new Date('2025-01-03T00:00:00.000Z');
  await h.service.send('u2');

  assert.equal(h.redis.counters.get('emv:daily:2025-01-02'), 1);
  assert.equal(h.redis.counters.get('emv:daily:2025-01-03'), 1);
});

test('per-account daily cap rejects the eleventh code without affecting other accounts or the next day', async () => {
  let now = new Date('2025-01-02T23:00:00.000Z');
  const h = harness({ dailyLimit: 300, perAccountDailyLimit: 10, now: () => now });

  for (let request = 0; request < 10; request++) {
    await h.service.send('u1');
    await h.redis.del('emv:cooldown:u1');
  }

  await assert.rejects(() => h.service.send('u1'), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'auth/verification-code-daily-limit');
    assert.equal((error as { statusCode?: number }).statusCode, 429);
    assert.equal((error as { details?: { retryAfterSeconds?: number } }).details?.retryAfterSeconds, 3600);
    return true;
  });
  assert.equal(h.sent.length, 10);
  assert.equal(h.redis.counters.get('emv:user-daily:u1:2025-01-02'), 10);
  assert.equal(h.redis.strings.has('emv:cooldown:u1'), false);

  await h.service.send('u2');
  assert.equal(h.sent.length, 11);
  assert.equal(h.redis.counters.get('emv:user-daily:u2:2025-01-02'), 1);

  now = new Date('2025-01-03T00:00:00.000Z');
  await h.service.send('u1');
  assert.equal(h.sent.length, 12);
  assert.equal(h.redis.counters.get('emv:user-daily:u1:2025-01-03'), 1);
});
