import assert from 'node:assert/strict';
import test from 'node:test';
import type { Auth, UserRecord } from 'firebase-admin/auth';
import type { Redis } from 'ioredis';

import { EmailVerificationService } from '../src/auth/email-verification.ts';
import type { EmailSender, VerificationEmail } from '../src/email/sender.ts';

class FakeRedis {
  readonly hashes = new Map<string, Record<string, string>>();
  readonly strings = new Map<string, string>();

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

  async eval(_script: string, _keys: number, key: string, requestId: string, candidate: string): Promise<number> {
    const record = this.hashes.get(key);
    if (record === undefined || record['requestId'] !== requestId) return -2;
    if (record['codeHash'] === candidate) {
      this.hashes.delete(key);
      return 100;
    }
    const attempts = Number(record['attempts']) - 1;
    if (attempts <= 0) this.hashes.delete(key);
    else record['attempts'] = String(attempts);
    return attempts;
  }

  async del(key: string): Promise<number> {
    const existed = this.hashes.delete(key) || this.strings.delete(key);
    return existed ? 1 : 0;
  }
}

function harness() {
  const redis = new FakeRedis();
  const sent: VerificationEmail[] = [];
  const identity = { uid: 'u1', email: 'Person@Example.test', emailVerified: false };
  const auth = {
    getUser: async () => ({ ...identity }) as UserRecord,
    updateUser: async (_uid: string, update: { emailVerified?: boolean }) => {
      if (update.emailVerified !== undefined) identity.emailVerified = update.emailVerified;
      return { ...identity } as UserRecord;
    },
  } as unknown as Auth;
  const sender: EmailSender = {
    sendVerificationCode: async (message) => { sent.push(message); },
  };
  const service = new EmailVerificationService(redis as unknown as Redis, auth, sender, {
    codeSecret: 'test-secret-that-is-longer-than-thirty-two-characters',
    ttlSeconds: 600,
    resendSeconds: 60,
    maxAttempts: 5,
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
