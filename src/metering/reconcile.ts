import { readFile } from 'node:fs/promises';
import { deleteApp } from 'firebase-admin/app';
import { loadSharedConfig } from '../config/index.ts';
import { ConfigurationStore } from '../entitlements/store.ts';
import { initialiseFirebase } from '../firebase.ts';
import { MeteringService } from './service.ts';

/** Operator-only command. It has no HTTP route and is read-only without both explicit flags. */
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help')) {
    process.stdout.write('Usage: node --experimental-strip-types src/metering/reconcile.ts <evidence.json> [--apply --runners-stopped]\nEvidence: {"uid":"...","reservationId":"...","quantity":123,"providerReference":"..."}\nDefault: inspect only. Apply requires authoritative provider evidence and stopped runners.\n');
    return;
  }
  if (args.slice(1).some((arg) => !['--apply', '--runners-stopped'].includes(arg))) throw new Error('Unknown argument.');
  const apply = args.includes('--apply');
  if (apply && !args.includes('--runners-stopped')) throw new Error('Stop all runners before applying reconciliation.');
  const evidence: unknown = JSON.parse(await readFile(args[0]!, 'utf8'));
  if (typeof evidence !== 'object' || evidence === null) throw new Error('Invalid evidence.');
  const value = evidence as Record<string, unknown>;
  for (const field of ['uid', 'reservationId']) {
    if (typeof value[field] !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value[field])) throw new Error(`Invalid ${field}.`);
  }
  if (typeof value['quantity'] !== 'number' || !Number.isSafeInteger(value['quantity']) || value['quantity'] < 0) throw new Error('Invalid quantity.');
  if (typeof value['providerReference'] !== 'string' || value['providerReference'].trim().length === 0 || value['providerReference'].length > 500) throw new Error('A provider evidence reference is required.');
  const config = loadSharedConfig();
  const firebase = initialiseFirebase(config);
  try {
    const configuration = new ConfigurationStore(firebase.firestore, config.CONFIG_CACHE_TTL_SECONDS * 1000);
    const metering = new MeteringService(firebase.firestore, configuration);
    const uid = value['uid'] as string;
    const id = value['reservationId'] as string;
    const record = await metering.reservationRecord(uid, id);
    process.stdout.write(JSON.stringify({ apply, status: record['status'], meterKey: record['meterKey'], estimatedQuantity: record['estimatedQuantity'], observedQuantity: record['observedQuantity'], proposedQuantity: value['quantity'] }) + '\n');
    if (apply) {
      const { registry } = await configuration.get();
      if (registry.meters.get(String(record['meterKey']))?.kind !== 'COUNTER') throw new Error('Only counter usage can be reconciled with this command.');
      await metering.recordObservedUsage(uid, id, value['quantity'], value['providerReference']);
      await metering.reconcile(uid, id);
      process.stdout.write('Reconciliation recorded.\n');
    }
  } finally { await deleteApp(firebase.app); }
}
main().catch(() => { process.stderr.write('Reconciliation failed; no unknown usage was assumed to be zero. Inspect the ledger and evidence before retrying.\n'); process.exitCode = 1; });
