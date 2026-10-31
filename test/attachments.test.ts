import assert from 'node:assert/strict';
import test from 'node:test';

import Fastify from 'fastify';
import type { Auth } from 'firebase-admin/auth';

import { UploadBudgetGuard, uploadBudgetFor, type BudgetCounter } from '../src/attachments/budget.ts';
import { assertImageMatches, inspectImage, stripMetadata } from '../src/attachments/image.ts';
import { registerAttachmentRoutes } from '../src/attachments/routes.ts';
import type { EntitlementService } from '../src/entitlements/service.ts';
import { maxAttachmentBytes, validateAttachmentRefs, type AttachmentStore, type AttachmentRef } from '../src/attachments/store.ts';
import { registerAuth } from '../src/auth/plugin.ts';
import { AppError, registerErrorHandler } from '../src/http/errors.ts';
import { conversationFrom, imageBlock, userContent } from '../src/runner/agent.ts';
import { registerSessionRoutes } from '../src/sessions/routes.ts';
import type { SessionEvents } from '../src/sessions/events.ts';
import type { SessionRepository } from '../src/sessions/repository.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const png: AttachmentRef = { id: id(1), mediaType: 'image/png' };
const headers = { Authorization: 'Bearer test-token', 'Idempotency-Key': 'attachment-test-command' };

test('attachment references are bounded, typed and unique', () => {
  assert.deepEqual(validateAttachmentRefs(undefined), []);
  assert.deepEqual(validateAttachmentRefs([png]), [png]);
  assert.throws(() => validateAttachmentRefs([png, png]), /not valid/);
  assert.throws(() => validateAttachmentRefs([{ id: 'x', mediaType: 'image/png' }]), /not valid/);
  assert.throws(() => validateAttachmentRefs([{ id: id(2), mediaType: 'image/svg+xml' as 'image/png' }]), /not valid/);
  assert.throws(() => validateAttachmentRefs([1, 2, 3, 4, 5].map((n) => ({ ...png, id: id(n) }))), /at most 4/);
});

test('the model sees attached images before the words, and plain prompts stay plain strings', () => {
  const image = imageBlock('image/jpeg', Buffer.from('jpeg-bytes'));
  assert.equal(userContent('hello', undefined), 'hello');
  assert.deepEqual(userContent('hello', [image]), [image, { type: 'text', text: 'hello' }]);
  const project = { id: 'p', name: 'Shop' } as unknown as Parameters<typeof conversationFrom>[1];
  const [, first, second] = conversationFrom([
    { seq: 0, role: 'user', content: 'Build this', attachments: [png], images: [image], createdAt: new Date(0) },
    { seq: 1, role: 'assistant', content: 'Sure', attachments: [], createdAt: new Date(0) },
  ], project);
  assert.deepEqual(first, { role: 'user', content: [image, { type: 'text', text: 'Build this' }] });
  assert.deepEqual(second, { role: 'assistant', content: 'Sure' });
  assert.equal(image.source.type, 'base64');
  assert.equal((image.source as { data: string }).data, Buffer.from('jpeg-bytes').toString('base64'));
});

function fakeStore(saved: { mediaType: string; bytes: number }[]) {
  const objects = new Map<string, { mediaType: 'image/png'; data: Buffer }>([[`alice/${id(1)}`, { mediaType: 'image/png', data: Buffer.from('PNG') }]]);
  return {
    save: async (uid: string, mediaType: string, data: Buffer) => {
      if (data.byteLength > maxAttachmentBytes) throw new AppError({ code: 'attachment/too-large', statusCode: 413, message: 'Images must be 5 MB or smaller.' });
      saved.push({ mediaType, bytes: data.byteLength }); return { id: id(9), mediaType, bytes: data.byteLength };
    },
    read: async (uid: string, attachmentId: string) => {
      const found = objects.get(`${uid}/${attachmentId}`);
      if (!found) throw new AppError({ code: 'attachment/not-found', statusCode: 404, message: 'No such attachment.' });
      return { id: attachmentId, ...found };
    },
    assertOwned: async (uid: string, refs: readonly AttachmentRef[]) => {
      for (const ref of refs) if (!objects.has(`${uid}/${ref.id}`)) throw new AppError({ code: 'attachment/not-found', statusCode: 404, message: 'No such attachment.' });
    },
  } as unknown as AttachmentStore;
}

async function fixture(uid = 'alice') {
  const app = Fastify({ logger: false });
  registerAuth(app, { verifyIdToken: async () => ({ uid, email_verified: true, auth_time: Date.now() / 1000, exp: Date.now() / 1000 + 3600 }) } as unknown as Auth);
  registerErrorHandler(app);
  app.decorate('enforceRateLimit', () => async () => {});
  const saved: { mediaType: string; bytes: number }[] = [];
  const calls: { method: string; args: unknown[] }[] = [];
  const store = fakeStore(saved);
  const counters = new Map<string, { uploads: number; bytes: number }>();
  const counter: BudgetCounter = {
    consume: async (key, bytes) => { const t = counters.get(key) ?? { uploads: 0, bytes: 0 }; t.uploads += 1; t.bytes += bytes; counters.set(key, t); return { ...t, ttlSeconds: 60 }; },
    release: async (key, bytes) => { const t = counters.get(key)!; t.uploads -= 1; t.bytes -= bytes; },
  };
  const entitlements = { forUser: async () => ({ planKey: 'free', rateLimits: new Map([['build', { routeClass: 'build', maxRequests: 1, windowSeconds: 60 }]]) }) } as unknown as EntitlementService;
  registerAttachmentRoutes(app, { store, entitlements, budget: new UploadBudgetGuard(counter) });
  const sessions = {
    submitMessage: async (...args: unknown[]) => { calls.push({ method: 'submitMessage', args }); return { kind: 'prompt', session: { id: 'owned', status: 'QUEUED', messageCount: 2, createdAt: new Date(0), updatedAt: new Date(0), model: 'm', mode: 'build', projectId: 'p', ownerUid: String(args[0]) } }; },
    readOwned: async (owner: string, sessionId: string) => ({ id: sessionId, ownerUid: owner, status: 'IDLE' }),
    appendPrompt: async (...args: unknown[]) => { calls.push({ method: 'appendPrompt', args }); return { id: 'owned', status: 'QUEUED', messageCount: 2, createdAt: new Date(0), updatedAt: new Date(0), model: 'm', mode: 'build', projectId: 'p', ownerUid: owner(args) }; },
    enqueueMessage: async (...args: unknown[]) => { calls.push({ method: 'enqueueMessage', args }); return { id: 'q1', sessionId: 'owned', prompt: args[2], attachments: args[4] ?? [], createdAt: new Date(0) }; },
  } as unknown as SessionRepository;
  const owner = (args: unknown[]) => String(args[0]);
  registerSessionRoutes(app, sessions, { subscribe: async () => () => {}, replay: async function* () {}, append: async () => {} } as unknown as SessionEvents,
    { heartbeatSeconds: 1, maxConnections: 1, maxConnectionsPerUser: 1, maxBufferedBytes: 1024, reauthenticate: async () => {}, attachments: store });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  return { app, address, saved, calls, counters };
}

test('uploads accept raw images only, within the size limit', async () => {
  const h = await fixture();
  try {
    const ok = await fetch(`${h.address}/attachments`, { method: 'POST', headers: { ...headers, 'Content-Type': 'image/png' }, body: tinyPng() });
    const okBody = await ok.json();
    assert.equal(ok.status, 201, JSON.stringify(okBody));
    // Stored size is after metadata stripping, so the text chunk never reaches Storage.
    assert.deepEqual(okBody, { id: id(9), mediaType: 'image/png', bytes: stripMetadata(tinyPng(), 'image/png').length, width: 2, height: 3 });
    assert.ok(okBody.bytes < tinyPng().length);
    const lying = await fetch(`${h.address}/attachments`, { method: 'POST', headers: { ...headers, 'Content-Type': 'image/png' }, body: '<svg onload="alert(1)"/>' });
    assert.equal(lying.status, 400);
    const mismatched = await fetch(`${h.address}/attachments`, { method: 'POST', headers: { ...headers, 'Content-Type': 'image/jpeg' }, body: tinyPng() });
    assert.equal(mismatched.status, 400);
    const svg = await fetch(`${h.address}/attachments`, { method: 'POST', headers: { ...headers, 'Content-Type': 'image/svg+xml' }, body: '<svg/>' });
    assert.equal(svg.status, 415);
    const json = await fetch(`${h.address}/attachments`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(json.status, 415);
    // Exercise the same parser limit without a platform-dependent TCP reset while uploading an oversized body.
    const huge = await h.app.inject({ method: 'POST', url: '/attachments', headers: { ...headers, 'Content-Type': 'image/jpeg' }, payload: Buffer.alloc(maxAttachmentBytes + 1) });
    assert.equal(huge.statusCode, 413);
    assert.equal(h.saved.length, 1);
    // The plan allows 1 build per window, so 4 images; the budget refuses the fifth and keeps the count honest.
    for (let n = 0; n < 3; n++) assert.equal((await fetch(`${h.address}/attachments`, { method: 'POST', headers: { ...headers, 'Content-Type': 'image/png' }, body: tinyPng() })).status, 201);
    const over = await fetch(`${h.address}/attachments`, { method: 'POST', headers: { ...headers, 'Content-Type': 'image/png' }, body: tinyPng() });
    assert.equal(over.status, 429);
    assert.ok(over.headers.get('retry-after') === null || Number(over.headers.get('retry-after')) >= 1);
    assert.equal([...h.counters.values()][0]?.uploads, 4);
  } finally { await h.app.close(); }
});

test('an attachment is served only to its owner, with its stored content type', async () => {
  const mine = await fixture('alice');
  const theirs = await fixture('bob');
  try {
    const response = await fetch(`${mine.address}/attachments/${id(1)}`, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    assert.match(response.headers.get('content-disposition') ?? '', /^inline; filename=".*\.png"$/);
    assert.match(response.headers.get('cache-control') ?? '', /private/);
    assert.equal(await response.text(), 'PNG');
    assert.equal((await fetch(`${theirs.address}/attachments/${id(1)}`, { headers })).status, 404);
    assert.equal((await fetch(`${mine.address}/attachments/not-a-uuid`, { headers })).status, 400);
  } finally { await mine.app.close(); await theirs.app.close(); }
});

test('messages carry verified attachment references through to the repository', async () => {
  const h = await fixture();
  try {
    const sent = await fetch(`${h.address}/sessions/owned/messages`, { method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'Match this design', attachments: [png] }) });
    assert.equal(sent.status, 202, await sent.text());
    assert.equal(h.calls[0]?.method, 'submitMessage');
    assert.deepEqual(h.calls[0]?.args[8], [png]);
    const missing = await fetch(`${h.address}/sessions/owned/messages`, { method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'x', attachments: [{ ...png, id: id(7) }] }) });
    assert.equal(missing.status, 404);
    const tooMany = await fetch(`${h.address}/sessions/owned/messages`, { method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'x', attachments: [1, 2, 3, 4, 5].map((n) => ({ ...png, id: id(n) })) }) });
    assert.equal(tooMany.status, 400);
    const badType = await fetch(`${h.address}/sessions/owned/messages`, { method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'x', attachments: [{ id: id(1), mediaType: 'text/html' }] }) });
    assert.equal(badType.status, 400);
    assert.equal(h.calls.length, 1);
  } finally { await h.app.close(); }
});

function crc(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) { c ^= byte; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
  return Buffer.concat([length, body, sum]);
}
/** A 2×3 PNG with a text chunk nobody should receive. */
function tinyPng(): Buffer {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(3, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('tEXt', Buffer.from('Comment\0GPS 51.5,-0.1', 'latin1')),
    pngChunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0x60, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01])),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

test('images are identified by their bytes, bounded in size, and shed their metadata', () => {
  const png = tinyPng();
  assert.deepEqual(inspectImage(png), { mediaType: 'image/png', width: 2, height: 3 });
  assert.deepEqual(inspectImage(Buffer.from('GIF89a\x05\x00\x07\x00\x00\x00\x00', 'latin1')), { mediaType: 'image/gif', width: 5, height: 7 });
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00]),
    Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x20, 0x00, 0x40, 0x01, 0x01, 0x11, 0x00]), Buffer.from([0xff, 0xda, 0x00, 0x02, 0x00, 0xff, 0xd9])]);
  assert.deepEqual(inspectImage(jpeg), { mediaType: 'image/jpeg', width: 64, height: 32 });
  const webp = Buffer.concat([Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'latin1'), Buffer.alloc(10), Buffer.from([0x09, 0x00, 0x05, 0x00])]);
  assert.deepEqual(inspectImage(webp), { mediaType: 'image/webp', width: 9, height: 5 });
  assert.throws(() => inspectImage(Buffer.from('<!doctype html><script>alert(1)</script>')), /not a PNG, JPEG, WEBP, GIF image/);
  assert.throws(() => inspectImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), /not a/);
  assert.throws(() => assertImageMatches({ mediaType: 'image/png', width: 2, height: 3 }, 'image/jpeg'), /is image\/png, not image\/jpeg/);
  assert.throws(() => assertImageMatches({ mediaType: 'image/png', width: 8001, height: 3 }, 'image/png'), /8000px/);
  const stripped = stripMetadata(png, 'image/png');
  assert.ok(!stripped.toString('latin1').includes('GPS'));
  assert.deepEqual(inspectImage(stripped), { mediaType: 'image/png', width: 2, height: 3 });
  const strippedJpeg = stripMetadata(jpeg, 'image/jpeg');
  assert.ok(!strippedJpeg.toString('latin1').includes('Exif'));
  assert.deepEqual(inspectImage(strippedJpeg), { mediaType: 'image/jpeg', width: 64, height: 32 });
  assert.deepEqual(uploadBudgetFor({ routeClass: 'build', maxRequests: 10, windowSeconds: 3600 }), { windowSeconds: 3600, maxUploads: 40, maxBytes: 20 * 5 * 1024 * 1024 });
});
