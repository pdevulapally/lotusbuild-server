import { parseArgs } from 'node:util';

import { EnvironmentError, loadConfig } from '../config/index.ts';
import { ConfigurationStore } from '../entitlements/store.ts';
import { initialiseFirebase } from '../firebase.ts';
import { MeteringService, reservationsCollectionName } from '../metering/service.ts';
import { sessionsCollectionPath } from '../sessions/repository.ts';
import { planCancelledHoldClosure } from './cancelled-holds.ts';

/**
 * Closes the model-token holds of sessions a user stopped before the provider
 * reported usage, so recovery can finish them. Before the runner learned to do
 * this itself, such a session stayed RUNNING with cancelRequested set and its
 * hourly recovery failed with usage/reconciliation-required forever.
 *
 *   node --env-file=.env dist/seed/close-cancelled-holds.js --session <id> [--session <id>]
 *   node --env-file=.env dist/seed/close-cancelled-holds.js --session <id> --apply
 *
 * The default is a dry run that prints every hold of each session with the
 * verdict the service would reach. Applying settles only the holds marked
 * `settle`, at the quantity they reserved, through the same
 * `MeteringService.settleUnobserved` the runner uses for a live cancellation.
 * The session itself is left for the next recovery pass, which finalises it
 * once its holds reconcile.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { apply: { type: 'boolean', default: false }, session: { type: 'string', multiple: true } },
    strict: true,
  });
  const sessionIds = values.session ?? [];
  if (sessionIds.length === 0) throw new Error('Pass at least one --session <id>.');
  for (const id of sessionIds) if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error(`"${id}" is not a session id.`);

  const config = loadConfig();
  const { firestore } = initialiseFirebase(config);
  const configuration = new ConfigurationStore(firestore, 1000);
  const metering = new MeteringService(firestore, configuration);
  const { registry } = await configuration.get();
  const tokenMeterKeys = new Set([registry.inputTokenMeterKey, registry.outputTokenMeterKey,
    ...(registry.fallback === undefined ? [] : [registry.fallback.inputTokenMeterKey, registry.fallback.outputTokenMeterKey])]);

  process.stdout.write(`Project "${config.FIREBASE_PROJECT_ID}":\n`);
  let settled = 0;
  for (const sessionId of sessionIds) {
    const sessionSnapshot = await firestore.doc(`${sessionsCollectionPath}/${sessionId}`).get();
    const session = sessionSnapshot.exists ? sessionSnapshot.data() : undefined;
    const ownerUid = typeof session?.['ownerUid'] === 'string' ? session['ownerUid'] : undefined;
    const ids = [...new Set([...(session?.['reservationIds'] ?? []), ...(session?.['specialistReservationIds'] ?? [])] as unknown[])]
      .filter((id): id is string => typeof id === 'string');
    const reservations = new Map<string, Readonly<Record<string, unknown>> | undefined>();
    if (ownerUid !== undefined) for (const id of ids) {
      const snapshot = await firestore.doc(`users/${ownerUid}/${reservationsCollectionName}/${id}`).get();
      reservations.set(id, snapshot.exists ? snapshot.data() : undefined);
    }
    const plan = planCancelledHoldClosure({ sessionId, session, reservations, tokenMeterKeys, leaseSeconds: config.SESSION_LEASE_SECONDS, now: new Date() });

    process.stdout.write(`  session ${sessionId} (owner ${plan.ownerUid}):\n`);
    if (plan.holds.length === 0) process.stdout.write('    no reservations recorded.\n');
    for (const hold of plan.holds) {
      process.stdout.write(`    ${hold.id} ${hold.meterKey} estimated=${hold.estimatedQuantity ?? '?'}: ${hold.verdict}\n`);
      if (hold.verdict !== 'settle' || values.apply !== true) continue;
      const closed = await metering.settleUnobserved(plan.ownerUid, hold.id);
      process.stdout.write(`      ${closed ? 'settled at its estimate' : 'was already closed'}\n`);
      if (closed) settled += 1;
    }
  }
  if (values.apply !== true) { process.stdout.write('Dry run: nothing was written. Pass --apply to settle the holds marked "settle".\n'); return; }
  process.stdout.write(`Applied. ${settled} hold(s) settled; recovery finalises the session(s) on its next pass.\n`);
}

main().catch((error: unknown) => {
  if (error instanceof EnvironmentError) { process.stderr.write(`${error.message}\n`); process.exit(1); }
  throw error;
});
