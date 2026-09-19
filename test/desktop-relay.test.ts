import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import type { Auth } from 'firebase-admin/auth';
import type { Redis } from 'ioredis';
import { WebSocket, WebSocketServer } from 'ws';
import { registerAuth } from '../src/auth/plugin.ts';
import { DesktopRelay, desktopCloseCodes, registerDesktopRoutes, type DesktopRelayOptions } from '../src/desktop/relay.ts';
import { deleteDesktopHandoff, writeDesktopHandoff } from '../src/desktop/handoff.ts';
import { DesktopTickets, redactDesktopTicket } from '../src/desktop/tickets.ts';
import { AppError, registerErrorHandler } from '../src/http/errors.ts';
import { requestLogSerializer } from '../src/server.ts';
import type { SessionRepository } from '../src/sessions/repository.ts';

const origin = 'https://app.example.test';
const trafficToken = 'traffic-token-fixture';
const sandboxHost = '6080-abcdefghij1234567890x.e2b.test';

/** The few Redis commands the desktop code uses, with the semantics that matter (NX, atomic read-and-delete). */
class FakeRedis {
  readonly store = new Map<string, string>();
  readonly ttls = new Map<string, number>();
  async set(key: string, value: string, ...args: (string | number)[]): Promise<'OK' | null> {
    if (args.includes('NX') && this.store.has(key)) return null;
    this.store.set(key, value);
    const ex = args.indexOf('EX');
    if (ex >= 0) this.ttls.set(key, Number(args[ex + 1]));
    return 'OK';
  }
  async get(key: string): Promise<string | null> { return this.store.get(key) ?? null; }
  async eval(_script: string, _keys: number, key: string): Promise<string | null> {
    const value = this.store.get(key) ?? null;
    this.store.delete(key);
    return value;
  }
  async exists(key: string): Promise<number> { return this.store.has(key) ? 1 : 0; }
  async del(key: string): Promise<number> { return this.store.delete(key) ? 1 : 0; }
}

async function until(check: () => boolean, ms = 3000) {
  for (let waited = 0; waited < ms && !check(); waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), 'condition not met in time');
}

async function harness(overrides: Partial<DesktopRelayOptions> = {}, upstreamDelayMs = 0) {
  const redis = new FakeRedis();
  const seen = { headers: undefined as Record<string, unknown> | undefined, protocol: '', received: [] as Buffer[], sockets: [] as WebSocket[], connects: 0 };
  const upstreamServer = new WebSocketServer({ host: '127.0.0.1', port: 0, handleProtocols: (protocols) => (protocols.has('binary') ? 'binary' : false),
    verifyClient: (_info, done) => { setTimeout(() => done(true), upstreamDelayMs); } });
  upstreamServer.on('connection', (socket, request) => {
    seen.headers = request.headers; seen.protocol = socket.protocol; seen.sockets.push(socket);
    socket.on('message', (data) => seen.received.push(Buffer.from(data as Buffer)));
    socket.send(Buffer.from('RFB 003.008\n'));
  });
  await new Promise<void>((resolve) => upstreamServer.once('listening', resolve));
  let upstreamPort = (upstreamServer.address() as { port: number }).port;
  let sessionExists = true;
  const sessions = { readOwned: async (uid: string, id: string) => {
    if (!sessionExists || uid !== 'alice' || (id !== 's1' && id !== 's2')) throw new AppError({ code: 'session/not-found', statusCode: 404, message: 'No such session.' });
    return { id };
  } } as unknown as Pick<SessionRepository, 'readOwned'>;
  const options: DesktopRelayOptions = {
    maxConnections: 5, maxConnectionsPerUser: 2, maxViewersPerSession: 2, streamMaxSeconds: 600, pingSeconds: 20,
    bufferMaxBytes: 1_048_576, clientMaxBytesPerSecond: 16_384, allowedOrigins: new Set([origin]), upstreamDomain: 'e2b.test',
    connectUpstream: (_host, token) => { seen.connects++; return new WebSocket(`ws://127.0.0.1:${upstreamPort}/websockify`, ['binary'], { headers: { 'e2b-traffic-access-token': token } }); },
    ...overrides,
  };
  const tickets = new DesktopTickets(redis as unknown as Redis);
  const relay = new DesktopRelay({ redis: redis as unknown as Redis, sessions, tickets }, options);
  const app = Fastify({ logger: false });
  registerAuth(app, { verifyIdToken: async () => ({ uid: 'alice', auth_time: Date.now() / 1000, exp: Date.now() / 1000 + 3600 }) } as unknown as Auth);
  registerErrorHandler(app);
  app.decorate('enforceRateLimit', () => async () => {});
  await registerDesktopRoutes(app, { redis: redis as unknown as Redis, sessions, tickets, relay });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });

  const publish = (sessionId = 's1', host = sandboxHost) => writeDesktopHandoff(redis as unknown as Redis, sessionId, { host, token: trafficToken }, 60);
  const requestTicket = (sessionId = 's1', auth = true) => fetch(`${address}/sessions/${sessionId}/desktop-ticket`, { method: 'POST', headers: auth ? { authorization: 'Bearer test' } : {} });
  const ticketFor = async (sessionId = 's1') => { const response = await requestTicket(sessionId); assert.equal(response.status, 200); return ((await response.json()) as { ticket: string }).ticket; };
  // `null` means send no Origin header at all; `undefined` would fall back to the default.
  const connect = (sessionId: string, ticket: string | undefined, from: string | null = origin) => {
    const url = `${address.replace('http', 'ws')}/sessions/${sessionId}/desktop${ticket === undefined ? '' : `?ticket=${ticket}`}`;
    const ws = new WebSocket(url, ['binary'], from === null ? {} : { origin: from });
    const messages: Buffer[] = [];
    ws.on('message', (data) => messages.push(Buffer.from(data as Buffer)));
    const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    ws.on('error', () => {});
    const opened = new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
    return { ws, messages, closed, opened };
  };
  return { app, redis, seen, upstreamServer, address, publish, requestTicket, ticketFor, connect,
    setSessionExists: (value: boolean) => { sessionExists = value; }, setUpstreamPort: (port: number) => { upstreamPort = port; },
    close: async () => { for (const socket of seen.sockets) socket.terminate(); await app.close(); await new Promise((resolve) => upstreamServer.close(resolve)); } };
}

test('the close codes are exactly the contract the frontend codes against', () => {
  assert.deepEqual(desktopCloseCodes, {
    'desktop-ended': 1000, 'server-shutdown': 1001, 'protocol-abuse': 4400, 'ticket-invalid': 4401, 'origin-not-allowed': 4403,
    'session-not-found': 4404, 'no-desktop': 4409, 'max-lifetime': 4410, 'slow-consumer': 4413, 'capacity-reached': 4429, 'relay-error': 4500,
  });
});

test('the ticket endpoint requires sign-in, ownership and a running desktop, and returns the agreed shape', async (t) => {
  const h = await harness(); t.after(h.close);
  assert.equal((await h.requestTicket('s1', false)).status, 401);
  assert.equal((await h.requestTicket('nobody')).status, 404);
  const none = await h.requestTicket('s1');
  assert.equal(none.status, 409);
  assert.equal(((await none.json()) as { error: { code: string } }).error.code, 'session/no-desktop');

  await h.publish();
  const response = await h.requestTicket('s1');
  assert.equal(response.status, 200);
  const body = (await response.json()) as { ticket: string; expiresInSeconds: number; path: string };
  assert.deepEqual(Object.keys(body).sort(), ['expiresInSeconds', 'path', 'ticket']);
  assert.match(body.ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(body.expiresInSeconds, 30);
  assert.equal(body.path, '/sessions/s1/desktop');
  assert.notEqual(await h.ticketFor(), body.ticket);
  // Only a hash is stored, with the 30 second lifetime.
  const keys = [...h.redis.store.keys()].filter((key) => key.startsWith('dkt:'));
  assert.ok(keys.length >= 2);
  assert.ok(keys.every((key) => !key.includes(body.ticket)));
  assert.ok(keys.every((key) => h.redis.ttls.get(key) === 30));
  assert.ok([...h.redis.store.values()].every((value) => !value.includes(body.ticket)));
});

test('a valid ticket streams bytes both ways, presents the traffic token upstream, and never shows it to the browser', async (t) => {
  const h = await harness(); t.after(h.close);
  await h.publish();
  const viewer = h.connect('s1', await h.ticketFor());
  await viewer.opened;
  assert.equal(viewer.ws.protocol, 'binary');
  await until(() => viewer.messages.length === 1);
  assert.equal(viewer.messages[0]!.toString(), 'RFB 003.008\n');
  viewer.ws.send(Buffer.from([3, 1, 0, 0, 0, 0, 5, 0, 3, 32]));
  await until(() => h.seen.received.length === 1);
  assert.deepEqual([...h.seen.received[0]!], [3, 1, 0, 0, 0, 0, 5, 0, 3, 32]);
  assert.equal(h.seen.headers?.['e2b-traffic-access-token'], trafficToken);
  assert.equal(h.seen.protocol, 'binary');
  assert.equal(viewer.messages.some((message) => message.includes(trafficToken)), false);
  // The sandbox ending ends the stream cleanly.
  h.seen.sockets[0]!.close();
  assert.deepEqual(await viewer.closed, { code: 1000, reason: 'desktop-ended' });
});

test('a ticket works once', async (t) => {
  const h = await harness(); t.after(h.close);
  await h.publish();
  const ticket = await h.ticketFor();
  const first = h.connect('s1', ticket); await first.opened;
  assert.deepEqual(await h.connect('s1', ticket).closed, { code: 4401, reason: 'ticket-invalid' });
  first.ws.terminate();
});

test('missing, malformed, foreign-session and absent tickets are refused with 4401', async (t) => {
  const h = await harness(); t.after(h.close);
  await h.publish(); await h.publish('s2');
  assert.deepEqual(await h.connect('s1', undefined).closed, { code: 4401, reason: 'ticket-invalid' });
  assert.deepEqual(await h.connect('s1', 'not-a-ticket').closed, { code: 4401, reason: 'ticket-invalid' });
  assert.deepEqual(await h.connect('s1', 'A'.repeat(43)).closed, { code: 4401, reason: 'ticket-invalid' });
  // A ticket for one session cannot open another.
  assert.deepEqual(await h.connect('s2', await h.ticketFor('s1')).closed, { code: 4401, reason: 'ticket-invalid' });
  assert.equal(h.seen.connects, 0);
});

test('an origin that is not allowed is refused, whatever the ticket', async (t) => {
  const h = await harness(); t.after(h.close);
  await h.publish();
  const ticket = await h.ticketFor();
  assert.deepEqual(await h.connect('s1', ticket, 'https://evil.example').closed, { code: 4403, reason: 'origin-not-allowed' });
  assert.deepEqual(await h.connect('s1', ticket, null).closed, { code: 4403, reason: 'origin-not-allowed' });
  assert.equal(h.seen.connects, 0);
  // The refusal did not spend the ticket, so the legitimate origin can still use it.
  const viewer = h.connect('s1', ticket); await viewer.opened;
  viewer.ws.terminate();
});

test('a session that is gone, or a desktop that is not running, is reported with its own code', async (t) => {
  const h = await harness(); t.after(h.close);
  await h.publish();
  h.setSessionExists(false);
  assert.deepEqual(await h.connect('s1', await ticketWhileSessionExists(h)).closed, { code: 4404, reason: 'session-not-found' });
  h.setSessionExists(true);
  const ticket = await h.ticketFor();
  await deleteDesktopHandoff(h.redis as unknown as Redis, 's1');
  assert.deepEqual(await h.connect('s1', ticket).closed, { code: 4409, reason: 'no-desktop' });
});
async function ticketWhileSessionExists(h: Awaited<ReturnType<typeof harness>>) {
  h.setSessionExists(true); const ticket = await h.ticketFor(); h.setSessionExists(false); return ticket;
}

test('capacity is enforced per account, per session and overall, at ticket time and at connect time', async (t) => {
  const h = await harness({ maxConnectionsPerUser: 2, maxViewersPerSession: 5, maxConnections: 5 }); t.after(h.close);
  await h.publish(); await h.publish('s2');
  const tickets = [await h.ticketFor(), await h.ticketFor(), await h.ticketFor()];
  const one = h.connect('s1', tickets[0]!); const two = h.connect('s1', tickets[1]!);
  await Promise.all([one.opened, two.opened]); await until(() => h.seen.sockets.length === 2);
  // A third viewer with an already-issued ticket is refused at connect time...
  assert.deepEqual(await h.connect('s1', tickets[2]!).closed, { code: 4429, reason: 'capacity-reached' });
  // ...and a new ticket is refused up front.
  const refused = await h.requestTicket('s1');
  assert.equal(refused.status, 429);
  assert.equal(((await refused.json()) as { error: { code: string } }).error.code, 'desktop/capacity-reached');
  // Closing one frees the slot.
  one.ws.terminate(); await one.closed;
  let ok = false; for (let i = 0; i < 100 && !ok; i++) { ok = (await h.requestTicket('s1')).status === 200; if (!ok) await new Promise((r) => setTimeout(r, 10)); }
  assert.ok(ok, 'capacity was not released');
  two.ws.terminate();
});

test('one session cannot exceed its viewer limit', async (t) => {
  const h = await harness({ maxViewersPerSession: 1, maxConnectionsPerUser: 5 }); t.after(h.close);
  await h.publish();
  const [a, b] = [await h.ticketFor(), await h.ticketFor()];
  const first = h.connect('s1', a); await first.opened; await until(() => h.seen.sockets.length === 1);
  assert.deepEqual(await h.connect('s1', b).closed, { code: 4429, reason: 'capacity-reached' });
  first.ws.terminate();
});

test('a socket is closed at its maximum lifetime so the client must fetch a fresh ticket', async (t) => {
  const h = await harness({ streamMaxSeconds: 1 }); t.after(h.close);
  await h.publish();
  const viewer = h.connect('s1', await h.ticketFor()); await viewer.opened;
  assert.deepEqual(await viewer.closed, { code: 4410, reason: 'max-lifetime' });
});

test('deleting the handoff (the runner says the desktop is gone) ends every open stream', async (t) => {
  const h = await harness({ pingSeconds: 1 }); t.after(h.close);
  await h.publish();
  const viewer = h.connect('s1', await h.ticketFor()); await viewer.opened; await until(() => h.seen.sockets.length === 1);
  await deleteDesktopHandoff(h.redis as unknown as Redis, 's1');
  assert.deepEqual(await viewer.closed, { code: 1000, reason: 'desktop-ended' });
  await until(() => h.seen.sockets[0]!.readyState === WebSocket.CLOSED);
});

test('an unreachable sandbox is a relay error, and a host outside the sandbox domain or port is never contacted', async (t) => {
  const h = await harness(); t.after(h.close);
  await h.publish();
  h.setUpstreamPort(1);
  assert.deepEqual(await h.connect('s1', await h.ticketFor()).closed, { code: 4500, reason: 'relay-error' });
  const before = h.seen.connects;
  for (const host of ['6080-abcdefghij1234567890x.evil.example', '49983-abcdefghij1234567890x.e2b.test', '6080-abcdefghij1234567890x.e2b.test.evil.example', '169.254.169.254']) {
    await h.publish('s1', host);
    assert.deepEqual(await h.connect('s1', await h.ticketFor()).closed, { code: 4500, reason: 'relay-error' }, host);
  }
  assert.equal(h.seen.connects, before, 'the relay connected to a host it should have refused');
});

test('a view-only client that sends too much is dropped', async (t) => {
  const h = await harness({ clientMaxBytesPerSecond: 1024 }); t.after(h.close);
  await h.publish();
  const viewer = h.connect('s1', await h.ticketFor()); await viewer.opened; await until(() => h.seen.sockets.length === 1);
  viewer.ws.send(Buffer.alloc(2048));
  assert.deepEqual(await viewer.closed, { code: 4400, reason: 'protocol-abuse' });
  assert.equal(h.seen.received.length, 0, 'the abusive frame must not reach the sandbox');
});

test('a viewer that stops reading is dropped rather than buffered without limit', async (t) => {
  const h = await harness({ bufferMaxBytes: 4096 }); t.after(h.close);
  await h.publish();
  const viewer = h.connect('s1', await h.ticketFor()); await viewer.opened; await until(() => h.seen.sockets.length === 1);
  // Stop the browser side reading, then flood from the sandbox.
  (viewer.ws as unknown as { _socket: { pause(): void } })._socket.pause();
  const chunk = Buffer.alloc(64 * 1024, 1);
  const upstream = h.seen.sockets[0]!;
  for (let i = 0; i < 400 && upstream.readyState === WebSocket.OPEN; i++) { upstream.send(chunk); await new Promise((resolve) => setImmediate(resolve)); }
  await until(() => upstream.readyState !== WebSocket.OPEN, 5000);
  viewer.ws.terminate();
});

test('the ticket is redacted from request logs', () => {
  assert.equal(redactDesktopTicket('/sessions/s1/desktop?ticket=SECRET'), '/sessions/s1/desktop?ticket=[redacted]');
  assert.equal(redactDesktopTicket('/sessions/s1/desktop?a=1&ticket=SECRET&b=2'), '/sessions/s1/desktop?a=1&ticket=[redacted]&b=2');
  assert.equal(redactDesktopTicket('/projects?limit=5'), '/projects?limit=5');
  const request = { method: 'GET', url: '/sessions/s1/desktop?ticket=SECRET', host: 'api.example.test', ip: '203.0.113.9', socket: { remotePort: 4242 } };
  const logged = JSON.stringify(requestLogSerializer(request as never));
  assert.equal(logged.includes('SECRET'), false);
  assert.ok(logged.includes('ticket=[redacted]'));
});

test('a viewer that leaves while the sandbox connection is still opening leaks nothing', async (t) => {
  const h = await harness({}, 400); t.after(h.close);
  await h.publish();
  const viewer = h.connect('s1', await h.ticketFor()); await viewer.opened;
  await until(() => h.seen.connects === 1);
  viewer.ws.terminate();
  await until(() => h.seen.sockets.length === 1, 3000);
  await until(() => h.seen.sockets[0]!.readyState === WebSocket.CLOSED, 3000);
  let ok = false; for (let i = 0; i < 100 && !ok; i++) { ok = (await h.requestTicket('s1')).status === 200; if (!ok) await new Promise((r) => setTimeout(r, 10)); }
  assert.ok(ok, 'the reservation was not released');
});

test('shutting the server down tells every viewer it is going away', async (t) => {
  const h = await harness(); t.after(async () => { for (const socket of h.seen.sockets) socket.terminate(); await new Promise((resolve) => h.upstreamServer.close(resolve)); });
  await h.publish();
  const viewer = h.connect('s1', await h.ticketFor()); await viewer.opened; await until(() => h.seen.sockets.length === 1);
  const closing = h.app.close();
  assert.deepEqual(await viewer.closed, { code: 1001, reason: 'server-shutdown' });
  await closing;
});
