import { readFile } from 'node:fs/promises';
import { deleteApp } from 'firebase-admin/app';
import { loadSharedConfig } from '../config/index.ts';
import { ConfigurationStore } from '../entitlements/store.ts';
import { EntitlementService } from '../entitlements/service.ts';
import { SubscriptionCache } from '../entitlements/subscription-cache.ts';
import { initialiseFirebase } from '../firebase.ts';
import { MeteringService } from '../metering/service.ts';
import { ProjectRepository } from '../projects/repository.ts';
import { SessionRepository } from '../sessions/repository.ts';
import { UserRepository } from '../users/repository.ts';
import { SnapshotStore } from '../storage/snapshots.ts';
import { connectRedis, redisKeyPrefixes } from '../redis/client.ts';
import { AccountErasure, type ErasureDecision } from './erasure.ts';

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help')) {
    process.stdout.write('Usage: node --env-file=.env --experimental-strip-types src/privacy/run-erasure.ts decision.json [--apply]\nDefault is read-only. Decision fields: uid, requestReference, billingReviewReference, retentionDecisionReference.\nApply disables account access, requests build cancellation and erases live content when resources are reconciled. Financial records and provider-copy verification remain separate.\n');
    return;
  }
  if (args.slice(1).some((arg) => arg !== '--apply')) throw new Error('Unknown argument.');
  const value = JSON.parse(await readFile(args[0]!, 'utf8')) as Record<string, unknown>;
  if (typeof value['uid'] !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value['uid'])) throw new Error('Invalid account.');
  const uid = value['uid'];
  for (const field of ['requestReference', 'billingReviewReference', 'retentionDecisionReference']) {
    if (typeof value[field] !== 'string' || !value[field].trim() || value[field].length > 500) throw new Error('Missing reviewed decision.');
  }
  const decision: ErasureDecision = {
    requestReference: String(value['requestReference'] ?? ''), billingReviewReference: String(value['billingReviewReference'] ?? ''),
    retentionDecisionReference: String(value['retentionDecisionReference'] ?? ''),
  };
  for (const entry of Object.values(decision)) if (!entry.trim() || entry.length > 500) throw new Error('Missing reviewed decision.');
  const config = loadSharedConfig();
  const firebase = initialiseFirebase(config);
  const configuration = new ConfigurationStore(firebase.firestore, config.CONFIG_CACHE_TTL_SECONDS * 1000);
  if (!args.includes('--apply')) {
    try {
      const active = await firebase.firestore.collection('sessions').where('ownerUid', '==', uid).where('status', 'in', ['QUEUED', 'RUNNING']).limit(1).get();
      const open = await firebase.firestore.collection(`users/${uid}/reservations`).where('status', '==', 'OPEN').limit(1).get();
      process.stdout.write(JSON.stringify({ apply: false, activeBuildsPresent: !active.empty, unresolvedReservationsPresent: !open.empty }) + '\n');
    } finally { await deleteApp(firebase.app); }
    return;
  }
  const redis = await connectRedis(config, () => {}, 'lotusbuild-erasure');
  try {
    const cache = new SubscriptionCache(redis, config.SUBSCRIPTION_CACHE_TTL_SECONDS);
    const entitlements = new EntitlementService(firebase.firestore, configuration, cache);
    const metering = new MeteringService(firebase.firestore, configuration);
    const snapshots = new SnapshotStore(firebase.app, config.FIREBASE_STORAGE_BUCKET, config.SNAPSHOT_URL_TTL_SECONDS);
    const projects = new ProjectRepository(firebase.firestore, new UserRepository(firebase.firestore), entitlements, metering, configuration, snapshots,
      async (id) => { await redis.del(`${redisKeyPrefixes.sessionEvents}${id}`); });
    const sessions = new SessionRepository(firebase.firestore, projects, entitlements, configuration, metering, config.SESSION_LEASE_SECONDS);
    const service = new AccountErasure(firebase.firestore, firebase.auth, projects, sessions, async (id) => {
      await cache.invalidate(id);
      await redis.del(...['read', 'write', 'build', 'stream'].map((kind) => `${redisKeyPrefixes.rateLimit}${kind}:${id}`));
    });
    process.stdout.write(JSON.stringify(await service.apply(uid, decision)) + '\n');
  } finally { await redis.quit(); await deleteApp(firebase.app); }
}
main().catch((error: unknown) => {
  const code = error instanceof Error && 'code' in error ? String(error.code) : 'erasure/failed';
  process.stderr.write(`${code}: erasure is not confirmed complete. Retain the request and inspect the pending state before retrying.\n`);
  process.exitCode = 1;
});
