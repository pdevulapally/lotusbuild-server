import { AppError } from '../src/http/errors.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sandbox } from 'e2b';
import type Anthropic from '@anthropic-ai/sdk';
import { E2BAdapter } from '../src/sandboxes/e2b.ts';
import { SandboxService } from '../src/sandboxes/service.ts';
import type { RunningSandbox, SandboxAdapter } from '../src/sandboxes/provider.ts';
import { parsePlan, parseRegistry } from '../src/entitlements/schema.ts';
import { ResolvedEntitlements, type UserEntitlements } from '../src/entitlements/service.ts';
import type { ConfigurationStore } from '../src/entitlements/store.ts';
import { MeteringService } from '../src/metering/service.ts';
import { planDocuments, registryDocument } from '../src/seed/config.ts';
import { SessionRunner, type RunnerDependencies } from '../src/runner/loop.ts';
import type { DesktopHandoff, DesktopHandoffPort } from '../src/desktop/handoff.ts';
import { ledger } from './support/ledger.ts';

const desktopSize = { width: 1280, height: 800 };

/** The seeded registry with a desktop on the web provider, or with `desktop` set to anything at all. */
function registryWith(desktop?: unknown) {
  return parseRegistry({
    ...registryDocument,
    sandboxProviders: registryDocument.sandboxProviders.map((row) => row.platform === 'web' && desktop !== undefined ? { ...row, desktop } : row),
  } as Record<string, unknown>, 'registry');
}

test('the seeded registry has no desktop, so the feature is off unless a row asks for it', () => {
  for (const provider of registryWith().sandboxProviders.values()) assert.equal(provider.desktop, undefined);
});

test('a provider row names its desktop size, and a malformed one is refused rather than ignored', () => {
  assert.deepEqual(registryWith(desktopSize).sandboxProviders.get('web')!.desktop, desktopSize);
  assert.equal(registryWith(desktopSize).sandboxProviders.get('mobile')!.desktop, undefined);
  for (const bad of [null, 'large', [], {}, { width: 1280 }, { height: 800 }, { width: '1280', height: 800 }, { width: 100, height: 800 },
    { width: 1280, height: 5000 }, { width: 1280.5, height: 800 }, { width: 99999, height: 800 }]) {
    assert.throws(() => registryWith(bad), /desktop/, JSON.stringify(bad));
  }
});

/** A stand-in for the E2B sandbox object, recording every command in order. */
function fakeE2BSandbox(options: { token?: string | undefined } = { token: 'traffic-token-fixture' }) {
  const commands: { command: string; opts: Record<string, unknown> }[] = [];
  const sandbox = {
    sandboxId: 'sandbox-fixture',
    ...(options.token === undefined ? {} : { trafficAccessToken: options.token }),
    getHost: (port: number) => `${port}-abcdefghij1234567890x.e2b.test`,
    commands: { run: async (command: string, opts: Record<string, unknown>) => {
      commands.push({ command, opts });
      return { disconnect: async () => {} };
    } },
  };
  return { sandbox, commands };
}

test('a desktop sandbox is created with a display and is never opened to public traffic', async (t) => {
  const created: Record<string, unknown>[] = [];
  const fake = fakeE2BSandbox();
  t.mock.method(Sandbox, 'create', async (_template: string, opts: Record<string, unknown>) => { created.push(opts); return fake.sandbox; });
  const adapter = new E2BAdapter('fixture', 'example.test', false, 4096);
  const context = { metadata: {}, publicPreviewEnabled: true, networkPolicy: { mode: 'unrestricted' as const } };

  await adapter.start(registryWith().sandboxProviders.get('web')!, context);
  await adapter.start(registryWith(desktopSize).sandboxProviders.get('web')!, context);

  const [plain, withDesktop] = created as [{ envs?: unknown; network: { allowPublicTraffic: boolean } }, { envs?: unknown; network: { allowPublicTraffic: boolean } }];
  // Unchanged for a provider without a desktop.
  assert.equal(plain.envs, undefined);
  assert.equal(plain.network.allowPublicTraffic, true);
  // A desktop's stream has no password, so the sandbox stays private even when the project asked for public.
  assert.deepEqual(withDesktop.envs, { DISPLAY: ':0' });
  assert.equal(withDesktop.network.allowPublicTraffic, false);
});

test('startDesktop brings up the screen, the session and a view-only stream, and returns only host and token', async (t) => {
  const fake = fakeE2BSandbox();
  t.mock.method(Sandbox, 'create', async () => fake.sandbox);
  const adapter = new E2BAdapter('fixture', 'example.test', false, 4096);
  const running = await adapter.start(registryWith(desktopSize).sandboxProviders.get('web')!, { metadata: {}, networkPolicy: { mode: 'unrestricted' } });
  fake.commands.length = 0;

  const endpoint = await running.startDesktop!(desktopSize);

  assert.deepEqual(endpoint, { host: '6080-abcdefghij1234567890x.e2b.test', token: 'traffic-token-fixture' });
  const order = fake.commands.map((entry) => entry.command);
  const at = (needle: string) => order.findIndex((command) => command.includes(needle));
  // Screen first, then the session on it, then the stream, then the proxy in front of it.
  assert.ok(at('Xvfb :0') >= 0 && at('Xvfb :0') < at('xdpyinfo'));
  assert.ok(at('xdpyinfo') < at('startxfce4'));
  assert.ok(at('startxfce4') < at('x11vnc'));
  assert.ok(at('x11vnc') < at('novnc_proxy'));
  assert.ok(at('novnc_proxy') < at('ss -ltn'));
  assert.match(order[at('Xvfb :0')]!, /-screen 0 1280x800x24/);
  // View-only is decided at the VNC server, where a viewer cannot get around it.
  assert.match(order[at('x11vnc')]!, /-viewonly/);
  assert.match(order[at('novnc_proxy')]!, /--listen 6080/);
  assert.deepEqual(fake.commands[at('startxfce4')]!.opts['envs'], { DISPLAY: ':0' });
});

test('startDesktop refuses to run without a private access token, with a bad size, or after cancellation', async (t) => {
  const withoutToken = fakeE2BSandbox({ token: undefined });
  const create = t.mock.method(Sandbox, 'create', async () => withoutToken.sandbox);
  const adapter = new E2BAdapter('fixture', 'example.test', false, 4096);
  const provider = registryWith(desktopSize).sandboxProviders.get('web')!;

  const noToken = await adapter.start(provider, { metadata: {}, networkPolicy: { mode: 'unrestricted' } });
  withoutToken.commands.length = 0;
  await assert.rejects(noToken.startDesktop!(desktopSize), /traffic access token/);
  assert.deepEqual(withoutToken.commands, [], 'nothing may be started when it could not be reached privately');

  const fake = fakeE2BSandbox();
  create.mock.mockImplementation(async () => fake.sandbox);
  const running = await adapter.start(provider, { metadata: {}, networkPolicy: { mode: 'unrestricted' } });
  fake.commands.length = 0;
  for (const bad of [{ width: 0, height: 800 }, { width: 1280, height: -1 }, { width: 1280.5, height: 800 }, { width: Number.NaN, height: 800 }]) {
    await assert.rejects(running.startDesktop!(bad), /valid integer size/);
  }
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(running.startDesktop!(desktopSize, controller.signal), /cancelled/);
  assert.deepEqual(fake.commands, []);
});

test('a desktop provider is never handed public preview, and a plain one still is', async () => {
  const plans = new Map(planDocuments.map((doc) => [doc.key, parsePlan(doc, doc.key, registryWith())]));
  const seen: (boolean | undefined)[] = [];
  const running = { externalId: 'fixture', lifetime: async () => ({ startedAt: new Date(0), endAt: new Date(60000) }) } as RunningSandbox;
  const adapter: SandboxAdapter = { connect: async () => running, terminate: async () => true, start: async (_provider, context) => {
    seen.push(context.publicPreviewEnabled);
    await context.lifecycle?.beforeCreate(); await context.lifecycle?.created(running);
    return running;
  } };
  const input = { uid: 'u', platform: 'web' as const, sessionId: 's', now: new Date(), publicPreviewEnabled: true,
    entitlements: { planKey: 'business' } as UserEntitlements,
    reservations: { take: async (hold: { meterKey: string; quantity: number; operationId: string }) => ({
      id: `fixture-${hold.meterKey}`, meterKey: hold.meterKey, estimatedQuantity: hold.quantity, operationId: hold.operationId, status: 'OPEN' as const,
    }) } };
  for (const registry of [registryWith(), registryWith(desktopSize)]) {
    const service = new SandboxService({ get: async () => ({ registry, plans }) } as unknown as ConfigurationStore,
      { markInFlight: async () => {}, recordSandbox: async () => {} } as unknown as MeteringService, new Map([['e2b', adapter]]));
    await service.acquire(input);
  }
  assert.deepEqual(seen, [true, false]);
});

// ---- the runner: announces the desktop, withdraws it, and never lets it break a build ----

function runnerFixture(options: { desktop: boolean; startDesktop?: (signal?: AbortSignal) => Promise<DesktopHandoff>; withoutHandoffPort?: boolean }) {
  const { db } = ledger();
  const registry = registryWith(options.desktop ? desktopSize : undefined);
  const plans = new Map(planDocuments.map((doc) => [doc.key, parsePlan(doc, doc.key, registry)]));
  const plan = plans.get('business')!;
  const entitlements = { planKey: plan.key, planName: plan.name, capabilities: new ResolvedEntitlements(plan.entitlements),
    meterLimits: plan.meterLimits, rateLimits: plan.rateLimits } as UserEntitlements;
  const configuration = { get: async () => ({ registry, plans }) } as unknown as ConfigurationStore;
  const metering = new MeteringService(db, configuration);
  const order: string[] = [];
  const emitted: { type: string; data: Record<string, unknown> }[] = [];
  const handoffCalls: { call: string; sessionId: string; handoff?: DesktopHandoff; ttl?: number }[] = [];
  let cancelListener: ((event: { type: string }) => void) | undefined;
  let modelCalls = 0; let cancelled = false;
  const startDesktop = options.startDesktop ?? (async () => ({ host: '6080-abcdefghij1234567890x.e2b.test', token: 'traffic-token-fixture' }));
  const running = {
    externalId: 'vm-fixture', lifetime: async () => ({ startedAt: new Date(Date.now() - 1000), endAt: new Date(Date.now() + 59000) }),
    stopCommands: async () => {}, runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    startDesktop: async (settings: unknown, signal?: AbortSignal) => { order.push('startDesktop'); assert.deepEqual(settings, desktopSize); return startDesktop(signal); },
  } as unknown as RunningSandbox;
  const adapter: SandboxAdapter = { connect: async () => running, terminate: async () => { order.push('terminate'); return true; },
    start: async (_provider, context) => { await context.lifecycle!.beforeCreate(); await context.lifecycle!.created(running); return running; } };
  const anthropic = { messages: {
    countTokens: async () => ({ input_tokens: 2 }),
    stream: () => { modelCalls++; order.push('model'); return { on: () => {}, finalMessage: async () => ({ content: [{ type: 'text', text: 'Complete' }],
      usage: { input_tokens: 2, output_tokens: 1 }, stop_reason: 'end_turn' }) }; },
  } } as unknown as Anthropic;
  const session = { id: 's', projectId: 'p', ownerUid: 'u', model: entitlements.capabilities.stringList('ai.model.allowlist')[0],
    leaseToken: 'lease', reservationIds: [], specialistReservationIds: [] };
  const sessions = {
    requireWorkspaceSalvage: async () => {}, claim: async () => session, heartbeat: async () => {}, assertPersistenceLease: async () => { if (cancelled) throw new AppError({ code: 'session/cancelled', statusCode: 409, message: 'Cancelled by user' }); }, markExecutionStarted: async () => {},
    attachSandbox: async () => {}, detachSandbox: async () => {}, drainSteerMessage: async () => undefined,
    listMessages: async () => [{ role: 'user', content: 'Build', seq: 0 }],
    reserveSpecialistTokens: async (_id: string, _runner: string, input: { meterKey: string; quantity: number; operationId: string }) =>
      metering.reserve({ ...input, uid: 'u', entitlements, now: new Date() }),
    forgetSpecialistReservation: async () => {},
    appendAssistantMessage: async () => {}, dequeueNextMessage: async () => undefined,
    yieldForRecovery: async () => {}, finish: async () => { order.push('finish'); return 'IDLE'; },
  };
  const handoffPort: DesktopHandoffPort = {
    publish: async (sessionId, handoff, ttl) => { handoffCalls.push({ call: 'publish', sessionId, handoff, ttl }); order.push('publish'); },
    clear: async (sessionId) => { handoffCalls.push({ call: 'clear', sessionId }); order.push('clear'); return true; },
  };
  const logs: { message: string }[] = [];
  const capture = (_details: object, message: string) => { logs.push({ message }); };
  const deps = { runnerId: 'runner', anthropic, sessions, metering, configuration,
    entitlements: { forUser: async () => entitlements },
    projects: { readOwned: async () => ({ id: 'p', platform: 'web', ownerUid: 'u', name: 'Fixture', snapshot: { kind: 'none' } }) },
    sandboxes: new SandboxService(configuration, metering, new Map([['e2b', adapter]])),
    persistence: { restore: async () => 'fresh', save: async () => ({ bytes: 1, committed: true }) },
    events: { subscribe: async (_id: string, listener: typeof cancelListener) => { cancelListener = listener; return () => {}; },
      append: async (_id: string, type: string, data: Record<string, unknown>) => { emitted.push({ type, data }); order.push(type); } },
    limits: { maxSteps: 3, maxOutputTokens: 10, toolOutputMaxChars: 4096, maxSpecialistConsultations: 0, specialistMaxSteps: 1,
      commandTimeoutMs: 1000, previewReadyTimeoutSeconds: 1 },
    heartbeatSeconds: 60, messageHistoryLimit: 10, log: { info: capture, warn: capture, error: capture },
    ...(options.withoutHandoffPort === true ? {} : { desktop: handoffPort }),
  } as unknown as RunnerDependencies;
  return { runner: new SessionRunner(deps), order, emitted, handoffCalls, logs, timeoutSeconds: registry.sandboxProviders.get('web')!.timeoutSeconds,
    cancel: () => { cancelled = true; cancelListener?.({ type: 'session.cancel_requested' }); }, modelCalls: () => modelCalls,
    types: () => emitted.map((event) => event.type),
    diagnostics: () => JSON.stringify({ events: emitted, logs: logs.map((entry) => entry.message), order }) };
}

test('a build with no desktop configured never starts one, announces one, or touches the handoff', async () => {
  const h = runnerFixture({ desktop: false });
  await h.runner.runOnce();
  assert.equal(h.modelCalls(), 1, h.diagnostics());
  assert.ok(!h.order.includes('startDesktop'));
  assert.deepEqual(h.handoffCalls, []);
  assert.ok(!h.types().some((type) => type.startsWith('desktop.')));
});

test('a desktop is announced once it is reachable, and withdrawn before the sandbox is stopped', async () => {
  const h = runnerFixture({ desktop: true });
  await h.runner.runOnce();

  assert.equal(h.modelCalls(), 1, h.diagnostics());
  const [publish, clear] = h.handoffCalls;
  assert.equal(publish!.call, 'publish');
  assert.equal(publish!.sessionId, 's');
  assert.deepEqual(publish!.handoff, { host: '6080-abcdefghij1234567890x.e2b.test', token: 'traffic-token-fixture' });
  // Expires with the sandbox even if the deletion below never happens.
  assert.equal(publish!.ttl, h.timeoutSeconds + 60);
  assert.equal(clear!.call, 'clear');
  assert.equal(h.handoffCalls.length, 2);

  const ready = h.emitted.find((event) => event.type === 'desktop.ready');
  const ended = h.emitted.filter((event) => event.type === 'desktop.ended');
  assert.deepEqual(ready!.data, desktopSize);
  assert.deepEqual(ended.map((event) => event.data), [{ reason: 'session-ended' }]);
  // Published only after the handoff exists; withdrawn and announced over before the machine is terminated.
  const at = (name: string) => h.order.indexOf(name);
  assert.ok(at('startDesktop') < at('publish') && at('publish') < at('desktop.ready'));
  assert.ok(at('desktop.ready') < at('model'));
  assert.ok(at('model') < at('clear') && at('clear') < at('desktop.ended') && at('desktop.ended') < at('terminate'));
  // The token is a credential: it goes to the handoff and to nothing the user can read.
  assert.equal(JSON.stringify(h.emitted).includes('traffic-token-fixture'), false);
});

test('a desktop that fails to start does not fail the build, and the user is told it is unavailable', async () => {
  const h = runnerFixture({ desktop: true, startDesktop: async () => { throw new Error('provider detail that must not leak'); } });
  await h.runner.runOnce();

  assert.equal(h.modelCalls(), 1, 'the build still ran: ' + h.diagnostics());
  assert.ok(h.order.includes('finish'));
  assert.deepEqual(h.handoffCalls, [], 'nothing was announced to the relay');
  assert.ok(!h.types().includes('desktop.ready'));
  assert.deepEqual(h.emitted.filter((event) => event.type === 'desktop.ended').map((event) => event.data), [{ reason: 'error' }]);
  assert.equal(JSON.stringify(h.emitted).includes('provider detail'), false);
  assert.ok(h.logs.some((entry) => entry.message.includes('continuing without it')));
});

test('a provider with a desktop but a runner with no handoff is a loud failure to show it, not a silent skip', async () => {
  const h = runnerFixture({ desktop: true, withoutHandoffPort: true });
  await h.runner.runOnce();
  assert.equal(h.modelCalls(), 1, h.diagnostics());
  assert.ok(!h.order.includes('startDesktop'));
  assert.ok(h.logs.some((entry) => entry.message.includes('continuing without it')));
  assert.deepEqual(h.emitted.filter((event) => event.type === 'desktop.ended').map((event) => event.data), [{ reason: 'error' }]);
});

test('cancelling while the desktop starts stops the build instead of being swallowed as a desktop failure', async () => {
  let cancel: () => void = () => {};
  const h = runnerFixture({ desktop: true, startDesktop: async (signal) => {
    cancel();
    signal?.throwIfAborted();
    throw new Error('desktop failed after cancellation');
  } });
  cancel = h.cancel;
  await h.runner.runOnce().catch(() => {});

  assert.equal(h.modelCalls(), 0, 'a cancelled session must not go on to run the agent');
  assert.deepEqual(h.emitted.filter((event) => event.type === 'desktop.ended' && (event.data as { reason?: string }).reason === 'error'), []);
  assert.ok(h.types().includes('session.failed'));
});
