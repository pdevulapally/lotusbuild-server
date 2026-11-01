import { isDeepStrictEqual } from 'node:util';

type Fields = Record<string, unknown>;

/** Owner-approved launch limits, 2026-11-01. No provider prices or privacy attestations. */
export const voiceLaunchLimits = {
  maxCallSeconds: 600, idleSeconds: 60, maxConnections: 2, maxTurns: 40,
  globalMonthlyMicroGbp: 100_000_000,
} as const;

export const voicePlanAllowances = [
  { planKey: 'free', seconds: 300, callSeconds: 300 },
  { planKey: 'pro', seconds: 3600, callSeconds: 600 },
  { planKey: 'business', seconds: 10800, callSeconds: 600 },
] as const;

const capabilities = [
  { key: 'voice.enabled', valueKind: 'boolean', mergeStrategy: 'MAX', label: 'Voice access' },
  { key: 'voice.concurrent', valueKind: 'number', mergeStrategy: 'MAX', label: 'Concurrent voice calls' },
  { key: 'voice.call.seconds', valueKind: 'number', mergeStrategy: 'MAX', label: 'Maximum voice call duration' },
];
const meters = [
  { key: 'voice.seconds', unit: 'seconds', kind: 'COUNTER', resetPeriod: 'MONTHLY', label: 'Voice time' },
  { key: 'voice.cost.microgbp', unit: 'microgbp', kind: 'COUNTER', resetPeriod: 'MONTHLY', label: 'Voice cost allocation' },
];

function appendRows(existing: unknown, additions: readonly Fields[], key: string): unknown[] {
  if (!Array.isArray(existing)) throw new Error('Required configuration rows are missing.');
  const merged: unknown[] = [...existing];
  for (const addition of additions) {
    const matches = existing.filter(row => row && typeof row === 'object' && (row as Fields)[key] === addition[key]);
    if (matches.length > 1) throw new Error('Duplicate voice configuration rows.');
    if (matches.length === 1) {
      if (!isDeepStrictEqual(matches[0], addition)) throw new Error('Existing voice configuration differs; explicit review is required.');
    } else merged.push(addition);
  }
  return merged;
}

/** Adds only new voice definitions. Conflicting definitions are never overwritten. */
export function withVoiceRegistry(registry: Fields): Fields {
  return { ...registry, capabilities: appendRows(registry['capabilities'], capabilities, 'key'), meters: appendRows(registry['meters'], meters, 'key') };
}

/** All other plan fields/rows retain their original values, including Stripe prices. */
export function withVoicePlan(plan: Fields): Fields {
  const allowance = voicePlanAllowances.find(item => item.planKey === plan['key']);
  if (!allowance) throw new Error('No approved voice allowance for this plan.');
  const entitlements = [
    { capabilityKey: 'voice.enabled', value: { kind: 'boolean', value: true } },
    { capabilityKey: 'voice.concurrent', value: { kind: 'number', value: 1 } },
    { capabilityKey: 'voice.call.seconds', value: { kind: 'number', value: allowance.callSeconds } },
  ];
  // Every user is bounded by the same approved global allocation cap. This does
  // not create an extra spend pool per user: the transactional global ledger
  // remains authoritative across every plan/user/replica.
  const limits = [
    { meterKey: 'voice.seconds', includedAllowance: allowance.seconds, hardLimit: allowance.seconds, overageEnabled: false },
    { meterKey: 'voice.cost.microgbp', includedAllowance: voiceLaunchLimits.globalMonthlyMicroGbp, hardLimit: voiceLaunchLimits.globalMonthlyMicroGbp, overageEnabled: false },
  ];
  return { ...plan, entitlements: appendRows(plan['entitlements'], entitlements, 'capabilityKey'), meterLimits: appendRows(plan['meterLimits'], limits, 'meterKey') };
}
