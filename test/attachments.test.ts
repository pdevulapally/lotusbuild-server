import assert from 'node:assert/strict';
import test from 'node:test';

import Fastify from 'fastify';
import type { Auth } from 'firebase-admin/auth';

import { registerAttachmentRoutes } from '../src/attachments/routes.ts';
import { maxAttachmentBytes, validateAttachmentRefs, type AttachmentStore, type AttachmentRef } from '../src/attachments/store.ts';
import { registerAuth } from '../src/auth/plugin.ts';
import { AppError, registerErrorHandler } from '../src/http/errors.ts';
import { conversationFrom, imageBlock, userContent } from '../src/runner/agent.ts';
import { registerSessionRoutes } from '../src/sessions/routes.ts';
import type { SessionEvents } from '../src/sessions/events.ts';
import type { SessionRepository } from '../src/sessions/repository.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const png: AttachmentRef = { id: id(1), mediaType: 'image/png' };
const headers = { Authorization: 'Bearer test-token' };

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
  registerAttachmentRoutes(app, store);
  const sessions = {
    readOwned: async (owner: string, sessionId: string) => ({ id: sessionId, ownerUid: owner, status: 'IDLE' }),
    appendPrompt: async (...args: unknown[]) => { calls.push({ method: 'appendPrompt', args }); return { id: 'owned', status: 'QUEUED', messageCount: 2, createdAt: new Date(0), updatedAt: new Date(0), model: 'm', mode: 'build', projectId: 'p', ownerUid: owner(args) }; },
    enqueueMessage: async (...args: unknown[]) => { calls.push({ method: 'enqueueMessage', args }); return { id: 'q1', sessionId: 'owned', prompt: args[2], attachments: args[4] ?? [], createdAt: new Date(0) }; },
  } as unknown as SessionRepository;
  const owner = (args: unknown[]) => String(args[0]);
  registerSessionRoutes(app, sessions, { subscribe: async () => () => {}, replay: async function* () {}, append: async () => {} } as unknown as SessionEvents,
    { heartbeatSeconds: 1, maxConnections: 1, maxConnectionsPerUser: 1, maxBufferedBytes: 1024, reauthenticate: async () => {}, attachments: store });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  return { app, address, saved, calls };
}

test('uploads accept raw images only, within the size limit', async () => {
  const h = await fixture();
  try {
    const ok = await fetch(`${h.address}/attachments`, { method: 'POST', headers: { ...headers, 'Content-Type': 'image/png' }, body: Buffer.from('PNG') });
    assert.equal(ok.status, 201);
    assert.deepEqual(await ok.json(), { id: id(9), mediaType: 'image/png', bytes: 3 });
    const svg = await fetch(`${h.address}/attachments`, { method: 'POST', headers: { ...headers, 'Content-Type': 'image/svg+xml' }, body: '<svg/>' });
    assert.equal(svg.status, 415);
    const json = await fetch(`${h.address}/attachments`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(json.status, 415);
    const huge = await fetch(`${h.address}/attachments`, { method: 'POST', headers: { ...headers, 'Content-Type': 'image/jpeg' }, body: Buffer.alloc(maxAttachmentBytes + 1) });
    assert.equal(huge.status, 413);
    assert.equal(h.saved.length, 1);
  } finally { await h.app.close(); }
});

test('an attachment is served only to its owner, with its stored content type', async () => {
  const mine = await fixture('alice');
  const theirs = await fixture('bob');
  try {
    const response = await fetch(`${mine.address}/attachments/${id(1)}`, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
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
    assert.equal(h.calls[0]?.method, 'appendPrompt');
    assert.deepEqual(h.calls[0]?.args[5], [png]);
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
