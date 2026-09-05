import assert from 'node:assert/strict';
import test from 'node:test';
import { outputLimiter, readBoundedText, readTextWindow } from '../src/sandboxes/bounded-output.ts';

function stream(text: string) {
  const bytes = Buffer.from(text);
  return new ReadableStream<Uint8Array>({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } });
}
test('transport budgets count UTF-8 bytes across chunks', () => {
  const accept = outputLimiter(4);
  accept('é'); accept('é');
  assert.throws(() => accept('a'), /budget/);
});
test('bounded text decodes split multibyte characters and refuses oversized input', async () => {
  assert.equal(await readBoundedText(stream('a😀é'), 7), 'a😀é');
  await assert.rejects(readBoundedText(stream('a😀é'), 6), /budget/);
});
test('ranged reads count the entire source while retaining only the UTF-16 window', async () => {
  const text = 'abc😀def' + 'z'.repeat(10000);
  const result = await readTextWindow(stream(text), 3, 2);
  assert.deepEqual(result, { text: text.slice(2, 6), start: 2, total: text.length });
});
test('invalid UTF-8 fails instead of silently changing project contents', async () => {
  const source = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Uint8Array.of(255)); c.close(); } });
  await assert.rejects(readBoundedText(source, 10));
});
