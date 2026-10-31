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
