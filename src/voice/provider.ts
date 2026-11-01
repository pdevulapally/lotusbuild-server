import { WebSocket } from 'ws';
import type { VoiceConfig } from './config.ts';

export interface VoiceProvider {
  transcribe(): WebSocket;
  speech(text: string, signal: AbortSignal): Promise<Response>;
}

/** Fixed provider origins; no model-authored URLs, callbacks or provider tool execution. */
export class ElevenLabsAudio implements VoiceProvider {
  private readonly key: string;
  private readonly config: VoiceConfig;
  constructor(key: string, config: VoiceConfig) { this.key = key; this.config = config; }
  transcribe(): WebSocket {
    const url = new URL('wss://api.elevenlabs.io/v1/speech-to-text/realtime');
    url.search = new URLSearchParams({ model_id: 'scribe_v2_realtime', audio_format: 'pcm_16000',
      commit_strategy: 'vad', vad_silence_threshold_secs: '0.8', enable_logging: 'false',
      filter_background_audio: 'true', keepalive_interval_ms: '1000' }).toString();
    return new WebSocket(url, { headers: { 'xi-api-key': this.key }, handshakeTimeout: 8000, maxPayload: 64 * 1024 });
  }
  speech(text: string, signal: AbortSignal): Promise<Response> {
    return fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(this.config.voiceId)}/stream?output_format=pcm_24000&enable_logging=false`, {
      method: 'POST', headers: { 'xi-api-key': this.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: this.config.ttsModel }), signal,
      redirect: 'error',
    });
  }
}
