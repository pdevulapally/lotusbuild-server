import { AppError } from '../src/http/errors.ts';
import { RestoreError, type RestoreResult } from '../src/projects/persistence.ts';
import assert from 'node:assert/strict';
import { fixtureModels } from './support/models.ts';
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
function fakeE2BSandbox(options: {
  token?: string | undefined;
  onRun?: (command: string) => void;
} = { token: 'traffic-token-fixture' }) {
  const commands: { command: string; opts: Record<string, unknown> }[] = [];
  const sandbox = {
    sandboxId: 'sandbox-fixture',
    ...(options.token === undefined ? {} : { trafficAccessToken: options.token }),
    getHost: (port: number) => `${port}-abcdefghij1234567890x.e2b.test`,
    commands: { run: async (command: string, opts: Record<string, unknown>) => {
      commands.push({ command, opts });
      options.onRun?.(command);
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

function runnerFixture(options: {
  desktop: boolean;
  startDesktop?: (signal?: AbortSignal) => Promise<DesktopHandoff>;
  desktopStartTimeoutMs?: number;
  desktopStartGraceMs?: number;
  withoutHandoffPort?: boolean;
  restore?: () => Promise<string | RestoreResult>;
  publishHandoff?: () => Promise<void>;
  /** The tool the first model step reaches for; a screen tool is what brings the desktop up. */
  firstTool?: 'run_command' | 'open_in_browser';
  /** A durable user request for the desktop, as the session document would carry it. */
  desktopRequested?: { execution: number };
  /** The request appears only after the run's first look at the session, as if it arrived mid-run and its notification was lost. */
  desktopRequestedLater?: boolean;
  heartbeatSeconds?: number;
  /** Holds the final model step open so a heartbeat can fire inside the run. */
  slowFinishMs?: number;
  /** Holds the final save open so a heartbeat can fire during cleanup. */
  slowSaveMs?: number;
}) {
  const firstTool = options.firstTool ?? (options.desktop ? 'open_in_browser' : 'run_command');
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
  const systemPrompts: string[] = [];
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
    stream: (params: Record<string, unknown>) => {
      modelCalls++;
      // The first step reaches for a tool, which is what starts the machine; the
      // 'model' marker is the generation that then runs against it.
      if (modelCalls > 1) order.push('model');
      const hold = modelCalls > 1 && options.slowFinishMs !== undefined ? new Promise<void>((resolve) => setTimeout(resolve, options.slowFinishMs)) : Promise.resolve();
      systemPrompts.push(typeof params.system === 'string' ? params.system : JSON.stringify(params.system ?? ''));
      return { on: () => {}, finalMessage: async () => ({ ...(await hold.then(() => ({}))), content: modelCalls === 1
        ? [{ type: 'tool_use', id: 'look', name: firstTool, input: firstTool === 'run_command' ? { command: 'true' } : { url: 'http://127.0.0.1:5173' } }]
        : [{ type: 'tool_use', id: 'done', name: 'finish_task', input: { outcome: 'blocked', summary: 'Fixture turn complete.', evidence: [] } }],
      usage: { input_tokens: 2, output_tokens: 1 }, stop_reason: 'tool_use' }) }; },
  } } as unknown as Anthropic;
  const session = { id: 's', projectId: 'p', ownerUid: 'u', execution: 1, model: entitlements.capabilities.stringList('ai.model.allowlist')[0],
    effort: 'low', mode: 'build', leaseToken: 'lease', reservationIds: [], specialistReservationIds: [],
    ...(options.desktopRequested === undefined || options.desktopRequestedLater === true ? {} : { desktopRequested: { ...options.desktopRequested, at: new Date() } }) };
  const clearedRequests: number[] = [];
  let reads = 0;
  let requestCleared = false;
  const sessions = {
    saveTaskContext: async () => {}, requireWorkspaceSalvage: async () => {}, claim: async () => session, heartbeat: async () => {}, assertPersistenceLease: async () => { if (cancelled) throw new AppError({ code: 'session/cancelled', statusCode: 409, message: 'Cancelled by user' }); }, markExecutionStarted: async () => {},
    attachSandbox: async () => {}, detachSandbox: async () => {}, drainSteerMessage: async () => undefined,
    listMessages: async () => [{ role: 'user', content: 'Build', seq: 0, attachments: [] }],
    reserveSpecialistTokens: async (_id: string, _runner: string, input: { meterKey: string; quantity: number; operationId: string }) =>
      metering.reserve({ ...input, uid: 'u', entitlements, now: new Date() }),
    forgetSpecialistReservation: async () => {},
    appendAssistantMessage: async () => {}, dequeueNextMessage: async () => undefined,
    readOwned: async () => {
      reads++;
      if (options.desktopRequestedLater === true && options.desktopRequested !== undefined && reads > 1 && !requestCleared) return { ...session, desktopRequested: { ...options.desktopRequested, at: new Date() } };
      return session;
    },
    yieldForRecovery: async () => {}, finish: async () => { order.push('finish'); return 'IDLE'; },
    clearDesktopRequest: async (_authority: unknown, execution: number) => { clearedRequests.push(execution); requestCleared = true; order.push('clearDesktopRequest'); },
  };
  const handoffPort: DesktopHandoffPort = {
    publish: async (sessionId, handoff, ttl) => {
      handoffCalls.push({ call: 'publish', sessionId, handoff, ttl });
      order.push('publish');
      await options.publishHandoff?.();
    },
    clear: async (sessionId) => { handoffCalls.push({ call: 'clear', sessionId }); order.push('clear'); return true; },
  };
  const logs: { message: string; details: Record<string, unknown> }[] = [];
  const capture = (details: object, message: string) => { logs.push({ message, details: details as Record<string, unknown> }); };
  const deps = { models: fixtureModels, runnerId: 'runner', anthropic, sessions, metering, configuration,
    entitlements: { forUser: async () => entitlements },
    projects: { readOwned: async () => ({ id: 'p', platform: 'web', ownerUid: 'u', name: 'Fixture', snapshot: { kind: 'none' } }) },
    sandboxes: new SandboxService(configuration, metering, new Map([['e2b', adapter]])),
    persistence: { restore: async () => { order.push('restore'); return options.restore === undefined ? 'fresh' : options.restore(); },
      save: async () => { order.push('save'); if (options.slowSaveMs !== undefined) await new Promise<void>((resolve) => setTimeout(resolve, options.slowSaveMs)); return { bytes: 1, committed: true }; } },
    events: { subscribe: async (_id: string, listener: typeof cancelListener) => { cancelListener = listener; return () => {}; },
      append: async (_id: string, type: string, data: Record<string, unknown>) => { emitted.push({ type, data }); order.push(type); } },
    limits: { maxSteps: 3, maxOutputTokens: 10, toolOutputMaxChars: 4096, maxSpecialistConsultations: 0, specialistMaxSteps: 1,
      commandTimeoutMs: 1000, previewReadyTimeoutSeconds: 1 },
    heartbeatSeconds: options.heartbeatSeconds ?? 60, messageHistoryLimit: 10, log: { info: capture, warn: capture, error: capture },
    ...(options.desktopStartTimeoutMs === undefined ? {} : { desktopStartTimeoutMs: options.desktopStartTimeoutMs }),
    ...(options.desktopStartGraceMs === undefined ? {} : { desktopStartGraceMs: options.desktopStartGraceMs }),
    ...(options.withoutHandoffPort === true ? {} : { desktop: handoffPort }),
  } as unknown as RunnerDependencies;
  return { runner: new SessionRunner(deps), order, emitted, handoffCalls, logs, timeoutSeconds: registry.sandboxProviders.get('web')!.timeoutSeconds,
    cancel: () => { cancelled = true; cancelListener?.({ type: 'session.cancel_requested' }); }, modelCalls: () => modelCalls,
    requestDesktop: () => cancelListener?.({ type: 'desktop.requested' }), clearedRequests,
    systemPrompts: () => systemPrompts,

    types: () => emitted.map((event) => event.type),
    diagnostics: () => JSON.stringify({ events: emitted, logs: logs.map((entry) => entry.message), order }) };
}

test('a build with no desktop configured never starts one, announces one, or touches the handoff', async () => {
  const h = runnerFixture({ desktop: false });
  await h.runner.runOnce();
  assert.equal(h.modelCalls(), 2, h.diagnostics());
  assert.ok(!h.order.includes('startDesktop'));
  assert.deepEqual(h.handoffCalls, []);
  assert.ok(!h.types().some((type) => type.startsWith('desktop.')));
});

test('a desktop is announced once it is reachable, and withdrawn before the sandbox is stopped', async () => {
  const h = runnerFixture({ desktop: true });
  await h.runner.runOnce();

  assert.equal(h.modelCalls(), 2, h.diagnostics());
  assert.ok(h.handoffCalls.length > 0, h.diagnostics());
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
  assert.deepEqual(ready!.data, { execution: 1, ...desktopSize });
  assert.ok(h.emitted.length > 3 && h.emitted.every((event) => (event.data as { execution?: number }).execution === 1), 'every event this run journals names its run');
  assert.deepEqual(ended.map((event) => event.data), [{ execution: 1, reason: 'session-ended' }]);
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

  assert.equal(h.modelCalls(), 2, 'the build still ran: ' + h.diagnostics());
  assert.ok(h.order.includes('finish'));
  assert.deepEqual(h.handoffCalls, [], 'nothing was announced to the relay');
  assert.ok(!h.types().includes('desktop.ready'));
  assert.deepEqual(h.emitted.filter((event) => event.type === 'desktop.ended').map((event) => event.data), [{ execution: 1, reason: 'error' }]);
  assert.equal(JSON.stringify(h.emitted).includes('provider detail'), false);
  assert.ok(h.logs.some((entry) => entry.message.includes('continuing without it')));
});

test('a provider with a desktop but a runner with no handoff is a loud failure to show it, not a silent skip', async () => {
  const h = runnerFixture({ desktop: true, withoutHandoffPort: true });
  await h.runner.runOnce();
  assert.equal(h.modelCalls(), 2, h.diagnostics());
  assert.ok(!h.order.includes('startDesktop'));
  assert.ok(h.logs.some((entry) => entry.message.includes('continuing without it')));
  assert.deepEqual(h.emitted.filter((event) => event.type === 'desktop.ended').map((event) => event.data), [{ execution: 1, reason: 'error' }]);
});

test('a timed-out desktop start lets the build continue without screen access', async () => {
  let startupSignal: AbortSignal | undefined;
  const h = runnerFixture({
    desktop: true,
    desktopStartTimeoutMs: 50,
    startDesktop: (signal) => {
      startupSignal = signal;
      return new Promise<DesktopHandoff>(() => {});
    },
  });

  await h.runner.runOnce();

  assert.equal(startupSignal?.aborted, true);
  assert.equal(h.modelCalls(), 2, h.diagnostics());
  assert.deepEqual(h.emitted.filter((event) => event.type === 'desktop.ended').map((event) => event.data), [{ execution: 1, reason: 'error' }]);
  assert.ok(!h.types().includes('desktop.ready'));
});

test('a desktop that already failed this run is not started again when the user asks for it', async () => {
  const h = runnerFixture({ desktop: true, desktopRequested: { execution: 1 }, startDesktop: async () => { throw new Error('no display'); } });
  await h.runner.runOnce();
  assert.equal(h.order.filter((step) => step === 'startDesktop').length, 1, h.diagnostics());
  assert.equal(h.modelCalls(), 2, 'the build still ran: ' + h.diagnostics());
  assert.ok(!h.types().includes('desktop.ready'));
  assert.equal(h.clearedRequests.length, 1, 'the request is settled even though the desktop failed');
  assert.ok(h.logs.some((entry) => entry.message.includes('could not be started')));
});

test('a restore failure means no desktop is ever attempted, and nothing is announced', async () => {
  const restoreError = new AppError({ code: 'workspace/unrecoverable', statusCode: 409, message: 'Workspace restoration failed.' });
  const h = runnerFixture({ desktop: true, restore: async () => { throw restoreError; } });
  await h.runner.runOnce();
  assert.ok(!h.order.includes('startDesktop'), h.diagnostics());
  assert.equal(h.modelCalls(), 1, h.diagnostics());
  assert.deepEqual(h.handoffCalls, []);
  assert.ok(!h.types().some((type) => type.startsWith('desktop.')));
  assert.deepEqual(h.emitted.filter((event) => event.type === 'session.failed').map((event) => event.data.error), [restoreError.message]);
});

test('a handoff that does not settle is covered by the desktop startup deadline', async () => {
  const h = runnerFixture({
    desktop: true,
    desktopStartTimeoutMs: 50,
    publishHandoff: () => new Promise<void>(() => {}),
  });

  await h.runner.runOnce();

  assert.equal(h.modelCalls(), 2, h.diagnostics());
  assert.equal(h.handoffCalls[0]?.call, 'publish');
  assert.deepEqual(
    h.emitted.filter((event) => event.type === 'desktop.ended').map((event) => event.data),
    [{ execution: 1, reason: 'error' }],
  );
});

test('a handoff that completes after the startup deadline is withdrawn without announcing ready', async () => {
  let releasePublish!: () => void;
  const publish = new Promise<void>((resolve) => { releasePublish = resolve; });
  const h = runnerFixture({
    desktop: true,
    desktopStartTimeoutMs: 50,
    publishHandoff: () => publish,
  });

  await h.runner.runOnce();

  assert.equal(h.modelCalls(), 2, h.diagnostics());
  assert.deepEqual(
    h.emitted.filter((event) => event.type === 'desktop.ended').map((event) => event.data),
    [{ execution: 1, reason: 'error' }],
  );
  assert.ok(!h.types().includes('desktop.ready'));
  assert.deepEqual(h.handoffCalls.map((call) => call.call), ['publish']);

  releasePublish();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(h.handoffCalls.map((call) => call.call), ['publish', 'clear']);
  assert.ok(h.order.indexOf('clear') > h.order.indexOf('publish'));
});

test('the desktop starts only when the first screen tool asks for it, after the machine and the restore', async () => {
  let resolveDesktop!: (handoff: DesktopHandoff) => void;
  const start = new Promise<DesktopHandoff>((resolve) => { resolveDesktop = resolve; });
  const h = runnerFixture({ desktop: true, startDesktop: () => start });
  const run = h.runner.runOnce();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.ok(h.order.indexOf('startDesktop') >= 0, h.diagnostics());
  assert.ok(h.order.indexOf('restore') < h.order.indexOf('startDesktop'), h.diagnostics());
  assert.ok(!h.types().includes('desktop.ready'));
  assert.equal(h.modelCalls(), 1, 'the screen tool waits for its desktop: ' + h.diagnostics());
  resolveDesktop({ host: '6080-abcdefghij1234567890x.e2b.test', token: 'traffic-token-fixture' });
  await run;
  assert.equal(h.modelCalls(), 2, h.diagnostics());
  assert.ok(h.order.indexOf('desktop.ready') < h.order.indexOf('model'));
});

test('startDesktop does not launch another background step after cancellation', async (t) => {
  const controller = new AbortController();
  const fake = fakeE2BSandbox({
    token: 'traffic-token-fixture',
    onRun: (command) => {
      if (command.startsWith('xdpyinfo')) controller.abort(new Error('desktop setup cancelled'));
    },
  });
  t.mock.method(Sandbox, 'create', async () => fake.sandbox);
  const adapter = new E2BAdapter('fixture', 'example.test', false, 4096);
  const running = await adapter.start(
    registryWith(desktopSize).sandboxProviders.get('web')!,
    { metadata: {}, networkPolicy: { mode: 'unrestricted' } },
  );
  fake.commands.length = 0;

  await assert.rejects(running.startDesktop!(desktopSize, controller.signal), /desktop setup cancelled/);

  assert.ok(fake.commands.some((entry) => entry.command.includes('Xvfb :0')));
  assert.ok(!fake.commands.some((entry) => entry.command.includes('startxfce4')));
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

  assert.equal(h.modelCalls(), 1, 'a cancelled session must not go on to run the agent');
  assert.deepEqual(h.emitted.filter((event) => event.type === 'desktop.ended' && (event.data as { reason?: string }).reason === 'error'), []);
  assert.ok(h.types().includes('session.stopped'), 'a user stop ends STOPPED, not failed');
});

test('a run that only uses the shell never starts the desktop, even on a provider that has one', async () => {
  const h = runnerFixture({ desktop: true, firstTool: 'run_command' });
  await h.runner.runOnce();
  assert.equal(h.modelCalls(), 2, h.diagnostics());
  assert.ok(!h.order.includes('startDesktop'), h.diagnostics());
  assert.deepEqual(h.handoffCalls, []);
  assert.ok(!h.types().some((type) => type.startsWith('desktop.')));
  assert.ok(h.order.includes('terminate'), 'the machine itself was still started for the shell and released');
});

test('a durable user request for this run starts the desktop once, even if the notification never arrives', async () => {
  const h = runnerFixture({ desktop: true, firstTool: 'run_command', desktopRequested: { execution: 1 } });
  await h.runner.runOnce();
  assert.equal(h.order.filter((step) => step === 'startDesktop').length, 1, h.diagnostics());
  assert.deepEqual(h.clearedRequests, [1], 'only this run\'s request is cleared');
  const at = (name: string) => h.order.indexOf(name);
  assert.ok(at('startDesktop') < at('publish') && at('publish') < at('desktop.ready') && at('desktop.ready') < at('model'), h.diagnostics());
});

test('a desktop request aimed at another run is ignored', async () => {
  const h = runnerFixture({ desktop: true, firstTool: 'run_command', desktopRequested: { execution: 2 } });
  await h.runner.runOnce();
  assert.ok(!h.order.includes('startDesktop'), h.diagnostics());
  assert.deepEqual(h.clearedRequests, []);
});

test('an agent screen tool and a user request arriving together start one desktop', async () => {
  const h = runnerFixture({ desktop: true, desktopRequested: { execution: 1 } });
  const run = h.runner.runOnce();
  h.requestDesktop();
  await run;
  assert.equal(h.order.filter((step) => step === 'startDesktop').length, 1, h.diagnostics());
  assert.equal(h.emitted.filter((event) => event.type === 'desktop.ready').length, 1);
});

test('a request that arrives mid-run with its notification lost is found at the next heartbeat', async () => {
  const h = runnerFixture({ desktop: true, firstTool: 'run_command', desktopRequested: { execution: 1 }, desktopRequestedLater: true, heartbeatSeconds: 0.02, slowFinishMs: 120 });
  await h.runner.runOnce();
  assert.equal(h.order.filter((step) => step === 'startDesktop').length, 1, h.diagnostics());
  assert.deepEqual(h.clearedRequests, [1]);
  assert.ok(h.types().includes('desktop.ready'), h.diagnostics());
});

test('a request that lands once final cleanup has begun starts nothing, is settled, and the machine is still released', async () => {
  const h = runnerFixture({ desktop: true, firstTool: 'run_command', desktopRequested: { execution: 1 }, desktopRequestedLater: true, heartbeatSeconds: 0.02, slowSaveMs: 120 });
  await h.runner.runOnce();
  assert.ok(!h.order.includes('startDesktop'), h.diagnostics());
  assert.deepEqual(h.clearedRequests, [1], 'the request is settled rather than left for a run that is over');
  assert.ok(!h.types().some((type) => type.startsWith('desktop.')));
  assert.ok(h.logs.some((entry) => entry.message.includes('could not be started')));
  const at = (name: string) => h.order.indexOf(name);
  assert.ok(at('save') < at('terminate') && at('terminate') >= 0, h.diagnostics());
});

test('a desktop still starting when the run ends is settled before the machine is released', async () => {
  let release!: (handoff: DesktopHandoff) => void;
  const h = runnerFixture({ desktop: true, desktopRequested: { execution: 1 }, firstTool: 'run_command',
    startDesktop: (signal) => new Promise<DesktopHandoff>((resolve, reject) => { release = resolve; signal?.addEventListener('abort', () => reject(signal.reason), { once: true }); }) });
  const run = h.runner.runOnce();
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  assert.ok(h.order.includes('startDesktop'), h.diagnostics());
  await run;
  const at = (name: string) => h.order.indexOf(name);
  assert.ok(at('terminate') >= 0 && !h.types().includes('desktop.ready'), h.diagnostics());
  release({ host: 'late.e2b.test', token: 'late' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(h.handoffCalls.filter((call) => call.call === 'publish'), [], 'a start aborted by cleanup never publishes a handoff');
});

test('a restore that fails mid-download still leaves its transfer evidence in the run summary', async () => {
  const restoreError = new RestoreError({ exitCode: 22, stderr: 'curl: (22) 403', phase: 'download', evidence: { observedBytes: 512, httpCode: 403 } });
  const h = runnerFixture({ desktop: true, restore: async () => { throw restoreError; } });
  await h.runner.runOnce();
  // The failure itself is exactly as before.
  assert.deepEqual(h.emitted.filter((event) => event.type === 'session.failed').map((event) => event.data.error), [restoreError.message]);
  assert.ok(!h.order.includes('save'), 'a workspace whose history was never restored is not saved');
  const summary = h.logs.find((entry) => entry.message === 'run summary')!.details;
  assert.deepEqual([summary['restoreOutcome'], summary['restorePhase'], summary['restoreObservedBytes'], summary['restoreHttpCode'], summary['restoreArchiveBytes']],
    ['failed', 'download', 512, 403, undefined]);
});

test('a restore whose archive is shorter than the record is noted and warned about, and the run proceeds', async () => {
  const h = runnerFixture({ desktop: true, restore: async () => ({ outcome: 'restored' as const, observedBytes: 1024, httpCode: 200, archiveBytes: 1024 }) });
  await h.runner.runOnce();
  assert.ok(h.types().includes('project.restored'));
  const summary = h.logs.find((entry) => entry.message === 'run summary')!.details;
  assert.deepEqual([summary['restoreOutcome'], summary['restoreObservedBytes'], summary['restoreArchiveBytes'], summary['restoreBytesMatch']], ['restored', 1024, 1024, false]);
  assert.ok(h.logs.some((entry) => entry.message.includes('restored archive size differs')));
});
