import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import Fastify from 'fastify';
import type { Auth } from 'firebase-admin/auth';
import { Timestamp } from 'firebase-admin/firestore';
import type { Redis } from 'ioredis';
import { registerAuth } from '../src/auth/plugin.ts';
import { registerErrorHandler } from '../src/http/errors.ts';
import { SessionEvents } from '../src/sessions/events.ts';
import { registerSessionRoutes } from '../src/sessions/routes.ts';
import type { SessionRepository } from '../src/sessions/repository.ts';
import { ledger } from './support/ledger.ts';

function fixture(maximum = 10) {
  const { db, data } = ledger();
  const bus = new EventEmitter();
  let notifications = true;
  const redis = { publish: async (key: string, payload: string) => { if (notifications) bus.emit('message', key, payload); return 1; } };
  const subscriber = Object.assign(bus, { subscribe: async () => 1, unsubscribe: async () => 0 });
  data.set('sessions/s', { ownerUid: 'alice', projectId: 'p', status: 'RUNNING' });
  const events = () => new SessionEvents(redis as unknown as Redis, subscriber as unknown as Redis, {
    firestore: db, maxEventBytes: 2048, maxPerSession: maximum, retentionSeconds: 60, onListenerError: (error) => { throw error; },
  });
  return { db, data, events, dropNotifications: () => { notifications = false; } };
}

test('durable history survives replacement of every Redis/client object and retains append order', async () => {
  const h = fixture(); const publisher = h.events();
  const written = await Promise.all(Array.from({ length: 5 }, (_, index) => publisher.append('s', 'agent.step', { index })));
  const replacement = h.events();
  const replayed = await replacement.history('s', written[1]!.id);
  assert.deepEqual(replayed, written.slice(2));
  assert.deepEqual(replayed.map((event) => event.data['index']), [2, 3, 4]);
  assert.equal(await replacement.resumeAvailable('s', written[0]!.id), true);
});

test('trimmed and foreign/future cursors require explicit reconciliation and history stays bounded', async () => {
  const h = fixture(2); const events = h.events();
  const first = await events.append('s', 'agent.step', { number: 1 });
  await events.append('s', 'agent.step', { number: 2 });
  await events.append('s', 'agent.step', { number: 3 });
  assert.equal(await events.resumeAvailable('s', first.id), false);
  assert.equal(await events.resumeAvailable('s', '999999999999999-2'), false);
  assert.equal([...h.data.keys()].filter((key) => key.startsWith('sessions/s/session_events/')).length, 2);
  assert.equal((await events.history('s', undefined)).length, 2);
});

async function streamHarness(maximum = 10) {
  const h = fixture(maximum); const events = h.events(); const app = Fastify();
  let cancellations = 0;
  registerAuth(app, { verifyIdToken: async () => ({ uid: 'alice', email_verified: true, exp: Date.now() / 1000 + 3600 }) } as unknown as Auth);
  registerErrorHandler(app); app.decorate('enforceRateLimit', () => async () => {});
  registerSessionRoutes(app, {
    readOwned: async (uid: string, sessionId: string) => {
      assert.equal(uid, 'alice'); assert.equal(sessionId, 's');
      const fields = h.data.get('sessions/s')!;
      return { id: 's', projectId: 'p', ownerUid: 'alice', status: fields['status'], model: 'model', effort: 'standard', mode: 'build', messageCount: 1, createdAt: new Date(0) };
    },
    cancel: async () => { cancellations++; throw new Error('Disconnect must never cancel work'); },
  } as unknown as SessionRepository, events, { heartbeatSeconds: 0.03, maxConnections: 5, maxConnectionsPerUser: 5,
    maxBufferedBytes: 4096, reauthenticate: async () => {} });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const connect = async (after?: string) => {
    const abort = new AbortController();
    const response = await fetch(`${address}/sessions/s/events`, { headers: { Authorization: 'Bearer token', ...(after === undefined ? {} : { 'Last-Event-ID': after }) }, signal: abort.signal });
    assert.equal(response.status, 200); assert.ok(response.body);
    const reader = response.body.getReader(); let text = '';
    return { abort, readUntil: async (needle: string) => {
      const timeout = setTimeout(() => abort.abort(), 3000);
      try {
        while (!text.includes(needle)) { const part = await reader.read(); if (part.done) throw new Error('Unexpected end of stream'); text += new TextDecoder().decode(part.value); }
        return text;
      } finally { clearTimeout(timeout); }
    } };
  };
  return { ...h, events, app, connect, cancellations: () => cancellations };
}

test('closing a real HTTP client leaves work running; another client replays only missed events', async () => {
  const h = await streamHarness();
  const first = await h.events.append('s', 'agent.step', { number: 1 });
  let client = await h.connect();
  try {
    await client.readUntil(first.id); client.abort.abort();
    const missed = await h.events.append('s', 'agent.step', { number: 2 });
    h.data.set('sessions/s', { ...h.data.get('sessions/s'), status: 'IDLE', updatedAt: Timestamp.now() });
    client = await h.connect(first.id);
    const text = await client.readUntil('session.state');
    assert.ok(text.includes(missed.id)); assert.equal(text.includes(`id: ${first.id}\n`), false);
    assert.ok(text.includes('"status":"IDLE"')); assert.equal(h.cancellations(), 0);
  } finally { client.abort.abort(); await h.app.close(); }
});

test('a live client repairs lost notifications from Firestore on heartbeat', async () => {
  const h = await streamHarness(); const client = await h.connect();
  try {
    await client.readUntil('session.state'); h.dropNotifications();
    const missed = await h.events.append('s', 'agent.step', { number: 9 });
    assert.ok((await client.readUntil(missed.id)).includes('"number":9'));
  } finally { client.abort.abort(); await h.app.close(); }
});

test('reconnecting beyond retention sends reset before retained progress and current task state', async () => {
  const h = await streamHarness(2);
  const old = await h.events.append('s', 'agent.step', { number: 1 });
  await h.events.append('s', 'agent.step', { number: 2 });
  await h.events.append('s', 'agent.step', { number: 3 });
  const client = await h.connect(old.id);
  try {
    const text = await client.readUntil('session.state');
    assert.ok(text.indexOf('stream.reset') < text.indexOf('id: '));
    assert.ok(text.includes('history-unavailable')); assert.equal(h.cancellations(), 0);
  } finally { client.abort.abort(); await h.app.close(); }
});


test('stale worker progress cannot overwrite the successor journal or publish a false terminal state', async () => {
  const h = fixture(); const events = h.events();
  h.data.set('sessions/s', { ...h.data.get('sessions/s'), claimedBy: 'successor', leaseToken: 'new-token', claimableAt: Timestamp.fromMillis(Date.now() + 60000) });
  await assert.rejects(events.append('s', 'agent.step', {}, { sessionId: 's', runnerId: 'predecessor', token: 'old-token' }), { code: 'session/lease-lost' });
  await assert.rejects(events.append('s', 'session.failed', {}), /Obsolete/);
  assert.equal((await events.history('s', undefined)).length, 0);
  await events.append('s', 'agent.step', {}, { sessionId: 's', runnerId: 'successor', token: 'new-token' });
  assert.equal((await events.history('s', undefined)).length, 1);
});
