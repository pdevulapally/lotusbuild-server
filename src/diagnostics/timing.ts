import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { FastifyInstance } from 'fastify';

// Deliberately no inputs, outputs, URLs, tokens, user IDs or raw error messages.
export type TimingStage = 'http.total' | 'auth.verify' | 'configuration.get' | 'configuration.firestore' |
  'entitlements.resolve' | 'subscription.firestore' | 'subscription.redis.read' | 'subscription.redis.fill' | 'subscription.redis.write' |
  'session.read' | 'session.admit' | 'session.claim' | 'session.finish' | 'project.read' | 'project.list' |
  'runner.total' | 'runner.maintenance' | 'sandbox.acquire' | 'sandbox.release' | 'workspace.restore' | 'workspace.save' |
  'model.admission' | 'model.count_tokens' | 'model.first_text' | 'model.first_delta' | 'model.generation' | 'model.settle' |
  'tool.execute' | 'tool.computer' | 'events.append' | 'events.replay' | 'sse.socket_write';
export interface TimingRecord { traceId: string; stage: TimingStage; startMs: number; durationMs: number; ok: boolean }
export type TimingSink = (record: TimingRecord) => void;
interface Context { traceId: string; start: number; sink: TimingSink }
const context = new AsyncLocalStorage<Context>();
export const timingTraceId = () => context.getStore()?.traceId;
export function timingContext<T>(sink: TimingSink, run: () => T): T {
  return context.run({ traceId: randomUUID(), start: performance.now(), sink }, run);
}
export function startTiming(stage: TimingStage): (ok?: boolean) => void {
  const current = context.getStore();
  if (current === undefined) return () => {};
  const start = performance.now(); let ended = false;
  return (ok = true) => {
    if (ended) return; ended = true;
    // Diagnostics must never interfere with accounting, cancellation or results.
    try { current.sink({ traceId: current.traceId, stage, startMs: +(start - current.start).toFixed(3), durationMs: +(performance.now() - start).toFixed(3), ok }); } catch { /* Timing sink only. */ }
  };
}
export async function timed<T>(stage: TimingStage, run: () => Promise<T>): Promise<T> {
  const end = startTiming(stage);
  try { const result = await run(); end(); return result; } catch (error) { end(false); throw error; }
}
/** Service boundaries only; methods retain their original receiver and private fields. */
export function observeMethods<T extends object>(target: T, stages: Partial<Record<keyof T, TimingStage>>): T {
  return new Proxy(target, { get(object, key) {
    const value: unknown = Reflect.get(object, key, object);
    if (typeof value !== 'function') return value;
    const stage = stages[key as keyof T];
    return (...args: unknown[]) => stage === undefined ? Reflect.apply(value, object, args) : timed(stage, () => Reflect.apply(value, object, args) as Promise<unknown>);
  } });
}
export function installHttpTimings(app: FastifyInstance, sink: TimingSink): void {
  const ends = new WeakMap<object, (ok?: boolean) => void>();
  app.addHook('onRequest', (request, reply, done) => {
    timingContext(sink, () => {
      request.log.debug({ timingTraceId: timingTraceId() }, 'request timing trace');
      const end = startTiming('http.total'); ends.set(request, end);
      reply.raw.once('close', () => end(reply.raw.writableFinished));
      done();
    });
  });
  app.addHook('onResponse', (request, reply, done) => { ends.get(request)?.(reply.statusCode < 500); done(); });
}
