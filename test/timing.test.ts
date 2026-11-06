import assert from 'node:assert/strict';
import test from 'node:test';
import { timingContext, timed, observeMethods, type TimingRecord } from '../src/diagnostics/timing.ts';

test('diagnostic spans isolate concurrent roots and emit no arguments, results or raw errors', async () => {
  const records: TimingRecord[] = [];
  await Promise.all([1,2].map(index => timingContext(row => records.push(row), async () => {
    await timed('auth.verify', async () => ({ secret: `private-${index}` }));
    await assert.rejects(timed('session.read', async () => { throw new Error('private error'); }));
  })));
  assert.equal(new Set(records.map(row => row.traceId)).size, 2);
  assert.equal(records.length, 4);
  assert.ok(records.every(row => row.durationMs >= 0 && row.startMs >= 0));
  assert.equal(records.filter(row => !row.ok).length, 2);
  assert.doesNotMatch(JSON.stringify(records), /private|secret/);
});

test('timing preserves receivers, results and original failures even when its sink fails', async () => {
  class Example { #value = 42; async get() { return this.#value; } }
  const object = observeMethods(new Example(), { get: 'session.read' });
  await timingContext(() => { throw new Error('diagnostic unavailable'); }, async () => {
    assert.equal(await object.get(), 42);
    const failure = new Error('original');
    await assert.rejects(timed('session.read', async () => { throw failure; }), error => error === failure);
  });
});

test('a run summary folds stage records and reads machine facts off them', async () => {
  const { summarizeTimings } = await import('../src/diagnostics/timing.ts');
  const { environmentSummary } = await import('../src/runner/loop.ts');
  const row = (stage: TimingRecord['stage'], durationMs: number, ok = true): TimingRecord => ({ traceId: 't', stage, startMs: 0, durationMs, ok });
  const stages = summarizeTimings([
    row('sandbox.acquire', 1200.5), row('workspace.restore', 300), row('tool.execute', 10), row('tool.execute', 20.25, false),
    row('desktop.start', 4000, false), row('workspace.save', 500), row('sandbox.release', 100),
  ]);
  assert.deepEqual(stages['tool.execute'], { count: 2, totalMs: 30.25, failed: 1 });
  assert.deepEqual(stages['sandbox.acquire'], { count: 1, totalMs: 1200.5, failed: 0 });
  assert.equal(stages['model.generation'], undefined);
  assert.deepEqual(environmentSummary(stages), { sandboxes: 1, desktop: 'failed', restored: true, saved: true, released: true });
  assert.deepEqual(environmentSummary(summarizeTimings([])), { sandboxes: 0, desktop: 'none', restored: false, saved: false, released: false });
  assert.deepEqual(environmentSummary(summarizeTimings([row('sandbox.acquire', 1), row('desktop.start', 1), row('workspace.save', 1, false)])).desktop, 'ready');
  assert.equal(environmentSummary(summarizeTimings([row('workspace.save', 1, false)])).saved, false);
});
