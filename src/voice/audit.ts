import { readFile } from 'node:fs/promises';
import { parseVoiceAgentReference, parseVoiceConfig } from './config.ts';
import { ElevenLabsRealtime } from './provider.ts';

// Explicitly invoked operator utility, never part of startup. GETs only;
// no agent publication, writes, signed access or paid conversation.
try {
  const key = process.env['ELEVENLABS_API_KEY'], raw = process.env['ELEVENLABS_VOICE_CONFIG'];
  const args = process.argv.slice(2);
  if (!key || !(args.length === 0 || (args.length === 2 && args[0] === '--reference-file' && args[1]))) throw new Error('Missing or invalid audit arguments.');
  const config = args.length === 2
    ? parseVoiceAgentReference(await readFile(args[1]!, 'utf8'))
    : parseVoiceConfig(raw ?? '');
  const result = await new ElevenLabsRealtime(key, config).audit(AbortSignal.timeout(15000));
  process.stdout.write(`${JSON.stringify({ event: 'voice.agent_audit', ...result })}\n`);
} catch {
  process.stderr.write('Voice agent audit failed. Check the pinned version, required privacy/tool settings, key permissions and network access. No conversation was started.\n');
  process.exitCode = 1;
}
