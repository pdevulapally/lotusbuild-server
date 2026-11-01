/** Opt-in deployment policy. No allowance, voice, price or privacy decision is guessed. */
export interface VoiceConfig {
  voiceId: string;
  ttsModel: string;
  maxCallSeconds: number;
  idleSeconds: number;
  maxConnections: number;
  maxSpeechCharacters: number;
  globalMonthlyMicroGbp: number;
  privacyVersion: string;
  zeroRetentionVerified: true;
  downstreamZeroRetentionVerified: true;
  trainingOptOutVerified: true;
  sttMicroGbpPerMinute: number;
  ttsMicroGbpPerThousandCharacters: number;
}

export function parseVoiceConfig(raw: string): VoiceConfig {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a voice policy object.');
  const config = value as Record<string, unknown>;
  const strings = ['voiceId', 'ttsModel', 'privacyVersion'];
  const numbers = ['maxCallSeconds', 'idleSeconds', 'maxConnections', 'maxSpeechCharacters', 'globalMonthlyMicroGbp', 'sttMicroGbpPerMinute', 'ttsMicroGbpPerThousandCharacters'];
  const keys = [...strings, ...numbers, 'zeroRetentionVerified', 'downstreamZeroRetentionVerified', 'trainingOptOutVerified'];
  if (Object.keys(config).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(config, key))) throw new Error('Voice policy has missing or unknown fields.');
  for (const key of strings) if (typeof config[key] !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(config[key] as string)) throw new Error(`Invalid voice policy ${key}.`);
  for (const key of numbers) if (!Number.isSafeInteger(config[key]) || (config[key] as number) < 1) throw new Error(`Invalid voice policy ${key}.`);
  if ((config['maxCallSeconds'] as number) > 1800 || (config['idleSeconds'] as number) > (config['maxCallSeconds'] as number) || (config['maxConnections'] as number) > 1000 || (config['maxSpeechCharacters'] as number) > 20000) throw new Error('Voice policy exceeds resource safety ceilings.');
  if (config['zeroRetentionVerified'] !== true || config['downstreamZeroRetentionVerified'] !== true || config['trainingOptOutVerified'] !== true) throw new Error('Voice requires verified audio-provider and downstream zero retention, plus training opt-out.');
  return config as unknown as VoiceConfig;
}
