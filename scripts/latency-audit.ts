/** Offline, sequential single-user diagnostic. Never initializes Firebase, Redis or provider clients. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { EventEmitter } from 'node:events';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import type { Auth } from 'firebase-admin/auth';
import type { Redis } from 'ioredis';
import type Anthropic from '@anthropic-ai/sdk';
import { SandboxService } from '../src/sandboxes/service.ts';
import type { RunningSandbox, SandboxAdapter } from '../src/sandboxes/provider.ts';
import { ledger } from '../test/support/ledger.ts';
import { fixtureModels } from '../test/support/models.ts';
import { registryDocument, planDocuments } from '../src/seed/config.ts';
import { ConfigurationStore } from '../src/entitlements/store.ts';
import { EntitlementService } from '../src/entitlements/service.ts';
import { SubscriptionCache } from '../src/entitlements/subscription-cache.ts';
import { MeteringService } from '../src/metering/service.ts';
import { ProjectRepository } from '../src/projects/repository.ts';
import type { UserRepository } from '../src/users/repository.ts';
import { SessionRepository } from '../src/sessions/repository.ts';
import { SessionEvents } from '../src/sessions/events.ts';
import { registerAuth } from '../src/auth/plugin.ts';
import { registerErrorHandler } from '../src/http/errors.ts';
import { registerRateLimiting } from '../src/http/rate-limit.ts';
import { registerProjectRoutes } from '../src/projects/routes.ts';
import { registerSessionRoutes } from '../src/sessions/routes.ts';
import { runUntilStopped, SessionRunner, type RunnerDependencies } from '../src/runner/loop.ts';
import { installHttpTimings, timingContext, timed, observeMethods, type TimingRecord } from '../src/diagnostics/timing.ts';

const pollSeconds = Number(process.argv[3]);
if (!Number.isSafeInteger(pollSeconds) || pollSeconds < 1 || pollSeconds > 300) throw new Error('Provide an explicit local poll interval from 1 to 300 seconds as the third argument.');
const records: TimingRecord[] = [];
const elapsed: Record<string, number[]> = {};
const phases: Record<string, TimingRecord[]> = {};
const operations: Record<string, Record<string, number>> = {};
let currentOperations: Record<string, number> = {};
function operation(name: string) { currentOperations[name] = (currentOperations[name] ?? 0) + 1; }
async function sample<T>(name: string, run: () => Promise<T>): Promise<T> {
  currentOperations = {}; const offset = records.length; const start = performance.now();
  const result = await run(); (elapsed[name] ??= []).push(performance.now() - start);
  (phases[name] ??= []).push(...records.slice(offset));
  const counts = operations[name] ??= {}; for (const [key, value] of Object.entries(currentOperations)) counts[key] = (counts[key] ?? 0) + value;
  return result;
}
function summary(values: number[]) { const sorted = [...values].sort((a,b) => a-b); const at = (p: number) => +(sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? 0).toFixed(3);
  return { n: values.length, minMs: +Math.min(...values).toFixed(3), medianMs: at(.5), p95Ms: at(.95), maxMs: +Math.max(...values).toFixed(3) }; }

// Count adapter calls, not network RTTs. No delay is injected into request samples.
const h = ledger(); const raw = h.db;
const db = new Proxy(raw, { get(target, key) {
  if (key === 'doc') return (path: string) => { const ref = target.doc(path); return new Proxy(ref, { get(t,k) { if (k === 'get') return async () => { operation('firestore.document.get'); return t.get(); }; const v = Reflect.get(t,k,t); return typeof v === 'function' ? v.bind(t) : v; } }); };
  if (key === 'collection') return (path: string) => { const collection = target.collection(path); return new Proxy(collection, { get(t,k) { if (k === 'get') return async () => { operation('firestore.collection.get'); return t.get(); }; const v = Reflect.get(t,k,t); return typeof v === 'function' ? v.bind(t) : v; } }); };
  if (key === 'runTransaction') return <T>(run: Parameters<Firestore['runTransaction']>[0]) => { operation('firestore.transaction'); return target.runTransaction(run) as Promise<T>; };
  const value = Reflect.get(target,key,target); return typeof value === 'function' ? value.bind(target) : value;
} });
h.data.set('config/registry', registryDocument);
for (const plan of planDocuments) h.data.set(`plans/${plan.key}`, plan);
h.data.set('subscriptions/audit-user', { planKey: 'business', status: 'ACTIVE', currentPeriodStart: Timestamp.fromMillis(Date.now()-100000), currentPeriodEnd: Timestamp.fromMillis(Date.now()+86400000) });
const cacheData = new Map<string,string>();
const redis = { get: async (key: string) => { operation('redis.get'); return cacheData.get(key) ?? null; },
  set: async (key: string, value: string) => { operation('redis.set'); if (cacheData.has(key)) return null; cacheData.set(key,value); return 'OK'; },
  del: async (key: string) => { operation('redis.del'); return Number(cacheData.delete(key)); },
  eval: async (_script: string, _count: number, key: string, token: string, value: string) => { operation('redis.eval'); if (cacheData.get(key) !== token) return 0; cacheData.set(key,value); return 1; },
  publish: async (channel: string, payload: string) => { bus.emit('message', channel, payload); return 1; },
} as unknown as Redis;
const config = new ConfigurationStore(db, 60000);
const cache = new SubscriptionCache(redis, 60);
const entitlements = observeMethods(new EntitlementService(db, config, cache), { forUser: 'entitlements.resolve' });
const metering = new MeteringService(db, config);
const projects = observeMethods(new ProjectRepository(db, {} as UserRepository, entitlements), { listOwnedBy: 'project.list', readOwned: 'project.read' });
const sessions = observeMethods(new SessionRepository(db, projects, entitlements, config, metering, 60), { create: 'session.admit', claim: 'session.claim', readOwned: 'session.read' });
const bus = Object.assign(new EventEmitter(), { subscribe: async () => 1, unsubscribe: async () => 0 });
const events = new SessionEvents(redis, bus as unknown as Redis, { firestore: db, maxEventBytes: 4096, retentionSeconds: 3600, maxPerSession: 200, onListenerError: () => assert.fail('listener error') });
const app = Fastify({ logger: false });
installHttpTimings(app, (record) => records.push(record));
registerAuth(app, { verifyIdToken: async () => ({ uid: 'audit-user', email_verified: true, auth_time: Date.now()/1000, exp: Date.now()/1000+3600 }) } as unknown as Auth);
registerErrorHandler(app);
void app.register(rateLimit, { global: false }); // Local memory adapter, actual per-plan checker below.
registerRateLimiting(app, entitlements);
void app.register(async api => {
  registerProjectRoutes(api, projects);
  registerSessionRoutes(api, sessions, events, { heartbeatSeconds: 1, maxConnections: 5, maxConnectionsPerUser: 5, maxBufferedBytes: 100000, reauthenticate: async () => {} });
});
const cpuStart = process.cpuUsage(); const eluStart = performance.eventLoopUtilization(); const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
const boot = performance.now(); const address = await app.listen({ host: '127.0.0.1', port: 0 }); const bootMs = performance.now()-boot;
const headers = { authorization: 'Bearer offline-fixture-token' };
const request = async (path: string, init: RequestInit = {}) => {
  const response = await fetch(address+path, { ...init, headers: { ...headers, ...init.headers } }); const body: unknown = await response.json();
  assert.ok(response.ok, JSON.stringify({ status: response.status, body })); return body;
};
try {
  // 3 independent cache-cold sequences followed by 10 sequential warm samples each.
  for (let cycle = 0; cycle < 3; cycle++) {
    config.invalidate(); await cache.invalidate('audit-user');
    await sample(cycle === 0 ? 'GET projects process-first' : 'GET projects cache-cold', () => request('/projects'));
    for (let index = 0; index < 10; index++) await sample('GET projects warm', () => request('/projects'));
  }
  for (let index = 0; index < 10; index++) {
    const id = `audit-${index}`;
    h.data.set(`projects/${id}`, { ownerUid: 'audit-user', name: 'Audit', platform: 'web', status: 'draft', activeSessionId: null, snapshotBytes: 0, createdAt: Timestamp.now() });
    const account = await entitlements.forUser('audit-user'); const model = account.capabilities.stringList('ai.model.allowlist')[0]; assert.ok(model);
    const session = await sample(index === 0 ? 'POST session first' : 'POST session repeated', () => request(`/projects/${id}/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `audit-command-${index.toString().padStart(16,'0')}` }, body: JSON.stringify({ prompt: 'Offline audit fixture', model }) })) as { id: string };
    const claimed = await sample('direct claim (no poll sleep)', () => timingContext(record => records.push(record), () => sessions.claim('offline-audit'))); assert.equal(claimed?.id, session.id); assert.ok(claimed);
    await sessions.finish(session.id, { sessionId: session.id, runnerId: 'offline-audit', token: claimed.leaseToken }, { status: 'IDLE' });
  }
  h.data.set('sessions/replay-audit', { ownerUid: 'audit-user', projectId: 'audit-0', status: 'IDLE' });
  for (const count of [1,10,100]) {
    const existing = (await events.history('replay-audit', undefined)).length;
    for (let index = existing; index < count; index++) await events.append('replay-audit', 'agent.step', { index });
    for (let run = 0; run < 10; run++) await sample(`journal replay ${count} entries`, () => events.history('replay-audit', undefined));
  }
  // Actual loopback HTTP stream, durable journal and pubsub catch-up; no Caddy in this test.
  const source = [...h.data].find(([key]) => key.startsWith('sessions/') && key.split('/').length === 2)?.[1]; assert.ok(source);
  h.data.set('sessions/stream-audit', { ...source, eventSequence: 0, eventTime: 0 });
  const abort = new AbortController();
  const stream = await fetch(address+'/sessions/stream-audit/events', { headers, signal: abort.signal });
  assert.equal(stream.status, 200); assert.ok(stream.body);
  const reader = stream.body.getReader(); const decoder = new TextDecoder();
  await reader.read(); // Consume initial authoritative state, outside delivery measurements.
  try {
    for (let index = 0; index < 10; index++) await sample('append to observed SSE bytes (loopback)', async () => {
      const marker = `audit-marker-${index}`;
      await events.append('stream-audit', 'agent.text', { delta: marker });
      let text = '';
      while (!text.includes(marker)) { const chunk = await reader.read(); assert.equal(chunk.done, false); text += decoder.decode(chunk.value, { stream: true }); }
    });
  } finally { abort.abort(); await reader.cancel().catch(() => {}); }
  // Controlled model stream measures our coalescing timer, not provider performance.
  for (let run = 0; run < 3; run++) {
    const projectId = `worker-audit-${run}`;
    h.data.set(`projects/${projectId}`, { ownerUid: 'audit-user', name: 'Audit', platform: 'web', status: 'draft', activeSessionId: null, snapshotBytes: 0, createdAt: Timestamp.now() });
    const account = await entitlements.forUser('audit-user'); const model = account.capabilities.stringList('ai.model.allowlist')[0]; assert.ok(model);
    const accepted = await sessions.create('audit-user', projectId, { prompt: 'Controlled text fixture', model });
    let emitted = 0; let observed = 0;
    const unsubscribe = await events.subscribe(accepted.id, event => { if (event.type === 'agent.text' && observed === 0) observed = performance.now(); });
    const adapter: SandboxAdapter = {
      start: async (_provider, context) => {
        const running: RunningSandbox = { externalId: `audit-vm-${run}`, lifetime: async () => ({ startedAt: new Date(Date.now()-1000), endAt: new Date(Date.now()+59000) }),
          readFile: async () => '', writeFile: async () => {}, runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
          stopCommands: async () => {}, stop: async () => {}, previewUrl: () => 'https://preview.invalid' };
        assert.ok(context.lifecycle); await context.lifecycle.beforeCreate(); await context.lifecycle.created(running); return running;
      }, connect: async () => undefined, terminate: async () => true,
    };
    const anthropic = { messages: { countTokens: async () => ({ input_tokens: 5 }), stream: () => {
      const listeners = new Map<string, (...args: unknown[]) => void>();
      return { on: (event: string, listener: (...args: unknown[]) => void) => { listeners.set(event,listener); }, finalMessage: async () => {
        await new Promise(resolve => setTimeout(resolve,5)); emitted = performance.now(); listeners.get('text')?.('Controlled first text.');
        await new Promise(resolve => setTimeout(resolve,500));
        return { content: [{ type: 'text', text: 'Controlled first text.' }, { type: 'tool_use', id: 'controlled-finish', name: 'finish_task', input: { outcome: 'answered', summary: 'Controlled first text.', evidence: [] }, caller: { type: 'direct' } }], usage: { input_tokens: 5, output_tokens: 1 }, stop_reason: 'end_turn' };
      } };
    } } } as unknown as Anthropic;
    const runner = new SessionRunner({ runnerId: 'controlled-worker', models: fixtureModels, anthropic, sessions, projects, configuration: config, entitlements, metering,
      skills: { enabledFor: async () => [] }, attachments: { read: async () => { throw new Error('No attachments in the offline audit.'); } },
      sandboxes: new SandboxService(config,metering,new Map([['e2b',adapter]])),
      persistence: { restore: async () => 'fresh', save: async () => ({ bytes: 0, committed: false }) }, events,
      limits: { maxSteps: 4, maxOutputTokens: 20, toolOutputMaxChars: 5000, maxSpecialistConsultations: 0, specialistMaxSteps: 1, commandTimeoutMs: 1000, previewReadyTimeoutSeconds: 1 },
      heartbeatSeconds: 60, messageHistoryLimit: 100, log: { info() {}, warn() {}, error() {}, debug: (detail: { timing: TimingRecord }) => records.push(detail.timing) },
    } as unknown as RunnerDependencies);
    await sample('controlled worker total (synthetic 505ms generation)', () => runner.runOnce());
    unsubscribe(); assert.ok(observed >= emitted && emitted > 0);
    (elapsed['worker emitted text to durable event (controlled stream)'] ??= []).push(observed-emitted);
    assert.equal((await sessions.readOwned('audit-user',accepted.id)).status,'IDLE');
  }
  // Exercise the real runner polling loop, with an explicitly supplied diagnostic interval; this does not change configuration.
  for (let run = 0; run < 3; run++) {
    let readyAt = 0; let pickedAt = 0; let stopped = false; let polls = 0;
    const runner = { runOnce: async () => { if (++polls === 1) { setTimeout(() => { readyAt = performance.now(); }, 20); return false; } pickedAt = performance.now(); stopped = true; return true; } } as SessionRunner;
    await runUntilStopped(runner, { idlePollSeconds: pollSeconds, shouldContinue: () => !stopped, log: { info() {}, warn() {}, error() {} } });
    (elapsed[`poll pickup after enqueue (diagnostic ${pollSeconds}s interval)`] ??= []).push(pickedAt-readyAt);
  }
} finally { await app.close(); loop.disable(); }
const output = { capturedAt: new Date().toISOString(), scope: 'offline sequential single-user loopback; in-memory Firestore/Redis/Auth, synthetic sandbox/model; no external provider/Caddy/network calls', node: process.version,
  startup: { n: 1, fastifyListenMs: +bootMs.toFixed(3) }, measurements: Object.fromEntries(Object.entries(elapsed).map(([name, values]) => [name, summary(values)])),
  phaseMeasurements: Object.fromEntries(Object.entries(phases).map(([name, rows]) => [name, Object.fromEntries([...new Set(rows.map(row=>row.stage))].map(stage=>[stage, summary(rows.filter(row=>row.stage===stage).map(row=>row.durationMs))]))])),
  adapterOperationTotals: operations, cpuMicroseconds: process.cpuUsage(cpuStart), eventLoop: { utilization: performance.eventLoopUtilization(eluStart).utilization, delayMeanMs: loop.mean/1e6, delayP95Ms: loop.percentile(95)/1e6, delayMaxMs: loop.max/1e6 }, memory: process.memoryUsage() };
const destination = process.argv[2];
if (destination === undefined) throw new Error('Provide an output JSON path.');
await writeFile(destination, JSON.stringify(output,null,2)+'\n');
process.stdout.write(JSON.stringify({ measurements: output.measurements, eventLoop: output.eventLoop },null,2)+'\n');
