import { parseVoiceConfig } from './config.ts';
import { ElevenLabsRealtime } from './provider.ts';

// Explicitly invoked operator utility, never part of startup. GETs only;
// no agent publication, writes, signed access or paid conversation.
try {
  const key = process.env['ELEVENLABS_API_KEY'], raw = process.env['ELEVENLABS_VOICE_CONFIG'];
  if (!key || !raw) throw new Error('Missing configuration.');
  const result = await new ElevenLabsRealtime(key, parseVoiceConfig(raw)).audit(AbortSignal.timeout(15000));
  process.stdout.write(`${JSON.stringify({ event: 'voice.agent_audit', ...result })}\n`);
} catch {
  process.stderr.write('Voice agent audit failed. Check the pinned version, required privacy/tool settings, key permissions and network access. No conversation was started.\n');
  process.exitCode = 1;
}
