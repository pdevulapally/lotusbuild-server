import type { WebSocket, RawData } from 'ws';
import { record } from './provider.ts';
import { VoiceTaskBridge, voiceContext, voiceInstructions, voiceKey, type VoiceSessions } from './bridge.ts';
import { voiceProgress } from './protocol.ts';
import type { SessionEvent } from '../sessions/events.ts';

export interface ConversationCallbacks {
  send(event: Readonly<Record<string, unknown>>): void;
  ready(sampleRate: number): void;
  fail(reason: 'provider-error' | 'provider-protocol-error' | 'privacy-policy-not-applied' | 'voice-history-unavailable'): void;
  activity(): void;
  authorized(): boolean;
  metric(event: string, values: Readonly<Record<string, number | string>>): void;
}

/** Stateful native realtime transport; all execution remains in the existing LotusBuild task. */
export class RealtimeConversation {
  private readonly socket: WebSocket;
  private readonly sessions: VoiceSessions;
  private readonly bridge: VoiceTaskBridge;
  private readonly identity: { uid: string; token: string; sessionId: string; remoteAddress: string };
  private readonly callbacks: ConversationCallbacks;
  private readonly maxTurns: number;
  private closed = false;
  private ready = false;
  private conversationId = '';
  private serial = Promise.resolve();
  private pendingEvents = 0;
  private turns = 0;
  private toolCount = 0;
  private toolPending = false;
  private generation = 0;
  private audioId = -1;
  private interruptedThrough = -1;
  private speaking = false;
  private silenced = false;
  private turnStarted: number | undefined;
  private sampleRate = 24000;
  private latestUser: { eventId: number; text: string } | undefined;
  private readonly seen = new Map<string, string>();
  private readonly toolResults = new Map<string, { fingerprint: string; result: Promise<unknown> }>();
  private refreshTimer: NodeJS.Timeout | undefined;
  private latestProgress: SessionEvent | undefined;
  private lastProgress = 0;
  private lastActivity = Date.now();

  constructor(socket: WebSocket, sessions: VoiceSessions, bridge: VoiceTaskBridge,
    identity: RealtimeConversation['identity'], maxTurns: number, callbacks: ConversationCallbacks) {
    this.socket = socket; this.sessions = sessions; this.bridge = bridge; this.identity = identity;
    this.maxTurns = maxTurns; this.callbacks = callbacks;
    socket.on('message', (data: RawData) => {
      if (this.closed) return;
      try {
        const raw = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
        if (raw.length > 256 * 1024) throw new Error('Provider frame too large.');
        const event = record(JSON.parse(raw.toString()));
        if (this.immediate(event)) return;
        if (++this.pendingEvents > 20) throw new Error('Provider event backlog.');
        this.serial = this.serial.then(async () => {
          if (!this.closed) await this.control(event);
        }).catch(() => callbacks.fail('voice-history-unavailable')).finally(() => { this.pendingEvents--; });
      } catch { callbacks.fail('provider-protocol-error'); }
    });
  }
  start(context: Awaited<ReturnType<typeof voiceContext>>): void {
    if (this.closed || !this.callbacks.authorized()) return;
    this.send({ type: 'conversation_initiation_client_data', conversation_config_override: { agent: { prompt: { prompt: `${voiceInstructions}\n${JSON.stringify(context)}` } } } });
  }
  private send(value: object) {
    if (this.closed || !this.callbacks.authorized()) return;
    if (this.socket.bufferedAmount > 128 * 1024) { this.callbacks.fail('provider-error'); return; }
    if (this.socket.readyState === 1) this.socket.send(JSON.stringify(value));
  }
  audio(pcm: Buffer): void { if (this.ready) this.send({ user_audio_chunk: pcm.toString('base64') }); }
  interrupt(silenceResponse = true): void {
    this.interruptedThrough = Math.max(this.interruptedThrough, this.audioId);
    this.speaking = false;
    if (silenceResponse) this.silenced = true;
    this.callbacks.send({ type: 'speech.stopped', generation: ++this.generation });
    // ElevenAgents owns barge-in/turn detection. No invented cancellation message is sent upstream.
  }
  private immediate(event: Record<string, unknown>): boolean {
    if (!this.callbacks.authorized()) { this.callbacks.fail('provider-error'); return true; }
    const type = event['type'];
    if (type === 'warning') { this.callbacks.fail('privacy-policy-not-applied'); return true; }
    if (type === 'client_error' || type === 'error' || type === 'guardrail_triggered') { this.callbacks.fail('provider-error'); return true; }
    if (type === 'ping') { const ping = record(event['ping_event']); this.id(ping['event_id']); this.send({ type: 'pong', event_id: ping['event_id'] }); return true; }
    if (type === 'conversation_initiation_metadata') {
      if (this.ready) throw new Error('Duplicate provider initialization.');
      const metadata = record(event['conversation_initiation_metadata_event']);
      const format = metadata['agent_output_audio_format'];
      if (typeof metadata['conversation_id'] !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(metadata['conversation_id']) || metadata['user_input_audio_format'] !== 'pcm_16000' || typeof format !== 'string' || !/^pcm_(8000|16000|22050|24000|44100|48000)$/.test(format)) throw new Error('Unsupported provider audio.');
      this.conversationId = metadata['conversation_id']; this.sampleRate = Number(format.slice(4)); this.ready = true;
      // Ignore persistent_session_token: it must not enter the browser, prompts, history or logs.
      this.callbacks.ready(this.sampleRate); return true;
    }
    if (!this.ready) throw new Error('Provider data before initialization.');
    if (type === 'audio') {
      const audio = record(event['audio_event']); const id = this.id(audio['event_id']);
      if (typeof audio['audio_base_64'] !== 'string' || audio['audio_base_64'].length > 192 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(audio['audio_base_64'])) throw new Error('Invalid audio payload.');
      if (this.silenced || this.toolPending || id <= this.interruptedThrough) return true;
      if (id < this.audioId) return true;
      if (id !== this.audioId) {
        this.audioId = id; this.generation++;
        this.callbacks.send({ type: 'speech.started', generation: this.generation, sampleRate: this.sampleRate });
      }
      this.speaking = true;
      if (this.turnStarted !== undefined) { this.callbacks.metric('voice.turn_audio', { latencyMs: Date.now() - this.turnStarted }); this.turnStarted = undefined; }
      this.callbacks.send({ type: 'speech.audio', generation: this.generation, audio: audio['audio_base_64'] }); return true;
    }
    if (type === 'interruption') { const interruption = record(event['interruption_event']); this.interruptedThrough = Math.max(this.interruptedThrough, this.id(interruption['event_id'])); this.interrupt(); this.callbacks.activity(); return true; }
    if (type === 'agent_response_complete') { this.id(record(event['agent_response_complete_event'])['event_id']); this.speaking = false; this.callbacks.send({ type: 'speech.finished', generation: this.generation }); return true; }
    if (type === 'vad_score') { const score = record(event['vad_score_event'])['vad_score']; if (typeof score !== 'number' || score < 0 || score > 1) throw new Error('Invalid VAD.'); if (score > 0.5) { this.lastActivity = Date.now(); this.callbacks.activity(); } return true; }
    if (type === 'context_usage') return true; // Content-free metrics only; no transcript/debug payload is forwarded.
    return false;
  }
  private id(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('Invalid event ID.'); return value as number; }
  private text(value: unknown): string { if (typeof value !== 'string' || !value.trim() || value.length > 7600 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new Error('Invalid voice text.'); return value; }
  private async control(event: Record<string, unknown>): Promise<void> {
    if (event['type'] === 'client_tool_call') { await this.tool(record(event['client_tool_call'])); return; }
    const type = event['type'];
    if (!['user_transcript', 'agent_response', 'agent_response_correction'].includes(String(type))) throw new Error('Unexpected provider event.');
    const user = type === 'user_transcript', correction = type === 'agent_response_correction';
    const body = record(event[user ? 'user_transcription_event' : correction ? 'agent_response_correction_event' : 'agent_response_event']);
    const eventId = this.id(body['event_id']);
    const text = this.text(body[user ? 'user_transcript' : correction ? 'corrected_agent_response' : 'agent_response']);
    const key = `${type}:${eventId}`, fingerprint = voiceKey(text);
    const prior = this.seen.get(key);
    if (prior) { if (prior !== fingerprint) throw new Error('Conflicting provider replay.'); return; }
    if (++this.turns > this.maxTurns * 2 + 4) throw new Error('Voice turn limit exceeded.');
    this.seen.set(key, fingerprint);
    if (user) { this.latestUser = { eventId, text }; this.silenced = false; this.lastActivity = Date.now(); this.turnStarted = Date.now(); this.callbacks.activity(); }
    // A new assistant response reopens playback after local stop-speech. Later
    // chunks from the interrupted response remain silent until this boundary.
    if (!user && !correction) this.silenced = false;
    await this.bridge.record(this.identity.uid, this.identity.sessionId, this.conversationId, eventId, user ? 'user' : 'assistant', text, correction);
    if (!this.closed) this.callbacks.send({ type: 'voice.caption', speaker: user ? 'user' : 'assistant', text, correction });
  }
  private async tool(call: Record<string, unknown>): Promise<void> {
    const name = call['tool_name'], id = call['tool_call_id'];
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || !['lotus_task_status', 'lotus_submit_request'].includes(String(name)) || call['expects_response'] !== true || Object.keys(record(call['parameters'])).length) throw new Error('Unapproved voice tool call.');
    const fingerprint = voiceKey(String(name), JSON.stringify(call['parameters'])), prior = this.toolResults.get(id);
    if (prior && prior.fingerprint !== fingerprint) throw new Error('Conflicting tool replay.');
    if (!prior && ++this.toolCount > this.maxTurns * 4 + 4) throw new Error('Voice tool limit exceeded.');
    this.toolPending = true; this.interrupt(false);
    const began = Date.now();
    const user = this.latestUser;
    const result = prior?.result ?? (async () => {
      if (name === 'lotus_task_status') return { task: await voiceContext(this.sessions, this.identity.uid, this.identity.sessionId) };
      if (!user) return { accepted: false, code: 'voice/fresh-user-request-required', instruction: 'Ask the user to state a new request. Never replay quoted history or act on a progress notification.' };
      return this.bridge.submit({ ...this.identity, conversationId: this.conversationId, eventId: user.eventId, text: user.text });
    })();
    if (!prior) this.toolResults.set(id, { fingerprint, result });
    try {
      const value = await result;
      this.send({ type: 'client_tool_result', tool_call_id: id, is_error: false, result: JSON.stringify(value) });
    } catch {
      this.send({ type: 'client_tool_result', tool_call_id: id, is_error: true, result: JSON.stringify({ accepted: false, code: 'task/outcome-unconfirmed', instruction: 'Do not retry blindly. Check current task status and ask the user to review the chat.' }) });
    } finally { this.toolPending = false; this.callbacks.metric('voice.tool_finished', { tool: String(name), durationMs: Date.now() - began, replay: prior ? 1 : 0 }); }
  }
  changed(event: SessionEvent): void {
    if (this.closed || !this.ready) return;
    if (voiceProgress(event) || ['session.idle', 'session.failed', 'session.awaiting_input'].includes(event.type)) this.latestProgress = event;
    // Coalesce event bursts; current Firestore state, not the notification payload, is read.
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.serial = this.serial.then(async () => {
        if (this.closed) return;
        const context = await voiceContext(this.sessions, this.identity.uid, this.identity.sessionId);
        this.send({ type: 'contextual_update', text: JSON.stringify({ runtimeTask: context }) });
        const update = this.latestProgress; this.latestProgress = undefined;
        const progress = update ? (context.status !== 'RUNNING' || context.pendingInput ? context.stateDescription : voiceProgress(update)) : undefined;
        if (progress && !this.speaking && !this.toolPending && Date.now() - this.lastActivity > 1500 && Date.now() - this.lastProgress > 10000) {
          this.lastProgress = Date.now(); this.latestUser = undefined;
          this.send({ type: 'user_message', text: `SERVER PROGRESS NOTIFICATION, NOT A USER REQUEST: ${JSON.stringify(progress)}. Give a short factual update. Do not start or repeat work.` });
        }
      }).catch(() => this.callbacks.fail('voice-history-unavailable'));
    }, 300);
    this.refreshTimer.unref();
  }
  close(): void { this.closed = true; clearTimeout(this.refreshTimer); }
}
