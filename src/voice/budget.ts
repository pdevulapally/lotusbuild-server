import { createHash } from 'node:crypto';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import type { Redis } from 'ioredis';
import type { UserEntitlements } from '../entitlements/service.ts';
import type { ConfigurationStore } from '../entitlements/store.ts';
import { AppError } from '../http/errors.ts';
import type { MeteringService } from '../metering/service.ts';
import type { VoiceConfig } from './config.ts';

export interface VoiceBudget {
  acquire(uid: string, callId: string, concurrent: number): Promise<boolean>;
  renew(uid: string, callId: string): Promise<boolean>;
  release(uid: string, callId: string): Promise<void>;
  charge(uid: string, entitlements: UserEntitlements, kind: 'call' | 'seconds', quantity: number, operation: string): Promise<void>;
}

/** Redis server time, atomic admission across API replicas, expiring abandoned calls. */
export const voiceLeaseScript = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
for i = 1, 2 do redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now) end
local present = redis.call('ZSCORE', KEYS[1], ARGV[1]) and redis.call('ZSCORE', KEYS[2], ARGV[1])
if ARGV[4] == 'renew' and not present then return 0 end
if not present and (redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) or redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[3])) then return 0 end
for i = 1, 2 do redis.call('ZADD', KEYS[i], now + 20000, ARGV[1]); redis.call('PEXPIRE', KEYS[i], 40000) end
return 1
`;

const fail = (code: string, message: string): never => { throw new AppError({ code, message, statusCode: 429 }); };

/** Uses the existing entitlement and consumption ledger. Only the platform cost cap is new. */
export class MeteredVoiceBudget implements VoiceBudget {
  private readonly db: Firestore;
  private readonly redis: Redis;
  private readonly metering: MeteringService;
  private readonly configuration: ConfigurationStore;
  private readonly config: VoiceConfig;
  constructor(db: Firestore, redis: Redis, metering: MeteringService, configuration: ConfigurationStore, config: VoiceConfig) {
    this.db = db; this.redis = redis; this.metering = metering; this.configuration = configuration; this.config = config;
  }
  #keys(uid: string) { return ['lotus:voice:active', `lotus:voice:user:${createHash('sha256').update(uid).digest('hex')}`]; }
  async acquire(uid: string, callId: string, concurrent: number) {
    return await this.redis.eval(voiceLeaseScript, 2, ...this.#keys(uid), callId, this.config.maxConnections, concurrent, 'acquire') === 1;
  }
  async renew(uid: string, callId: string) {
    return await this.redis.eval(voiceLeaseScript, 2, ...this.#keys(uid), callId, this.config.maxConnections, 0, 'renew') === 1;
  }
  async release(uid: string, callId: string) {
    // Remove only this call; an expired predecessor cannot release its replacement.
    const results = await this.redis.multi().zrem(this.#keys(uid)[0]!, callId).zrem(this.#keys(uid)[1]!, callId).exec();
    if (!results || results.some(([error]) => error)) throw new Error('Voice lease release failed.');
  }
  async charge(uid: string, entitlements: UserEntitlements, kind: 'call' | 'seconds', quantity: number, operation: string) {
    if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error('Invalid voice charge.');
    const now = new Date();
    const quantities = [{ meterKey: 'voice.seconds', quantity }, ...(kind === 'call' ? [{ meterKey: 'voice.cost.microgbp', quantity: this.config.maxCallMicroGbp }] : [])];
    const { registry } = await this.configuration.get();
    for (const item of quantities) {
      const meter = registry.meters.get(item.meterKey), limit = entitlements.meterLimits.get(item.meterKey);
      if (meter?.kind !== 'COUNTER' || meter.resetPeriod !== 'MONTHLY' || !limit || limit.overageEnabled) throw new Error('Voice requires explicit monthly hard-capped counters.');
    }
    // Full approved worst-case allocation is committed BEFORE connecting. No assumed STT/TTS price equivalence.
    const cost = kind === 'call' ? this.config.maxCallMicroGbp : 0;
    const aggregate = this.db.doc(`voice_spend/${now.toISOString().slice(0, 7)}`);
    const claim = aggregate.collection('dispatches').doc(createHash('sha256').update(operation).digest('hex'));
    await this.db.runTransaction(async tx => {
      const [total, prior] = await Promise.all([tx.get(aggregate), tx.get(claim)]);
      if (prior.exists) fail('voice/dispatch-already-claimed', 'This audio dispatch has already been claimed; it will not be retried.');
      const spent: unknown = total.exists ? total.data()?.['microGbpUpperBound'] : 0;
      if (!Number.isSafeInteger(spent) || (spent as number) < 0) throw new Error('Invalid voice cost ledger.');
      if ((spent as number) + cost > this.config.globalMonthlyMicroGbp) fail('voice/platform-limit', 'Voice capacity is unavailable. Continue in text.');
      await this.metering.consumeManyIn(tx, { uid, entitlements, quantities, now });
      tx.set(aggregate, { microGbpUpperBound: (spent as number) + cost, updatedAt: FieldValue.serverTimestamp() });
      // No identity or conversation content. A claim fences uncertain provider outcomes.
      tx.create(claim, { kind, quantity, microGbpUpperBound: cost, createdAt: FieldValue.serverTimestamp() });
    });
  }
}
