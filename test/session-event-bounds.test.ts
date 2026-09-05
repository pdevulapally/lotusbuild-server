import assert from 'node:assert/strict';
import test from 'node:test';
import type { Redis } from 'ioredis';
import { SessionEvents, compareStreamIds } from '../src/sessions/events.ts';

function fixture(entries: [string, string[]][] = []) {
  const calls: unknown[][] = [];
  const redis = { xrange: async (...args: unknown[]) => { calls.push(args); return entries.splice(0, 1); },
    xadd: async () => { throw new Error('Unexpected write'); } };
  const events = new SessionEvents(redis as unknown as Redis, { on: () => {} } as unknown as Redis,
    { maxEventBytes: 1024, maxPerSession: 3, retentionSeconds: 60, onListenerError: () => {} });
  return { events, calls };
}
test('event replay parses field pairs and reads only one entry per request', async () => {
  const h = fixture([['1-0', ['type', 'data', 'data', '{"ok":true}']]]);
  const result = [];
  for await (const event of h.events.replay('session', undefined)) result.push(event);
  assert.deepEqual(result, [{ id: '1-0', type: 'data', data: { ok: true } }]);
  assert.ok(h.calls.every((call) => call.at(-1) === 1));
});
test('oversized appends and stored events are rejected before write or JSON parsing', async () => {
  const h = fixture([['1-0', ['type', 'test', 'data', 'x'.repeat(2048)]]]);
  await assert.rejects(h.events.append('session', 'test', { content: 'x'.repeat(2048) }), /byte budget/);
  await assert.rejects(async () => { for await (const _ of h.events.replay('session', undefined)) {} }, /oversized/);
});
test('stream ordering preserves integers beyond JavaScript number precision', () => {
  assert.equal(compareStreamIds('9007199254740992-0', '9007199254740993-0'), -1);
  assert.equal(compareStreamIds('1-9007199254740993', '1-9007199254740992'), 1);
});
