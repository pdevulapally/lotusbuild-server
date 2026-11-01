import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { Auth } from 'firebase-admin/auth';
import { WebSocket, type RawData } from 'ws';
import type { EntitlementService, UserEntitlements } from '../entitlements/service.ts';
import type { SessionRepository } from '../sessions/repository.ts';
import type { SessionEvents } from '../sessions/events.ts';
import { authenticatedUser } from '../auth/plugin.ts';
import { AppError } from '../http/errors.ts';
import type { VoiceConfig } from './config.ts';
import type { VoiceProvider } from './provider.ts';
import type { VoiceBudget } from './budget.ts';
import { parseVoiceCommand, voicePrivacyNotice, voiceTaskStatus, voiceProgress } from './protocol.ts';

export interface VoiceDependencies {
  auth: Pick<Auth, 'verifyIdToken'>;
  sessions: Pick<SessionRepository, 'readOwned' | 'listMessages'>;
  events: Pick<SessionEvents, 'subscribe'>;
  entitlements: Pick<EntitlementService, 'forUser'>;
  budget: VoiceBudget;
  provider: VoiceProvider;
  config: VoiceConfig;
  allowedOrigins: ReadonlySet<string>;
}

const bytes = (data: RawData): Buffer => Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
const unavailable = () => new AppError({ code: 'voice/configuration-required', statusCode: 503, message: 'Voice is not enabled. Continue in text.' });

/** Audio transport only. Task mutations stay on the authenticated text-command API and its ledger. */
export class VoiceRelay {
  readonly #active = new Set<() => void>();
  private readonly deps: VoiceDependencies;
  constructor(deps: VoiceDependencies) { this.deps = deps; }
  async access(uid: string, sessionId: string) {
    await this.deps.sessions.readOwned(uid, sessionId);
    const entitlements = await this.deps.entitlements.forUser(uid);
    if (!entitlements.capabilities.boolean('voice.enabled')) throw new AppError({ code: 'voice/not-allowed', statusCode: 403, message: 'Voice is not available on this plan. Continue in text.' });
    const concurrent = entitlements.capabilities.number('voice.concurrent');
    const seconds = entitlements.capabilities.number('voice.call.seconds');
    if (!Number.isSafeInteger(concurrent) || concurrent < 1 || concurrent > 10 || !Number.isSafeInteger(seconds) || seconds < 1) throw new Error('Invalid voice allowances.');
    return { entitlements, concurrent, maxCallSeconds: Math.min(this.deps.config.maxCallSeconds, seconds) };
  }
  closeAll() { for (const close of this.#active) close(); }
  serve(socket: WebSocket, sessionId: string, origin: string | undefined, log: FastifyBaseLogger): void {
    const d = this.deps;
    if (!origin || !d.allowedOrigins.has(origin)) { socket.close(4403, 'origin-not-allowed'); return; }
    // Also bounds unauthenticated handshakes; distributed authenticated admission is below.
    if (this.#active.size >= d.config.maxConnections) { socket.close(4429, 'capacity-reached'); return; }
    const callId = randomUUID();
    const opened = Date.now();
    let uid: string | undefined, token = '', entitlements: UserEntitlements | undefined;
    let admissionPhase: 'authentication' | 'access' | 'budget' | 'provider' = 'authentication';
    let upstream: WebSocket | undefined, closed = false, authenticating = false, admitted = false, ready = false;
    let leaseUntil = 0, paidUntil = 0, paidSeconds = 0, receivedBytes = 0, lastActivity = Date.now(), lastPartial = '';
    let speech: AbortController | undefined, generation = 0, spokenCharacters = 0, transcriptSeq = 0;
    let speechBusy = false, ticking = false, tokenExpires = 0;
    let callLimitSeconds = d.config.maxCallSeconds, callStarted = 0, controlTokens = 10, controlAt = Date.now();
    let lastTurnAt: number | undefined;
    type Narration = { text: string; identity: string };
    let pendingSpeech: { command: ReturnType<typeof parseVoiceCommand>; narration?: Narration } | undefined;
    let unsubscribe: (() => void) | undefined, lastProgress = 0;
    const spoken = new Set<string>();
    const timers: NodeJS.Timeout[] = [];
    const send = (value: object) => {
      if (closed || socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > 256 * 1024) { finish(4413, 'slow-consumer'); return; }
      socket.send(JSON.stringify(value));
    };
    const stopSpeech = () => { generation++; pendingSpeech = undefined; speech?.abort(); speech = undefined; send({ type: 'speech.stopped', generation }); };
    const finish = (code = 1000, reason = 'call-ended') => {
      if (closed) return;
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      speech?.abort(); upstream?.terminate(); unsubscribe?.(); this.#active.delete(shutdown);
      if (admitted && uid) void d.budget.release(uid, callId).catch(() => log.error({ callId, event: 'voice.lease_release_failed' }, 'voice cleanup failed'));
      if (socket.readyState === WebSocket.OPEN) socket.close(code, reason);
      const killer = setTimeout(() => socket.terminate(), 1000); killer.unref();
      log.info({ callId, event: 'voice.closed', reason, durationMs: Date.now() - opened, inputBytes: receivedBytes, spokenCharacters }, 'voice call ended');
    };
    const shutdown = () => finish(1001, 'server-shutdown');
    this.#active.add(shutdown);
    socket.once('close', () => finish());
    socket.once('error', () => finish(4500, 'connection-error'));
    timers.push(setTimeout(() => { if (!ready) finish(4401, 'authentication-timeout'); }, 10000));
    const authority = () => !closed && uid !== undefined && ready && Date.now() < leaseUntil && Date.now() < paidUntil && Date.now() < tokenExpires;
    const speak = async (command: ReturnType<typeof parseVoiceCommand>, narration?: Narration) => {
      if (command.type !== 'speak' || !uid || !entitlements || !authority()) return;
      if (speechBusy) { pendingSpeech = { command, ...(narration === undefined ? {} : { narration }) }; return; }
      speechBusy = true;
      const version = ++generation;
      const abort = new AbortController(); speech = abort;
      const timeout = setTimeout(() => abort.abort(), 20000); timeout.unref();
      const began = Date.now();
      try {
        const session = await d.sessions.readOwned(uid, sessionId);
        let text: string, identity: string;
        if (narration !== undefined) {
          if (session.status !== 'RUNNING' || session.pendingInput || session.cancelRequested) return;
          text = narration.text; identity = narration.identity;
        } else if (command.source === 'status') {
          text = voiceTaskStatus(session);
          identity = `status:${session.status}:${session.messageCount}:${session.pendingInput?.id ?? ''}:${session.cancelRequested === true}:${session.fallback?.status ?? ''}`;
        } else {
          if (session.status !== 'IDLE' || session.pendingInput || session.cancelRequested) return;
          const message = (await d.sessions.listMessages(uid, sessionId, 200)).find(item => item.seq === command.seq && item.role === 'assistant');
          if (!message) return;
          // Read the same completed response as text; never synthesize raw tool results, secrets or code.
          text = message.content.replace(/```[\s\S]*?(?:```|$)/g, ' Code is available in the chat. ').slice(0, 2000);
          identity = `message:${message.seq}`;
        }
        if (!text.trim() || spoken.has(identity) || !authority() || abort.signal.aborted) return;
        if (spokenCharacters + text.length > d.config.maxSpeechCharacters) { send({ type: 'speech.unavailable', reason: 'call-speech-limit' }); return; }
        spoken.add(identity); // An uncertain paid dispatch is never replayed automatically.
        await d.budget.charge(uid, entitlements, 'characters', text.length, `${callId}:${identity}`);
        if (!authority() || abort.signal.aborted) return;
        spokenCharacters += text.length;
        const response = await d.provider.speech(text, abort.signal);
        if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('Speech provider unavailable.'); }
        send({ type: 'speech.started', generation: version, sampleRate: 24000 });
        let size = 0, first = true;
        for await (const chunk of response.body) {
          if (!authority() || abort.signal.aborted || version !== generation) { abort.abort(); break; }
          size += chunk.byteLength;
          if (size > 4 * 1024 * 1024) throw new Error('Speech response exceeded limit.');
          if (first) { first = false; log.info({ callId, event: 'voice.speech_first_audio', latencyMs: Date.now() - began, ...(lastTurnAt === undefined ? {} : { turnLatencyMs: Date.now() - lastTurnAt }) }, 'voice latency'); }
          // Fetch chunk boundaries are transport-dependent; keep every browser frame bounded.
          for (let offset = 0; offset < chunk.byteLength; offset += 48 * 1024) {
            send({ type: 'speech.audio', generation: version, audio: Buffer.from(chunk.subarray(offset, offset + 48 * 1024)).toString('base64') });
          }
        }
        if (version === generation) send({ type: 'speech.finished', generation: version });
      } catch {
        if (!abort.signal.aborted) { send({ type: 'speech.unavailable', reason: 'provider-or-budget-unavailable' }); log.warn({ callId, event: 'voice.speech_failed' }, 'voice speech unavailable'); }
      } finally {
        clearTimeout(timeout); speechBusy = false; if (speech === abort) speech = undefined;
        const next = pendingSpeech; pendingSpeech = undefined;
        if (next) void speak(next.command, next.narration);
      }
    };
    const authenticate = async (raw: Buffer) => {
      const input: unknown = JSON.parse(raw.toString());
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid authentication.');
      const auth = input as Record<string, unknown>;
      if (Object.keys(auth).length !== 3 || auth['type'] !== 'authenticate' || typeof auth['token'] !== 'string' || auth['token'].length > 8192 || auth['consentVersion'] !== d.config.privacyVersion) throw new Error('Invalid authentication or consent.');
      token = auth['token'];
      const verified = await d.auth.verifyIdToken(token, true);
      if (verified.email_verified !== true || verified.exp * 1000 <= Date.now()) throw new Error('Verified sign-in required.');
      uid = verified.uid; tokenExpires = verified.exp * 1000;
      admissionPhase = 'access';
      const access = await this.access(uid, sessionId);
      entitlements = access.entitlements; callLimitSeconds = access.maxCallSeconds;
      if (closed) return;
      admissionPhase = 'budget';
      admitted = await d.budget.acquire(uid, callId, access.concurrent);
      if (!admitted) { finish(4429, 'capacity-reached'); return; }
      if (closed) { await d.budget.release(uid, callId); return; }
      leaseUntil = Date.now() + 10000;
      unsubscribe = await d.events.subscribe(sessionId, event => {
        if (!authority() || speechBusy || Date.now() - lastActivity < 1500 || Date.now() - lastProgress < 10000) return;
        const text = voiceProgress(event);
        if (!text) return;
        lastProgress = Date.now();
        void speak({ type: 'speak', source: 'status' }, { text, identity: `event:${event.id}` });
      });
      if (closed) { unsubscribe(); return; }
      await d.budget.charge(uid, entitlements, 'seconds', Math.min(10, callLimitSeconds), `${callId}:seconds:0`);
      paidSeconds = Math.min(10, callLimitSeconds);
      if (closed) return;
      paidUntil = Date.now() + Math.min(10, callLimitSeconds) * 1000;
      const started = Date.now();
      callStarted = started;
      admissionPhase = 'provider';
      upstream = d.provider.transcribe();
      upstream.once('error', () => finish(4502, 'provider-unavailable'));
      upstream.once('close', () => finish(4502, 'provider-disconnected'));
      upstream.on('message', data => {
        if (closed) return;
        try {
          const event: unknown = JSON.parse(bytes(data).toString());
          if (!event || typeof event !== 'object') throw new Error('Invalid provider message.');
          const record = event as Record<string, unknown>;
          if (record['message_type'] === 'warning') { finish(4503, 'privacy-policy-not-applied'); return; }
          if (record['message_type'] === 'session_started') {
            ready = true; send({ type: 'ready', callId, maxCallSeconds: callLimitSeconds });
            log.info({ callId, event: 'voice.ready', latencyMs: Date.now() - opened }, 'voice connection ready');
            return;
          }
          if (!authority()) { finish(4401, 'voice-authority-expired'); return; }
          if (record['message_type'] === 'partial_transcript' || record['message_type'] === 'committed_transcript') {
            const text = record['text'];
            if (typeof text !== 'string' || text.length > 8000) throw new Error('Invalid transcript.');
            if (text && text !== lastPartial) { lastActivity = Date.now(); stopSpeech(); }
            lastPartial = text;
            if (record['message_type'] === 'committed_transcript') {
              lastPartial = '';
              if (text.trim()) {
                lastTurnAt = Date.now();
                const id = `${callId}:${++transcriptSeq}`;
                send({ type: 'transcript.final', id, text });
                log.info({ callId, event: 'voice.turn_committed', turn: transcriptSeq }, 'voice turn ready');
              }
            }
            else send({ type: 'transcript.partial', text });
          } else if (record['message_type'] !== 'session_started') { finish(4502, 'provider-error'); }
        } catch { finish(4502, 'provider-protocol-error'); }
      });
      timers.push(setTimeout(() => finish(4410, 'max-duration'), callLimitSeconds * 1000));
      timers.push(setInterval(() => {
        if (closed || ticking) return;
        if (Date.now() >= leaseUntil || Date.now() >= tokenExpires) { finish(4401, 'voice-authority-expired'); return; }
        if (Date.now() - lastActivity > d.config.idleSeconds * 1000) { finish(4410, 'idle-timeout'); return; }
        ticking = true;
        void (async () => {
          await d.auth.verifyIdToken(token, true);
          await d.sessions.readOwned(uid!, sessionId);
          entitlements = await d.entitlements.forUser(uid!);
          if (!entitlements.capabilities.boolean('voice.enabled') || !await d.budget.renew(uid!, callId)) throw new Error('Voice permission expired.');
          const updatedCallLimit = entitlements.capabilities.number('voice.call.seconds');
          if (!Number.isSafeInteger(updatedCallLimit) || updatedCallLimit < 1) throw new Error('Invalid voice duration allowance.');
          callLimitSeconds = Math.min(callLimitSeconds, updatedCallLimit);
          if (Date.now() >= callStarted + callLimitSeconds * 1000) { finish(4410, 'max-duration'); return; }
          if (closed) return;
          leaseUntil = Date.now() + 10000;
          if (paidUntil - Date.now() < 6000) {
            const remaining = Math.floor((started + callLimitSeconds * 1000 - paidUntil) / 1000);
            if (remaining > 0) {
              const quantity = Math.min(10, remaining);
              await d.budget.charge(uid!, entitlements, 'seconds', quantity, `${callId}:seconds:${paidUntil}`);
              paidSeconds += quantity;
              if (!closed) paidUntil += quantity * 1000;
            }
          }
        })().catch(() => finish(4429, 'permission-or-budget-unavailable')).finally(() => { ticking = false; });
      }, 5000));
      for (const timer of timers) timer.unref();
    };
    socket.on('message', (data, binary) => {
      if (closed) return;
      const frame = bytes(data);
      if (!uid || !ready) {
        if (authenticating || binary || frame.length > 10000) { finish(4400, 'protocol-error'); return; }
        authenticating = true;
        void authenticate(frame).catch(error => {
          if (error instanceof AppError && [402, 409, 429].includes(error.statusCode)) finish(4429, 'voice-usage-limit');
          else if (admissionPhase === 'authentication' || admissionPhase === 'access') finish(4401, 'authentication-or-access-failed');
          else finish(4502, 'voice-admission-unavailable');
        });
        return;
      }
      if (!authority()) { finish(4401, 'voice-authority-expired'); return; }
      if (binary) {
        receivedBytes += frame.length;
        // Mono PCM16 16kHz, <=256ms per frame, bounded to realtime input plus a small jitter allowance.
        if (!frame.length || frame.length % 2 || frame.length > 8192 || receivedBytes > paidSeconds * 32000 || receivedBytes > (Date.now() - opened) * 32 + 16000 || (upstream?.bufferedAmount ?? 0) > 128 * 1024) { finish(4400, 'audio-rate-exceeded'); return; }
        if (upstream?.readyState === WebSocket.OPEN) upstream.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: frame.toString('base64'), sample_rate: 16000 }));
      } else {
        if (frame.length > 256) { finish(4400, 'protocol-error'); return; }
        controlTokens = Math.min(10, controlTokens + (Date.now() - controlAt) / 100); controlAt = Date.now();
        if (controlTokens < 1) { finish(4429, 'control-rate-exceeded'); return; }
        controlTokens--;
        try {
          const command = parseVoiceCommand(JSON.parse(frame.toString()));
          if (command.type === 'end') finish();
          else if (command.type === 'interrupt') stopSpeech();
          else void speak(command);
        } catch { finish(4400, 'protocol-error'); }
      }
    });
    for (const timer of timers) timer.unref();
  }
}

/** Called after the existing desktop route has registered the single WebSocket plugin. */
export function registerVoiceRoutes(app: FastifyInstance, relay?: VoiceRelay, config?: VoiceConfig): void {
  app.get('/voice', { preHandler: [app.requireAuth, app.enforceRateLimit('read')] }, () => ({ available: relay !== undefined, privacyNotice: voicePrivacyNotice, privacyVersion: config?.privacyVersion ?? null, maxCallSeconds: config?.maxCallSeconds ?? null }));
  app.get<{ Params: { sessionId: string } }>('/sessions/:sessionId/voice', {
    websocket: true, schema: { params: { type: 'object', required: ['sessionId'], additionalProperties: false, properties: { sessionId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' } } } },
  }, (socket, request) => {
    if (!relay) { socket.close(4503, 'voice-disabled'); return; }
    relay.serve(socket, request.params.sessionId, request.headers.origin, request.log);
  });
  // Explicit HTTP availability check for clients before asking for microphone access.
  app.get<{ Params: { sessionId: string } }>('/sessions/:sessionId/voice-access', {
    preHandler: [app.requireAuth, app.requireVerifiedEmail, app.enforceRateLimit('stream')],
    schema: { params: { type: 'object', required: ['sessionId'], additionalProperties: false, properties: { sessionId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' } } } },
  }, async request => {
    if (!relay || !config) throw unavailable();
    const access = await relay.access(authenticatedUser(request).uid, request.params.sessionId);
    return { privacyVersion: config.privacyVersion, maxCallSeconds: access.maxCallSeconds };
  });
  app.addHook('preClose', async () => relay?.closeAll());
}
