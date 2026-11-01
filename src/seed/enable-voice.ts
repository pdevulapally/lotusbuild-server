import { isDeepStrictEqual, parseArgs } from 'node:util';
import { loadConfig } from '../config/index.ts';
import { parsePlan, parseRegistry } from '../entitlements/schema.ts';
import { plansCollectionPath, registryDocumentPath } from '../entitlements/store.ts';
import { initialiseFirebase } from '../firebase.ts';
import { voiceLaunchLimits, voicePlanAllowances, withVoicePlan, withVoiceRegistry } from './voice-rows.ts';

// Explicit operator utility. Dry-run by default; never calls ElevenLabs or
// changes an environment file. One transaction preserves all non-voice fields.
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { apply: { type: 'boolean', default: false } }, strict: true });
  const { firestore } = initialiseFirebase(loadConfig());
  const changes = await firestore.runTransaction(async tx => {
    const registryRef = firestore.doc(registryDocumentPath);
    const registrySnapshot = await tx.get(registryRef);
    const plans = await tx.get(firestore.collection(plansCollectionPath));
    if (!registrySnapshot.exists) throw new Error('Registry is missing.');
    if (plans.docs.length !== voicePlanAllowances.length || plans.docs.some(plan => !voicePlanAllowances.some(allowance => allowance.planKey === plan.id))) throw new Error('Live plans differ from the approved voice launch plans.');
    const currentRegistry = registrySnapshot.data()!;
    const nextRegistry = withVoiceRegistry(currentRegistry);
    const registry = parseRegistry(nextRegistry, registryDocumentPath);
    const writes: { ref: FirebaseFirestore.DocumentReference; fields: Record<string, unknown> }[] = [];
    if (!isDeepStrictEqual(currentRegistry, nextRegistry)) writes.push({ ref: registryRef, fields: { capabilities: nextRegistry['capabilities'], meters: nextRegistry['meters'] } });
    for (const plan of plans.docs) {
      const current = plan.data();
      if (current['key'] !== plan.id) throw new Error('Plan identity mismatch.');
      const next = withVoicePlan(current);
      parsePlan(next, plan.ref.path, registry);
      if (!isDeepStrictEqual(current, next)) writes.push({ ref: plan.ref, fields: { entitlements: next['entitlements'], meterLimits: next['meterLimits'] } });
    }
    if (values.apply) for (const write of writes) tx.update(write.ref, write.fields);
    return writes.map(write => write.ref.path);
  });
  process.stdout.write(`${JSON.stringify({ event: 'voice.launch_allowances', applied: values.apply, changedDocuments: changes,
    allowances: voicePlanAllowances, deploymentLimits: voiceLaunchLimits })}\n`);
}

main().catch(() => {
  process.stderr.write('Voice allowance configuration failed. No raw document or credential details are printed. Review the registry/plan definitions before retrying.\n');
  process.exitCode = 1;
});
