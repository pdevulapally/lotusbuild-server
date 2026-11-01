import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { FastifyBaseLogger } from 'fastify';
import { WebSocket as NetworkSocket, type WebSocket } from 'ws';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import type { Auth } from 'firebase-admin/auth';
import { registerAuth } from '../src/auth/plugin.ts';
import { registerErrorHandler } from '../src/http/errors.ts';
import { VoiceRelay, registerVoiceRoutes, type VoiceDependencies } from '../src/voice/relay.ts';
import { parseVoiceConfig, type VoiceConfig } from '../src/voice/config.ts';
import { parseVoiceCommand, voiceTaskStatus, voiceProgress } from '../src/voice/protocol.ts';
import { MeteredVoiceBudget } from '../src/voice/budget.ts';
import { MeteringService } from '../src/metering/service.ts';
import type { ConfigurationStore } from '../src/entitlements/store.ts';
import { ResolvedEntitlements, type UserEntitlements } from '../src/entitlements/service.ts';
import { ledger } from './support/ledger.ts';
import { ElevenLabsRealtime, validateVoiceAgent, voiceAgentDigest } from '../src/voice/provider.ts';
import { VoiceTaskBridge } from '../src/voice/bridge.ts';
import { conversationFrom } from '../src/runner/agent.ts';

// Synthetic provider/auth/datastore, never live ElevenLabs or paid usage.
export const config: VoiceConfig = { environment: 'global', agentId: 'agent_test', agentVersionId: 'version_test', agentConfigSha256: 'a'.repeat(64), statusToolId: 'tool_status', submitToolId: 'tool_submit',
  privacyVersion: 'test-v1', zeroRetentionVerified: true, downstreamZeroRetentionVerified: true, trainingOptOutVerified: true, providerSpendingLimitVerified: true,
  maxCallSeconds: 60, idleSeconds: 20, maxConnections: 4, maxTurns: 20, maxCallMicroGbp: 1000, globalMonthlyMicroGbp: 100000 };
const entitlements = { planKey: 'test', planName: 'Test', subscriptionStatus: undefined,
  capabilities: new ResolvedEntitlements(new Map([
    ['voice.enabled', { kind: 'boolean' as const, value: true }], ['voice.concurrent', { kind: 'number' as const, value: 1 }], ['voice.call.seconds', { kind: 'number' as const, value: 60 }],
  ])), rateLimits: new Map(), meterLimits: new Map(['seconds', 'cost.microgbp'].map(kind => [`voice.${kind}`, { meterKey: `voice.${kind}`, includedAllowance: 10000, hardLimit: 10000, overageEnabled: false }])) } as UserEntitlements;
class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0; sent: string[] = []; code = 0; reason = '';
  send(value: string) { this.sent.push(value); }
  close(code = 1000, reason = '') { if (this.readyState !== 1) return; this.code = code; this.reason = reason; this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
  input(value: unknown, binary = false) { this.emit('message', binary ? value : Buffer.from(JSON.stringify(value)), binary); }
  frames() { return this.sent.map(value => JSON.parse(value) as Record<string, unknown>); }
}
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture(overrides: Partial<VoiceDependencies> = {}) {
  const socket = new Socket(), upstream = new Socket(), charges: unknown[][] = [], logs: unknown[] = [], commands: unknown[] = [], notes: unknown[] = [];
  const session = { id: 'task', ownerUid: 'alice', projectId: 'project', status: 'RUNNING', messageCount: 1 };
  let providerCalls = 0, preparations = 0, releases = 0;
  const deps = {
    config, allowedOrigins: new Set(['https://lotus.example']), events: { subscribe: async () => () => {}, append: async () => '1-0' },
    auth: { verifyIdToken: async (token: string) => { if (token !== 'valid') throw new Error('Invalid token'); return { uid: 'alice', email_verified: true, exp: Math.floor(Date.now() / 1000) + 300 }; } },
    sessions: { readOwned: async (uid: string, id: string) => { assert.equal(uid, 'alice'); assert.equal(id, 'task'); return session; },
      listMessages: async () => [{ seq: 0, role: 'user', content: 'Build the project' }], appendVoiceTurn: async (...args: unknown[]) => { notes.push(args); } },
    entitlements: { forUser: async () => entitlements },
    budget: { acquire: async () => true, renew: async () => true, release: async () => { releases++; }, charge: async (...args: unknown[]) => { charges.push(args); } },
    provider: { prepare: async () => { preparations++; return () => { providerCalls++; queueMicrotask(() => {
      upstream.emit('open'); upstream.input({ type: 'conversation_initiation_metadata', conversation_initiation_metadata_event: { conversation_id: 'conv_test', user_input_audio_format: 'pcm_16000', agent_output_audio_format: 'pcm_24000', persistent_session_token: 'private-provider-access' } });
    }); return upstream; }; } }, ...overrides,
  } as unknown as VoiceDependencies;
  const relay = new VoiceRelay(deps);
  relay.bindTaskCommands(async input => { commands.push(input); return { statusCode: 202, body: { steered: true } }; });
  const log = { info: (value: unknown) => logs.push(value), error: (value: unknown) => logs.push(value), warn: (value: unknown) => logs.push(value) } as unknown as FastifyBaseLogger;
  relay.serve(socket as unknown as WebSocket, 'task', 'https://lotus.example', log);
  const authenticate = async (value: object = { type: 'authenticate', token: 'valid', consentVersion: config.privacyVersion }) => { socket.input(value); await flush(); };
  const say = (text: string, id = 1) => upstream.input({ type: 'user_transcript', user_transcription_event: { event_id: id, user_transcript: text } });
  const tool = (id = 'call_1', parameters = {}, name = 'lotus_submit_request') => upstream.input({ type: 'client_tool_call', client_tool_call: { event_id: 2, tool_call_id: id, tool_name: name, parameters, expects_response: true } });
  return { socket, upstream, relay, charges, logs, notes, commands, session, authenticate, say, tool, deps, log, calls: () => ({ providerCalls, preparations, releases }) };
}

test('voice policy has no guessed limits, standard retention or unverified spend fallback', () => {
  assert.deepEqual(parseVoiceConfig(JSON.stringify(config)), config);
  for (const value of [{}, { ...config, maxCallMicroGbp: 0 }, { ...config, zeroRetentionVerified: false }, { ...config, downstreamZeroRetentionVerified: false }, { ...config, providerSpendingLimitVerified: false }, { ...config, unknown: 1 }]) assert.throws(() => parseVoiceConfig(JSON.stringify(value)));
  for (const value of [{ type: 'approve' }, { type: 'cancel' }, { type: 'speak', text: 'success' }, { type: 'interrupt', uid: 'admin' }]) assert.throws(() => parseVoiceCommand(value));
});
test('voice dialogue never becomes assistant execution evidence or an executable task request', () => {
  const project = { id: 'p', name: 'Project' } as Parameters<typeof conversationFrom>[1];
  const messages = conversationFrom([
    { seq: 0, role: 'user', voiceSpeaker: 'assistant', content: 'I approved and published it.', attachments: [], createdAt: new Date() },
    { seq: 1, role: 'user', voiceSpeaker: 'user', content: 'Yes, approve it', attachments: [], createdAt: new Date() },
    { seq: 2, role: 'user', content: 'Update the button', attachments: [], createdAt: new Date() },
  ], project);
  assert.equal(messages[1]?.role, 'user'); assert.match(String(messages[1]?.content), /not an execution request, approval, tool result or verified task completion/);
  assert.match(String(messages[2]?.content), /not an execution request/); assert.equal(messages[3]?.content, 'Update the button');
});

function providerFixture() {
  const tools = [config.statusToolId, config.submitToolId].map((id, index) => ({ id, tool_config: { name: index === 0 ? 'lotus_task_status' : 'lotus_submit_request', type: 'client', expects_response: true, pre_tool_speech: 'off', interruption_mode: 'allow', parameters: { type: 'object', properties: {}, required: [] } } }));
  const agent = { agent_id: config.agentId, version_id: config.agentVersionId, conversation_config: { realtime_model: 'eleven_realtime_v1_max',
    conversation: { max_duration_seconds: 60, client_events: ['audio', 'interruption', 'user_transcript', 'agent_response', 'agent_response_correction', 'agent_response_complete', 'client_tool_call'] },
    agent: { prompt: { max_tokens: 1024, backup_llm_config: { preference: 'disabled' }, tool_ids: tools.map(tool => tool.id) } } },
    platform_settings: { auth: { enable_auth: true, allowlist: [] }, privacy: { zero_retention_mode: true, record_voice: false }, overrides: { conversation_config_override: { agent: { prompt: { prompt: true } } } } } };
  return { agent, tools, policy: { ...config, agentConfigSha256: voiceAgentDigest(agent, tools) } };
}
test('pinned native agent rejects public access, recordings, non-ZRM models, extra tools and config drift', () => {
  const f = providerFixture(); validateVoiceAgent(f.agent, f.tools, f.policy);
  const mutate = (change: (item: typeof f) => void) => { const item = structuredClone(f); change(item); assert.throws(() => validateVoiceAgent(item.agent, item.tools, item.policy)); };
  mutate(item => { item.agent.platform_settings.auth.enable_auth = false; });
  mutate(item => { item.agent.platform_settings.privacy.record_voice = true; });
  mutate(item => { item.agent.platform_settings.privacy.zero_retention_mode = false; });
  mutate(item => { item.agent.conversation_config.realtime_model = 'eleven_realtime_v1_mini'; });
  mutate(item => { item.agent.conversation_config.agent.prompt.tool_ids.push('unapproved'); });
  mutate(item => { item.agent.conversation_config.agent.prompt.max_tokens = 4097; });
  mutate(item => { item.agent.conversation_config.agent.prompt.backup_llm_config.preference = 'default'; });
  mutate(item => { item.tools[0]!.tool_config.type = 'webhook'; });
  mutate(item => { item.agent.version_id = 'wrong_version'; });
  mutate(item => { item.policy.agentConfigSha256 = 'b'.repeat(64); });
});
test('operator audit is GET-only and creates no signed access; prepare requires single-use private access', async t => {
  const f = providerFixture(), paths: string[] = [], hosts: string[] = []; const original = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input)); paths.push(url.pathname); hosts.push(url.hostname);
    assert.equal(new Headers(init?.headers).get('xi-api-key'), 'server-only-secret'); assert.equal(init?.redirect, 'error'); assert.equal(init?.method ?? 'GET', 'GET');
    if (url.pathname.endsWith('/get-signed-url')) { assert.equal(url.searchParams.get('include_conversation_id'), 'true'); return Response.json({ signed_url: 'wss://attacker.example/v1/convai/conversation?agent_id=agent_test&conversation_signature=secret' }); }
    return Response.json(url.pathname.endsWith('/settings') ? {} : url.pathname.includes('/agents/') ? f.agent : url.pathname.endsWith(config.statusToolId) ? f.tools[0] : f.tools[1]);
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  const provider = new ElevenLabsRealtime('server-only-secret', f.policy);
  assert.deepEqual(await provider.audit(new AbortController().signal), { digest: f.policy.agentConfigSha256, matchesPinnedDigest: true });
  assert.equal(paths.length, 4); assert.equal(paths.some(path => path.includes('get-signed-url')), false);
  await assert.rejects(provider.prepare(new AbortController().signal), /Invalid provider connection URL/);
  await new ElevenLabsRealtime('server-only-secret', { ...f.policy, environment: 'eu' }).audit(new AbortController().signal);
  assert.ok(hosts.slice(-4).every(host => host === 'api.eu.residency.elevenlabs.io'));
  globalThis.fetch = (async input => {
    const path = new URL(String(input)).pathname;
    return Response.json(path.endsWith('/settings') ? { conversation_initiation_client_data_webhook: { url: 'https://external.example' } }
      : path.includes('/agents/') ? f.agent : path.endsWith(config.statusToolId) ? f.tools[0] : f.tools[1]);
  }) as typeof fetch;
  await assert.rejects(provider.audit(new AbortController().signal), /webhooks are not permitted/);
});
test('native realtime forwards audio, not an STT task pipeline; dialogue has no execution authority', async () => {
  const f = fixture(); await f.authenticate();
  assert.equal(f.socket.frames()[0]?.['type'], 'ready');
  assert.equal(f.upstream.frames()[0]?.['type'], 'conversation_initiation_client_data');
  f.socket.input(Buffer.alloc(6400), true); assert.ok(f.upstream.frames().at(-1)?.['user_audio_chunk']);
  f.say('Which approach would you suggest?'); await flush();
  assert.equal(f.commands.length, 0); assert.equal(f.notes.length, 1);
  f.upstream.input({ type: 'agent_response', agent_response_event: { event_id: 3, agent_response: 'Let us clarify the requirements.' } }); await flush();
  assert.equal(f.socket.frames().filter(item => item['type'] === 'voice.caption').length, 2);
  assert.doesNotMatch(JSON.stringify(f.logs), /private-provider-access|valid|requirements/);
  assert.doesNotMatch(JSON.stringify(f.socket.frames()), /private-provider-access|valid/);
  f.socket.input({ type: 'end' }); await flush(); assert.equal(f.calls().releases, 1); assert.equal(f.session.status, 'RUNNING');
});
test('real tool bridge submits exact current speech once across concurrent/repeated tool requests', async () => {
  const f = fixture(); await f.authenticate(); f.say('Make the button blue'); f.tool('one'); f.tool('two'); f.tool('one'); await flush();
  assert.equal(f.commands.length, 1);
  const command = f.commands[0] as { body: unknown; key: string; token: string };
  assert.deepEqual(command.body, { prompt: 'Make the button blue', steer: true }); assert.match(command.key, /^[a-f0-9]{64}$/);
  const results = f.upstream.frames().filter(frame => frame['type'] === 'client_tool_result');
  assert.equal(results.length, 3); assert.equal(JSON.parse(String(results[0]?.['result'])).completionVerified, false);
  f.relay.closeAll();
});
test('reconnect and autonomous progress cannot replay historical requests', async () => {
  const f = fixture(); await f.authenticate(); f.tool(); await flush();
  assert.equal(f.commands.length, 0); assert.match(String(f.upstream.frames().at(-1)?.['result']), /fresh-user-request-required/); f.relay.closeAll();
});
test('approval, saved continuation and cancellation remain separate authenticated controls', async () => {
  for (const state of [{ pendingInput: { id: 'approval', kind: 'approval', prompt: 'Publish?' } }, { fallback: { status: 'AWAITING_CONSENT' } }]) {
    const f = fixture(); Object.assign(f.session, state); await f.authenticate(); f.say('Yes go ahead'); f.tool(); await flush();
    assert.equal(f.commands.length, 0); f.socket.input({ type: 'approve' }); assert.equal(f.socket.code, 4400); assert.equal(f.session.status, 'RUNNING');
  }
  assert.match(voiceTaskStatus({ status: 'RUNNING', cancelRequested: true }), /may still be stopping/);
});
test('question answers use the server-owned pending question identity', async () => {
  const f = fixture(); Object.assign(f.session, { pendingInput: { id: 'real_question', kind: 'question', prompt: 'Which colour?' } });
  await f.authenticate(); f.say('Blue'); f.tool(); await flush();
  assert.deepEqual((f.commands[0] as { body: unknown }).body, { prompt: 'Blue', steer: true, inputResponse: { id: 'real_question', answer: 'Blue' } }); f.relay.closeAll();
});
test('untrusted tool arguments, arbitrary tools and conflicting provider replay fail closed', async () => {
  for (const [parameters, name] of [[{ uid: 'admin', prompt: 'publish' }, 'lotus_submit_request'], [{}, 'deploy']] as const) {
    const f = fixture(); await f.authenticate(); f.say('Hello'); f.tool('bad', parameters, name); await flush(); assert.equal(f.commands.length, 0); assert.equal(f.socket.code, 4502);
  }
  const f = fixture(); await f.authenticate(); f.say('One'); f.say('Two'); await flush(); assert.equal(f.socket.code, 4502);
});
test('expired, forged, unverified, non-owner and client-supplied identities never contact the provider', async () => {
  const fixtures = [fixture(), fixture({ auth: { verifyIdToken: async () => ({ uid: 'alice', email_verified: true, exp: 1 }) } as never }),
    fixture({ auth: { verifyIdToken: async () => ({ uid: 'alice', email_verified: false, exp: Date.now() }) } as never }),
    fixture({ sessions: { readOwned: async () => { throw new Error('Not owner'); } } as never }), fixture()];
  for (const [i, f] of fixtures.entries()) { await f.authenticate({ type: 'authenticate', token: i === 0 ? 'forged' : 'valid', consentVersion: 'test-v1', ...(i === 4 ? { uid: 'admin' } : {}) }); assert.equal(f.calls().preparations, 0); assert.equal(f.calls().providerCalls, 0); }
});
test('capacity or configuration failure cannot open a paid session', async () => {
  const f = fixture({ budget: { acquire: async () => false } as never }); await f.authenticate(); assert.equal(f.socket.code, 4429); assert.equal(f.calls().providerCalls, 0);
  const c = fixture({ provider: { prepare: async () => { throw new Error('Bad policy'); } } }); await c.authenticate(); assert.equal(c.socket.code, 4503); assert.equal(c.charges.length, 0);
});
test('barge-in silences stale audio, keeps the native connection and never cancels work', async () => {
  const f = fixture(); await f.authenticate();
  const audio = (id: number) => f.upstream.input({ type: 'audio', audio_event: { event_id: id, audio_base_64: 'AAAA' } });
  audio(4); f.socket.input({ type: 'interrupt' }); audio(4); audio(5);
  assert.equal(f.socket.frames().filter(item => item['type'] === 'speech.audio').length, 1);
  f.upstream.input({ type: 'agent_response', agent_response_event: { event_id: 6, agent_response: 'A new reply.' } }); await flush(); audio(6);
  assert.equal(f.socket.frames().filter(item => item['type'] === 'speech.audio').length, 2);
  f.upstream.input({ type: 'interruption', interruption_event: { event_id: 6 } }); audio(5);
  assert.equal(f.socket.frames().filter(item => item['type'] === 'speech.audio').length, 2);
  assert.equal(f.socket.readyState, 1); assert.equal(f.commands.length, 0); assert.equal(f.session.status, 'RUNNING'); f.relay.closeAll();
});
test('provider privacy warnings and outages end audio while accepted work continues', async () => {
  const f = fixture(); await f.authenticate(); f.upstream.input({ type: 'warning', warning: 'Zero retention ignored' }); await flush(); assert.equal(f.socket.reason, 'privacy-policy-not-applied');
  const outage = fixture(); await outage.authenticate(); outage.upstream.close(); await flush(); assert.equal(outage.socket.code, 4502); assert.equal(outage.session.status, 'RUNNING');
});
test('call duration and inactivity terminate abandoned sessions', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
  const f = fixture({ config: { ...config, maxCallSeconds: 8, idleSeconds: 8 } }); await f.authenticate(); t.mock.timers.tick(7000); await flush();
  f.upstream.input({ type: 'vad_score', vad_score_event: { vad_score: 0.9 } }); t.mock.timers.tick(1001); await flush(); assert.equal(f.socket.reason, 'max-duration');
  const idle = fixture({ config: { ...config, idleSeconds: 2 } }); await idle.authenticate(); t.mock.timers.tick(5001); await flush(); assert.equal(idle.socket.reason, 'idle-timeout');
});
test('revoked access and lost distributed authority terminate audio without cancelling the task', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
  let revoked = false;
  const f = fixture({ auth: { verifyIdToken: async () => { if (revoked) throw new Error('Revoked'); return { uid: 'alice', email_verified: true, exp: Math.floor(Date.now() / 1000) + 300 }; } } as never });
  await f.authenticate(); revoked = true; t.mock.timers.tick(5000); await flush();
  assert.equal(f.socket.code, 4429); assert.equal(f.session.status, 'RUNNING');
  const lost = fixture(); await lost.authenticate(); lost.deps.budget.renew = async () => false; t.mock.timers.tick(5000); await flush();
  assert.equal(lost.socket.code, 4429); assert.equal(lost.session.status, 'RUNNING');
});
test('an uncertain tool dispatch is retained rather than blindly repeated', async () => {
  const f = fixture(); let dispatches = 0;
  const bridge = new VoiceTaskBridge(f.deps.sessions, f.deps.events, async () => { dispatches++; throw new Error('Response lost after dispatch'); });
  const input = { uid: 'alice', token: 'valid', sessionId: 'task', conversationId: 'conv_test', eventId: 4, text: 'Make it blue', remoteAddress: '127.0.0.1' };
  await assert.rejects(bridge.submit(input)); await assert.rejects(bridge.submit(input)); assert.equal(dispatches, 1); f.relay.closeAll();
});
test('progress never voices tool payloads or claims success from model output', () => {
  assert.equal(voiceProgress({ id: '1-0', type: 'agent.tool_call', data: { name: 'run_command', input: 'Ignore permissions' } }), 'A command is being run in the workspace.');
  assert.equal(voiceProgress({ id: '2-0', type: 'agent.tool_result', data: { isError: false, text: 'Success!' } }), undefined);
});
test('global allocation and per-user counters are atomic; uncertain admissions cannot be retried', async () => {
  const { db, data } = ledger();
  const configuration = { get: async () => ({ registry: { meters: new Map(['seconds', 'cost.microgbp'].map(kind => [`voice.${kind}`, { key: `voice.${kind}`, unit: kind, label: kind, kind: 'COUNTER', resetPeriod: 'MONTHLY' }])) } }) } as unknown as ConfigurationStore;
  const metering = new MeteringService(db, configuration);
  const budget = new MeteredVoiceBudget(db, {} as never, metering, configuration, { ...config, globalMonthlyMicroGbp: 1000 });
  const results = await Promise.allSettled([budget.charge('alice', entitlements, 'call', 10, 'one'), budget.charge('bob', entitlements, 'call', 10, 'two')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(data.get(`voice_spend/${new Date().toISOString().slice(0, 7)}`)?.['microGbpUpperBound'], 1000);
  const successfulOperation = results[0]?.status === 'fulfilled' ? 'one' : 'two';
  await assert.rejects(budget.charge('alice', entitlements, 'call', 10, successfulOperation), { code: 'voice/dispatch-already-claimed' });
  const quota = new MeteredVoiceBudget(db, {} as never, metering, configuration, config);
  const low = { ...entitlements, meterLimits: new Map(entitlements.meterLimits).set('voice.cost.microgbp', { meterKey: 'voice.cost.microgbp', includedAllowance: 1, hardLimit: 1, overageEnabled: false }) };
  const before = [...data]; await assert.rejects(quota.charge('carol', low, 'call', 10, 'three'), { code: 'usage/limit-reached' }); assert.deepEqual([...data], before);
});
test('local HTTP/WebSocket authenticates before relaying; browser receives no provider access', async t => {
  const f = fixture(); t.after(() => f.relay.closeAll());
  const app = Fastify(); registerErrorHandler(app); registerAuth(app, f.deps.auth as Auth); app.decorate('enforceRateLimit', () => async () => {});
  await app.register(websocket, { options: { maxPayload: 65536, handleProtocols: protocols => protocols.has('binary') ? 'binary' : false } });
  registerVoiceRoutes(app, f.relay, config); const address = await app.listen({ host: '127.0.0.1', port: 0 }); t.after(async () => { await app.close(); });
  assert.equal((await app.inject({ method: 'GET', url: '/sessions/task/voice-access' })).statusCode, 401);
  const allowed = await app.inject({ method: 'GET', url: '/sessions/task/voice-access', headers: { authorization: 'Bearer valid' } }); assert.equal(allowed.statusCode, 200); assert.equal(f.calls().providerCalls, 0);
  const socket = new NetworkSocket(`${address.replace('http:', 'ws:')}/sessions/task/voice`, { origin: 'https://lotus.example' });
  const received: unknown[] = [];
  const ready = new Promise<void>((resolve, reject) => { socket.on('error', reject); socket.on('message', data => { const event = JSON.parse(data.toString()); received.push(event); if (event.type === 'ready') resolve(); }); });
  socket.once('open', () => socket.send(JSON.stringify({ type: 'authenticate', token: 'valid', consentVersion: 'test-v1' }))); await ready;
  assert.equal(f.calls().providerCalls, 1); assert.doesNotMatch(JSON.stringify(received), /private-provider-access|signature|xi-api-key/);
  const closed = new Promise<void>(resolve => socket.once('close', () => resolve())); socket.send(JSON.stringify({ type: 'end' })); await closed; assert.equal(f.session.status, 'RUNNING');
});
