import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { Auth } from 'firebase-admin/auth';
import { WebSocket, type RawData } from 'ws';
import type { EntitlementService, UserEntitlements } from '../entitlements/service.ts';
import type { SessionEvents } from '../sessions/events.ts';
import { authenticatedUser } from '../auth/plugin.ts';
import { AppError } from '../http/errors.ts';
import type { VoiceConfig } from './config.ts';
import type { VoiceProvider } from './provider.ts';
import type { VoiceBudget } from './budget.ts';
import { parseVoiceCommand, voicePrivacyNotice } from './protocol.ts';
import { record } from './provider.ts';
import { RealtimeConversation } from './conversation.ts';
import { VoiceTaskBridge, voiceContext, type VoiceSessions, type VoiceTaskCommand } from './bridge.ts';

export interface VoiceDependencies {
  auth: Pick<Auth, 'verifyIdToken'>;
  sessions: VoiceSessions;
  events: Pick<SessionEvents, 'subscribe' | 'append'>;
  entitlements: Pick<EntitlementService, 'forUser'>;
  budget: VoiceBudget;
  provider: VoiceProvider;
  config: VoiceConfig;
  allowedOrigins: ReadonlySet<string>;
}
const bytes = (data: RawData): Buffer => Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
const unavailable = () => new AppError({ code: 'voice/configuration-required', statusCode: 503, message: 'Voice is not enabled. Continue in text.' });

/** Private realtime conversation; the existing HTTP task command route is the only execution boundary. */
export class VoiceRelay {
  readonly #active = new Set<() => void>();
  private readonly deps: VoiceDependencies;
  private command: VoiceTaskCommand | undefined;
  constructor(deps: VoiceDependencies) { this.deps = deps; }
  bindTaskCommands(command: VoiceTaskCommand): void {
    if (this.command) throw new Error('Voice task commands already bound.');
    this.command = command;
  }
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
  serve(socket: WebSocket, sessionId: string, origin: string | undefined, log: FastifyBaseLogger, remoteAddress = '127.0.0.1'): void {
    const d = this.deps;
    if (!origin || !d.allowedOrigins.has(origin)) { socket.close(4403, 'origin-not-allowed'); return; }
    if (!this.command) { socket.close(4503, 'task-bridge-unavailable'); return; }
    if (this.#active.size >= d.config.maxConnections) { socket.close(4429, 'capacity-reached'); return; }
    const execute = this.command;
    const callId = randomUUID(), opened = Date.now(), providerAbort = new AbortController();
    let uid: string | undefined, token = '', entitlements: UserEntitlements | undefined;
    let phase: 'authentication' | 'access' | 'configuration' | 'budget' | 'provider' = 'authentication';
    let upstream: WebSocket | undefined, conversation: RealtimeConversation | undefined;
    let closed = false, authenticating = false, admitted = false, ready = false, ticking = false;
    let leaseUntil = 0, paidUntil = 0, paidSeconds = 0, receivedBytes = 0, outputBytes = 0;
    let lastActivity = Date.now(), tokenExpires = 0, callLimit = d.config.maxCallSeconds, started = 0;
    let controlTokens = 10, controlAt = Date.now(), firstAudioAt: number | undefined;
    let unsubscribe: (() => void) | undefined;
    const timers: NodeJS.Timeout[] = [];
    const authority = () => !closed && admitted && Date.now() < leaseUntil && Date.now() < paidUntil && Date.now() < tokenExpires;
    const finish = (code = 1000, reason = 'call-ended') => {
      if (closed) return;
      closed = true; providerAbort.abort(); conversation?.close(); unsubscribe?.();
      for (const timer of timers) clearTimeout(timer);
      upstream?.terminate(); this.#active.delete(shutdown);
      if (admitted && uid) void d.budget.release(uid, callId).catch(() => log.error({ callId, event: 'voice.lease_release_failed' }, 'voice cleanup failed'));
      if (socket.readyState === WebSocket.OPEN) socket.close(code, reason);
      const killer = setTimeout(() => socket.terminate(), 1000); killer.unref();
      log.info({ callId, event: 'voice.closed', reason, durationMs: Date.now() - opened, inputBytes: receivedBytes, outputBytes }, 'voice call ended');
    };
    const send = (value: Readonly<Record<string, unknown>>) => {
      if (closed || socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > 256 * 1024) { finish(4413, 'slow-consumer'); return; }
      if (value['type'] === 'speech.audio') {
        outputBytes += Buffer.byteLength(String(value['audio']), 'base64');
        if (outputBytes > callLimit * 48000 * 2 + 192000) { finish(4400, 'provider-audio-limit'); return; }
        if (!firstAudioAt) { firstAudioAt = Date.now(); log.info({ callId, event: 'voice.first_audio', latencyMs: firstAudioAt - opened }, 'voice latency'); }
      }
      socket.send(JSON.stringify(value));
    };
    const shutdown = () => finish(1001, 'server-shutdown');
    this.#active.add(shutdown);
    socket.once('close', () => finish()); socket.once('error', () => finish(4500, 'connection-error'));
    timers.push(setTimeout(() => { if (!ready) finish(4401, 'authentication-or-provider-timeout'); }, 20000));
    const authenticate = async (frame: Buffer) => {
      const input = record(JSON.parse(frame.toString()));
      if (Object.keys(input).length !== 3 || input['type'] !== 'authenticate' || typeof input['token'] !== 'string' || input['token'].length > 8192 || input['consentVersion'] !== d.config.privacyVersion) throw new Error('Invalid authentication or consent.');
      token = input['token']; const verified = await d.auth.verifyIdToken(token, true);
      if (verified.email_verified !== true || verified.exp * 1000 <= Date.now()) throw new Error('Verified sign-in required.');
      uid = verified.uid; tokenExpires = verified.exp * 1000; phase = 'access';
      const access = await this.access(uid, sessionId); entitlements = access.entitlements; callLimit = access.maxCallSeconds;
      phase = 'configuration';
      const connect = await d.provider.prepare(providerAbort.signal);
      const initialContext = await voiceContext(d.sessions, uid, sessionId);
      if (closed) return;
      phase = 'budget'; admitted = await d.budget.acquire(uid, callId, access.concurrent);
      if (!admitted) { finish(4429, 'capacity-reached'); return; }
      if (closed) { await d.budget.release(uid, callId); return; }
      leaseUntil = Date.now() + 10000;
      paidSeconds = Math.min(10, callLimit);
      await d.budget.charge(uid, entitlements, 'call', paidSeconds, `${callId}:admission`);
      if (closed) return;
      started = Date.now(); paidUntil = started + paidSeconds * 1000;
      const bridge = new VoiceTaskBridge(d.sessions, d.events, execute);
      phase = 'provider'; upstream = connect();
      conversation = new RealtimeConversation(upstream, d.sessions, bridge, { uid, token, sessionId, remoteAddress }, d.config.maxTurns, {
        send, authorized: authority, activity: () => { lastActivity = Date.now(); },
        metric: (event, values) => log.info({ callId, event, ...values }, 'voice metric'),
        ready: sampleRate => { ready = true; send({ type: 'ready', callId, maxCallSeconds: callLimit, sampleRate }); log.info({ callId, event: 'voice.ready', latencyMs: Date.now() - opened }, 'voice connected'); },
        fail: reason => finish(reason === 'privacy-policy-not-applied' ? 4503 : 4502, reason),
      });
      upstream.once('error', () => finish(4502, 'provider-unavailable'));
      upstream.once('close', () => finish(4502, 'provider-disconnected'));
      upstream.once('open', () => { try { conversation?.start(initialContext); } catch { finish(4502, 'voice-context-unavailable'); } });
      unsubscribe = await d.events.subscribe(sessionId, event => conversation?.changed(event));
      if (closed) { unsubscribe(); return; }
      timers.push(setTimeout(() => finish(4410, 'max-duration'), callLimit * 1000));
      timers.push(setInterval(() => {
        if (closed || ticking) return;
        if (Date.now() >= leaseUntil || Date.now() >= tokenExpires) { finish(4401, 'voice-authority-expired'); return; }
        if (Date.now() - lastActivity > d.config.idleSeconds * 1000) { finish(4410, 'idle-timeout'); return; }
        ticking = true;
        void (async () => {
          await d.auth.verifyIdToken(token, true);
          const accessNow = await this.access(uid!, sessionId); entitlements = accessNow.entitlements;
          callLimit = Math.min(callLimit, accessNow.maxCallSeconds);
          if (Date.now() >= started + callLimit * 1000) { finish(4410, 'max-duration'); return; }
          if (!await d.budget.renew(uid!, callId)) throw new Error('Voice lease expired.');
          if (closed) return;
          leaseUntil = Date.now() + 10000;
          if (paidUntil - Date.now() < 6000) {
            const remaining = Math.floor((started + callLimit * 1000 - paidUntil) / 1000);
            if (remaining > 0) {
              const quantity = Math.min(10, remaining);
              await d.budget.charge(uid!, entitlements, 'seconds', quantity, `${callId}:seconds:${paidUntil}`);
              paidSeconds += quantity; if (!closed) paidUntil += quantity * 1000;
            }
          }
        })().catch(() => finish(4429, 'permission-or-budget-unavailable')).finally(() => { ticking = false; });
      }, 5000));
      for (const timer of timers) timer.unref();
    };
    socket.on('message', (data, binary) => {
      if (closed) return;
      const frame = bytes(data);
      if (!ready) {
        if (authenticating || binary || frame.length > 10000) { finish(4400, 'protocol-error'); return; }
        authenticating = true;
        void authenticate(frame).catch(error => {
          if (error instanceof AppError && [402, 409, 429].includes(error.statusCode)) finish(4429, 'voice-usage-limit');
          else if (phase === 'configuration') finish(4503, 'agent-configuration-required');
          else if (phase === 'authentication' || phase === 'access') finish(4401, 'authentication-or-access-failed');
          else finish(4502, 'voice-admission-unavailable');
        });
        return;
      }
      if (!authority()) { finish(4401, 'voice-authority-expired'); return; }
      if (binary) {
        receivedBytes += frame.length;
        if (!frame.length || frame.length % 2 || frame.length > 8192 || receivedBytes > paidSeconds * 32000 || receivedBytes > (Date.now() - opened) * 32 + 16000) { finish(4400, 'audio-rate-exceeded'); return; }
        conversation?.audio(frame);
      } else {
        if (frame.length > 128) { finish(4400, 'protocol-error'); return; }
        controlTokens = Math.min(10, controlTokens + (Date.now() - controlAt) / 100); controlAt = Date.now();
        if (controlTokens < 1) { finish(4429, 'control-rate-exceeded'); return; } controlTokens--;
        try { const command = parseVoiceCommand(JSON.parse(frame.toString())); if (command.type === 'end') finish(); else conversation?.interrupt(); }
        catch { finish(4400, 'protocol-error'); }
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
    relay.serve(socket, request.params.sessionId, request.headers.origin, request.log, request.ip);
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
