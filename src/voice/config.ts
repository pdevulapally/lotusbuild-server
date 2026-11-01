/** Explicit opt-in policy for a pinned private ElevenAgents Realtime deployment. */
export interface VoiceConfig {
  environment: 'global' | 'eu';
  agentId: string;
  agentVersionId: string;
  agentConfigSha256: string;
  statusToolId: string;
  submitToolId: string;
  maxCallSeconds: number;
  idleSeconds: number;
  maxConnections: number;
  maxTurns: number;
  maxCallMicroGbp: number;
  globalMonthlyMicroGbp: number;
  privacyVersion: string;
  zeroRetentionVerified: true;
  downstreamZeroRetentionVerified: true;
  trainingOptOutVerified: true;
  providerSpendingLimitVerified: true;
}

/** Read-only provider inspection. Contains no activation or billing attestations. */
export type VoiceAgentReference = Pick<VoiceConfig, 'environment' | 'agentId' | 'agentVersionId' | 'statusToolId' | 'submitToolId' | 'maxCallSeconds'>;

export function parseVoiceAgentReference(raw: string): VoiceAgentReference {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an agent reference.');
  const reference = value as Record<string, unknown>;
  const ids = ['agentId', 'agentVersionId', 'statusToolId', 'submitToolId'];
  const keys = [...ids, 'environment', 'maxCallSeconds'];
  if (Object.keys(reference).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(reference, key))) throw new Error('Agent reference has missing or unknown fields.');
  if (!['global', 'eu'].includes(String(reference['environment']))) throw new Error('Invalid agent environment.');
  for (const key of ids) if (typeof reference[key] !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(reference[key] as string)) throw new Error('Invalid agent identifier.');
  if (!Number.isSafeInteger(reference['maxCallSeconds']) || (reference['maxCallSeconds'] as number) < 1 || (reference['maxCallSeconds'] as number) > 1800 || reference['statusToolId'] === reference['submitToolId']) throw new Error('Invalid audit duration or tool references.');
  return reference as unknown as VoiceAgentReference;
}

export function parseVoiceConfig(raw: string): VoiceConfig {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a voice policy object.');
  const config = value as Record<string, unknown>;
  const strings = ['agentId', 'agentVersionId', 'statusToolId', 'submitToolId', 'privacyVersion'];
  const numbers = ['maxCallSeconds', 'idleSeconds', 'maxConnections', 'maxTurns', 'maxCallMicroGbp', 'globalMonthlyMicroGbp'];
  const flags = ['zeroRetentionVerified', 'downstreamZeroRetentionVerified', 'trainingOptOutVerified', 'providerSpendingLimitVerified'];
  const keys = [...strings, ...numbers, ...flags, 'agentConfigSha256', 'environment'];
  if (Object.keys(config).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(config, key))) throw new Error('Voice policy has missing or unknown fields.');
  if (!['global', 'eu'].includes(String(config['environment']))) throw new Error('Voice requires an approved global or EU environment.');
  for (const key of strings) if (typeof config[key] !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(config[key] as string)) throw new Error(`Invalid voice policy ${key}.`);
  for (const key of numbers) if (!Number.isSafeInteger(config[key]) || (config[key] as number) < 1) throw new Error(`Invalid voice policy ${key}.`);
  for (const key of flags) if (config[key] !== true) throw new Error(`Voice requires verified ${key}.`);
  if (typeof config['agentConfigSha256'] !== 'string' || !/^[a-f0-9]{64}$/.test(config['agentConfigSha256'])) throw new Error('Voice needs an audited agent configuration digest.');
  if ((config['maxCallSeconds'] as number) > 1800 || (config['idleSeconds'] as number) > (config['maxCallSeconds'] as number) || (config['maxConnections'] as number) > 1000 || (config['maxTurns'] as number) > 100 || config['statusToolId'] === config['submitToolId']) throw new Error('Voice policy exceeds safety ceilings or repeats tool IDs.');
  return config as unknown as VoiceConfig;
}
