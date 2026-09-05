import assert from 'node:assert/strict';
import { test } from 'node:test';

import type Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlock,
  MessageParam,
  MessageStreamEvent,
} from '@anthropic-ai/sdk/resources/messages';

import type { Registry, SandboxProvider, SpecialistDefinition } from '../src/entitlements/schema.ts';
import { ResolvedEntitlements, type UserEntitlements } from '../src/entitlements/service.ts';
import type { MeteringService } from '../src/metering/service.ts';
import type { Project } from '../src/projects/repository.ts';
import type { CommandOutcome, RunningSandbox } from '../src/sandboxes/provider.ts';
import type { BuildSession } from '../src/sessions/repository.ts';
import {
  type AgentEvents,
  type AgentLimits,
  blockerExplanation,
  parseReview,
  runAgentTurn,
} from '../src/runner/agent.ts';
import {
  type ToolContext,
  makeRunValidation,
  validationCheckpointScript,
  validationRestoreScript,
} from '../src/runner/tools.ts';
import { reconcileSpecialistReservations } from '../src/runner/loop.ts';

const provider: SandboxProvider = {
  platform: 'web',
  provider: 'e2b',
  template: 'test-template',
  timeoutSeconds: 60,
  memoryMb: 512,
  cpus: 1,
  concurrencyMeterKey: 'sandbox.concurrent.web',
  workdir: '/workspace',
  idleGraceSeconds: 5,
  agentInstructions: 'build the thing',
  validationProfiles: new Map([
    ['typecheck', 'run-typecheck'],
    ['test', 'run-tests'],
  ]),
};

const architecture: SpecialistDefinition = {
  key: 'architecture',
  label: 'Architecture',
  purpose: 'reviews whether a change fits the codebase',
  instructions: 'SECRET-ARCHITECTURE-INSTRUCTIONS',
  parallelSafe: true,
  validation: false,
};

const security: SpecialistDefinition = {
  key: 'security',
  label: 'Security',
  purpose: 'reviews security-sensitive work',
  instructions: 'SECRET-SECURITY-INSTRUCTIONS',
  parallelSafe: true,
  validation: false,
};

const testing: SpecialistDefinition = {
  key: 'testing',
  label: 'Testing',
  purpose: 'runs the project validation and judges it',
  instructions: 'SECRET-TESTING-INSTRUCTIONS',
  parallelSafe: false,
  validation: true,
};

function registryWith(specialists: readonly SpecialistDefinition[]): Registry {
  return {
    defaultPlanKey: 'free',
    sandboxTimeMeterKey: 'sandbox.seconds',
    buildMeterKey: 'builds.started',
    inputTokenMeterKey: 'ai.tokens.input',
    outputTokenMeterKey: 'ai.tokens.output',
    storageMeterKey: 'storage.bytes',
    entitlingSubscriptionStatuses: ['ACTIVE'],
    capabilities: new Map(),
    meters: new Map(),
    entitlementSources: new Map(),
    sandboxProviders: new Map([['web', provider]]),
    specialists: new Map(specialists.map((specialist) => [specialist.key, specialist])),
  };
}

const entitlements: UserEntitlements = {
  planKey: 'test',
  planName: 'Test',
  subscriptionStatus: undefined,
  capabilities: new ResolvedEntitlements(new Map()),
  meterLimits: new Map(),
  rateLimits: new Map(),
};

const project: Project = {
  id: 'project-1',
  ownerUid: 'user-1',
  name: 'Project',
  description: undefined,
  platform: 'web',
  status: 'draft',
  snapshotBytes: 0,
  snapshot: { kind: 'none' },
  activeSessionId: 'session-1',
  createdAt: new Date(0),
};

const session: BuildSession = {
  id: 'session-1',
  projectId: 'project-1',
  ownerUid: 'user-1',
  status: 'RUNNING',
  model: 'model-1',
  effort: 'standard',
  sandboxId: 'sandbox-1',
  claimedBy: 'runner-a',
  leaseToken: 'lease-a',
  heartbeatAt: new Date(0),
  error: undefined,
  cancelRequested: undefined,
  reservationIds: [],
  specialistReservationIds: [],
  messageCount: 1,
  createdAt: new Date(0),
};

const limits: AgentLimits = {
  maxSteps: 10,
  maxOutputTokens: 1000,
  toolOutputMaxChars: 5000,
  commandTimeoutMs: 1000,
  previewReadyTimeoutSeconds: 5,
  maxSpecialistConsultations: 2,
  specialistMaxSteps: 4,
};

/** One recorded model invocation, so a test can see what an agent was granted. */
interface ModelCall {
  readonly system: string;
  readonly toolNames: readonly string[];
  readonly messages: readonly MessageParam[];
}

function say(text: string): { content: ContentBlock[]; stop_reason: string } {
  return { content: [{ type: 'text', text, citations: null }], stop_reason: 'end_turn' };
}

function call(
  name: string,
  input: Record<string, unknown>,
): { content: ContentBlock[]; stop_reason: string } {
  return {
    content: [{ type: 'tool_use', id: `tool-${name}`, name, input, caller: { type: 'direct' } }],
    stop_reason: 'tool_use',
  };
}

interface Reply {
  readonly content: ContentBlock[];
  readonly stop_reason: string;
  /** Usage events the provider emits before this reply resolves. */
  readonly events?: readonly MessageStreamEvent[];
  /** Aborts partway, after the events above have been observed. */
  readonly abortAfterEvents?: boolean;
}

type Responder = (call: ModelCall) => Reply | Promise<Reply>;

function messageStart(input: number, cacheRead = 0, cacheCreation = 0): MessageStreamEvent {
  return {
    type: 'message_start',
    message: {
      id: 'msg-1',
      type: 'message',
      role: 'assistant',
      model: 'model-1',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      container: null,
      stop_details: null,
      usage: {
        input_tokens: input,
        output_tokens: 1,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreation,
        cache_creation: null,
        server_tool_use: null,
        service_tier: null,
        inference_geo: null,
        output_tokens_details: null,
      },
    },
  };
}

function textDelta(text: string): MessageStreamEvent {
  return { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } };
}

function messageDelta(output: number): MessageStreamEvent {
  return {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null, container: null, stop_details: null },
    usage: {
      output_tokens: output,
      input_tokens: null,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
      output_tokens_details: null,
      server_tool_use: null,
    },
  };
}

class ScriptedAnthropic {
  readonly calls: ModelCall[] = [];
  readonly #script: Responder[];

  constructor(script: readonly Responder[]) {
    this.#script = [...script];
  }

  get messages() {
    return {
      stream: (
        params: { system: string; tools: readonly { name: string }[]; messages: MessageParam[] },
        options?: { signal?: AbortSignal },
      ) => {
        const recorded: ModelCall = {
          system: params.system,
          toolNames: params.tools.map((tool) => tool.name),
          messages: [...params.messages],
        };
        this.calls.push(recorded);
        const responder = this.#script.shift();
        const signal = options?.signal;
        const listeners: ((event: MessageStreamEvent) => void)[] = [];
        return {
          on(event: string, listener: (value: never) => void): void {
            if (event === 'streamEvent') {
              listeners.push(listener as (value: MessageStreamEvent) => void);
            }
          },
          async finalMessage() {
            if (signal !== undefined && signal.aborted) {
              throw new Error('Request was aborted.');
            }
            if (responder === undefined) {
              throw new Error('The script ran out of responses.');
            }
            // A responder may be asynchronous, so a test can hold one call in
            // flight while another proceeds — which is how concurrency and
            // completion-order inversion are exercised.
            const reply = await responder(recorded);
            // Delivered before the call resolves, exactly as the SDK emits them
            // while the response streams in.
            for (const event of reply.events ?? []) {
              for (const listener of listeners) {
                listener(event);
              }
            }
            if (reply.abortAfterEvents === true) {
              throw new Error('Request was aborted.');
            }
            return { ...reply, usage: { input_tokens: 10, output_tokens: 20 } };
          },
        };
      },
    };
  }
}

function anthropicOf(script: readonly Responder[]): {
  client: Anthropic;
  scripted: ScriptedAnthropic;
} {
  const scripted = new ScriptedAnthropic(script);
  // The fake stands in at the SDK boundary; nothing here narrows a real type.
  return { client: scripted as unknown as Anthropic, scripted };
}

class FakeMetering {
  async recordObservedUsage(): Promise<void> {}
  readonly consumed: { meterKey: string; quantity: number }[] = [];
  readonly reserved: { meterKey: string; quantity: number }[] = [];
  readonly settled: number[] = [];
  readonly released: string[] = [];
  /** Mirrors the real service: a hold closes exactly once. */
  readonly closed = new Set<string>();
  settleFails = false;
  #next = 0;

  async consume(input: { meterKey: string; quantity: number }): Promise<{ consumed: number }> {
    this.consumed.push({ meterKey: input.meterKey, quantity: input.quantity });
    return { consumed: input.quantity };
  }

  async reserve(input: { meterKey: string; quantity: number }): Promise<{ id: string }> {
    this.reserved.push({ meterKey: input.meterKey, quantity: input.quantity });
    this.#next += 1;
    return { id: `reservation-${this.#next}` };
  }

  async settle(input: { reservationId: string; actualQuantity: number }): Promise<boolean> {
    if (this.settleFails) {
      throw new Error('the ledger could not be written');
    }
    if (this.closed.has(input.reservationId)) {
      return false;
    }
    this.closed.add(input.reservationId);
    this.settled.push(input.actualQuantity);
    return true;
  }

  async release(_uid: string, reservationId: string): Promise<boolean> {
    if (this.closed.has(reservationId)) {
      return false;
    }
    this.closed.add(reservationId);
    this.released.push(reservationId);
    return true;
  }
}

function meteringOf(fake: FakeMetering): MeteringService {
  return fake as unknown as MeteringService;
}

/**
 * Stands in for the atomic take-and-record transaction. `take` either produces
 * both the hold and its session record or neither, which is what the real
 * single Firestore transaction guarantees.
 */
class FakeReservations {
  readonly open = new Set<string>();
  readonly order: string[] = [];
  readonly metering: FakeMetering;
  takeFails = false;
  forgetFails = false;

  constructor(metering: FakeMetering = new FakeMetering()) {
    this.metering = metering;
  }

  async take(input: {
    readonly meterKey: string;
    readonly quantity: number;
    readonly operationId: string;
  }): Promise<{ readonly id: string }> {
    if (this.takeFails) {
      // Nothing is reserved and nothing is recorded: one transaction, refused.
      throw new Error('the session could not be written');
    }
    const reservation = await this.metering.reserve(input);
    this.open.add(reservation.id);
    this.order.push(`take:${reservation.id}`);
    return reservation;
  }

  async forget(reservationId: string): Promise<void> {
    if (this.forgetFails) {
      throw new Error('the session could not be written');
    }
    this.open.delete(reservationId);
    this.order.push(`forget:${reservationId}`);
  }
}

class FakeSandbox implements RunningSandbox {
  readonly externalId = 'sandbox-1';
  readonly commands: string[] = [];
  readonly writes: string[] = [];

  async runCommand(command: string): Promise<CommandOutcome> {
    this.commands.push(command);
    return { exitCode: 0, stdout: 'ok', stderr: '' };
  }

  async writeFile(path: string): Promise<void> {
    this.writes.push(path);
  }

  async readFile(): Promise<string> {
    return 'file contents';
  }

  previewUrl(): string {
    return 'https://preview.invalid';
  }

  async stop(): Promise<void> {}
}

interface Published {
  readonly type: string;
  readonly data: Record<string, unknown>;
}

function eventsOf(published: Published[]): AgentEvents {
  return {
    text: () => {},
    toolCall: async () => {},
    toolResult: async () => {},
    preview: async () => {},
    step: async () => {},
    specialistStarted: async (detail) => {
      published.push({ type: 'agent.specialist_started', data: { ...detail } });
    },
    specialistCompleted: async (detail) => {
      published.push({ type: 'agent.specialist_completed', data: { ...detail } });
    },
  };
}

function review(
  verdict: string,
  summary: string,
  findings: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return { verdict, summary, findings: [...findings] };
}

const oneFinding = [
  { severity: 'high', claim: 'No ownership check', evidence: 'src/routes.ts:42' },
];

async function turn(options: {
  readonly script: readonly Responder[];
  readonly specialists?: readonly SpecialistDefinition[];
  readonly limits?: AgentLimits;
  readonly signal?: AbortSignal;
  readonly sandbox?: FakeSandbox;
  readonly published?: Published[];
  readonly metering?: FakeMetering;
  readonly reservations?: FakeReservations;
  readonly problems?: { error: Error; what: string }[];
}) {
  const { client, scripted } = anthropicOf(options.script);
  const sandbox = options.sandbox ?? new FakeSandbox();
  const published = options.published ?? [];
  const metering = options.metering ?? new FakeMetering();
  const reservations = options.reservations ?? new FakeReservations(metering);
  const problems = options.problems ?? [];
  const run = await runAgentTurn({
    withValidationSandbox: sandbox instanceof ValidationSandbox ? sandbox.withCopy.bind(sandbox) : undefined,
    // Agent orchestration tests inject the billing boundary. The real admission
    // service's reserve-before-dispatch protocol is covered independently.
    admission: { begin: async ({ outputReservationId }) => ({ settle: async (usage) => {
      if (usage.input !== undefined && usage.input > 0) await metering.consume({ meterKey: 'ai.tokens.input', quantity: usage.input });
      if (outputReservationId === undefined && usage.output !== undefined && usage.output > 0) {
        await metering.consume({ meterKey: 'ai.tokens.output', quantity: usage.output });
      }
    } }) },
    anthropic: client,
    session,
    project,
    provider,
    sandbox,
    messages: [{ seq: 0, role: 'user', content: 'do the thing', createdAt: new Date(0) }],
    entitlements,
    registry: registryWith(options.specialists ?? [architecture, security]),
    metering: meteringOf(metering),
    limits: options.limits ?? limits,
    events: eventsOf(published),
    signal: options.signal ?? new AbortController().signal,
    assertStillOurs: () => {},
    drainSteer: () => undefined,
    reservations,
    onProblem: (error, what) => {
      problems.push({ error, what });
    },
  });
  return { run, scripted, sandbox, published, metering, reservations, problems };
}

test('a turn completes without consulting anyone', async () => {
  const { run, scripted, published, metering } = await turn({
    script: [() => say('Renamed the variable.')],
  });

  assert.equal(run.reply, 'Renamed the variable.');
  assert.deepEqual(run.unresolvedBlockers, []);
  // One model call, no specialist events, and nothing reserved: an unused
  // capability costs nothing.
  assert.equal(scripted.calls.length, 1);
  assert.deepEqual(published, []);
  assert.deepEqual(metering.reserved, []);
});

test('the primary agent is offered consultation but is never made to use it', async () => {
  const { scripted } = await turn({ script: [() => say('done')] });

  const primary = scripted.calls[0];
  assert.ok(primary !== undefined);
  assert.ok(primary.toolNames.includes('consult_specialist'));
  assert.ok(primary.toolNames.includes('write_file'));
});

test('consultation is not offered when no specialist is configured', async () => {
  const { scripted } = await turn({ script: [() => say('done')], specialists: [] });

  assert.equal(scripted.calls[0]?.toolNames.includes('consult_specialist'), false);
});

for (const specialist of [security, architecture]) {
  test(`the primary agent can consult ${specialist.key} when it judges it useful`, async () => {
    const { run, scripted, published } = await turn({
      script: [
        () => call('consult_specialist', { role: specialist.key, question: 'Is this safe?' }),
        () => call('submit_review', review('ok', 'Nothing to change.', [])),
        () => say('All good.'),
      ],
    });

    assert.deepEqual(run.unresolvedBlockers, []);
    const specialistCall = scripted.calls[1];
    assert.ok(specialistCall !== undefined);
    assert.ok(specialistCall.system.includes(specialist.instructions));
    assert.equal(
      published.filter((event) => event.type === 'agent.specialist_started').length,
      1,
    );
  });
}

test('a specialist receives read-only tools and cannot delegate further', async () => {
  const { scripted } = await turn({
    script: [
      () => call('consult_specialist', { role: 'security', question: 'Is this safe?' }),
      () => call('submit_review', review('ok', 'Fine.', [])),
      () => say('done'),
    ],
  });

  const specialistCall = scripted.calls[1];
  assert.ok(specialistCall !== undefined);
  assert.deepEqual([...specialistCall.toolNames].sort(), [
    'list_files',
    'read_file',
    'search_files',
    'submit_review',
  ]);
  // Depth is one because the tool does not exist further down, not because a
  // counter says so.
  assert.equal(specialistCall.toolNames.includes('consult_specialist'), false);
  assert.equal(specialistCall.toolNames.includes('write_file'), false);
  assert.equal(specialistCall.toolNames.includes('run_command'), false);
  assert.equal(specialistCall.toolNames.includes('start_preview'), false);
});

test('a specialist asking for write_file is refused by dispatch, not by the prompt', async () => {
  const sandbox = new FakeSandbox();
  const { scripted } = await turn({
    sandbox,
    script: [
      () => call('consult_specialist', { role: 'security', question: 'Is this safe?' }),
      () => call('write_file', { path: 'app.js', content: 'malicious' }),
      () => call('submit_review', review('ok', 'Fine.', [])),
      () => say('done'),
    ],
  });

  assert.deepEqual(sandbox.writes, []);
  // The refusal came back to the specialist as a tool result it must read.
  const afterRefusal = scripted.calls[2];
  assert.ok(afterRefusal !== undefined);
  assert.match(JSON.stringify(afterRefusal.messages), /is not available to this agent/);
});

test('a specialist does not reach the primary agent transcript', async () => {
  const { scripted } = await turn({
    script: [
      () => call('consult_specialist', { role: 'security', question: 'Review the login route.' }),
      () => call('submit_review', review('ok', 'Fine.', [])),
      () => say('done'),
    ],
  });

  const specialistCall = scripted.calls[1];
  assert.ok(specialistCall !== undefined);
  const conversation = JSON.stringify(specialistCall.messages);
  assert.match(conversation, /Review the login route\./);
  // The user's own prompt to the primary agent is not replayed.
  assert.equal(conversation.includes('do the thing'), false);
});

test('a malformed review is refused rather than guessed at', () => {
  assert.throws(() => parseReview({ verdict: 'maybe', summary: 'x', findings: [] }), /verdict/);
  assert.throws(() => parseReview({ verdict: 'ok', summary: '', findings: [] }), /summary/);
  assert.throws(() => parseReview({ verdict: 'ok', summary: 'x' }), /findings/);
  // A verdict that asks for action must point at something.
  assert.throws(
    () => parseReview({ verdict: 'blocking', summary: 'x', findings: [] }),
    /at least one finding/,
  );
  assert.throws(
    () => parseReview({ verdict: 'concern', summary: 'x', findings: [{ severity: 'a', claim: 'b' }] }),
    /evidence/,
  );
  const parsed = parseReview(review('concern', 'One thing', oneFinding));
  assert.equal(parsed.verdict, 'concern');
  assert.equal(parsed.findings[0]?.evidence, 'src/routes.ts:42');
  assert.equal(parsed.findings[0]?.suggestion, undefined);
});

test('a malformed review comes back to the specialist to correct', async () => {
  const { run, scripted } = await turn({
    script: [
      () => call('consult_specialist', { role: 'security', question: 'Is this safe?' }),
      () => call('submit_review', { verdict: 'definitely-not', summary: 'x', findings: [] }),
      () => call('submit_review', review('ok', 'Fine after all.', [])),
      () => say('done'),
    ],
  });

  assert.deepEqual(run.unresolvedBlockers, []);
  const retry = scripted.calls[2];
  assert.ok(retry !== undefined);
  assert.match(JSON.stringify(retry.messages), /verdict.{0,4} must be one of ok, concern, blocking/);
});

test('a concern returns to the primary agent as structured context and blocks nothing', async () => {
  const { run, scripted } = await turn({
    script: [
      () => call('consult_specialist', { role: 'architecture', question: 'Does this fit?' }),
      () => call('submit_review', review('concern', 'Config belongs elsewhere.', oneFinding)),
      () => say('Noted, moved it.'),
    ],
  });

  assert.deepEqual(run.unresolvedBlockers, []);
  const afterReview = scripted.calls[2];
  assert.ok(afterReview !== undefined);
  const seen = JSON.stringify(afterReview.messages);
  assert.match(seen, /Config belongs elsewhere\./);
  assert.match(seen, /src\/routes\.ts:42/);
});

test('a blocking finding is tracked and survives the agent claiming it is done', async () => {
  const { run } = await turn({
    script: [
      () => call('consult_specialist', { role: 'security', question: 'Is this safe?' }),
      () => call('submit_review', review('blocking', 'No ownership check.', oneFinding)),
      // The model says it finished. The ledger disagrees, and the ledger wins.
      () => say('All done!'),
    ],
  });

  assert.equal(run.unresolvedBlockers.length, 1);
  assert.equal(run.unresolvedBlockers[0]?.role, 'security');
  assert.equal(run.unresolvedBlockers[0]?.label, 'Security');
  assert.deepEqual(run.unresolvedBlockers[0]?.claims, ['No ownership check']);
  assert.equal(run.stopReason, 'blocked');
});

test('the primary agent may fix a blocker and clear it by consulting again', async () => {
  const sandbox = new FakeSandbox();
  const { run, sandbox: used } = await turn({
    sandbox,
    script: [
      () => call('consult_specialist', { role: 'security', question: 'Is this safe?' }),
      () => call('submit_review', review('blocking', 'No ownership check.', oneFinding)),
      // Continues working to resolve it rather than stopping.
      () => call('write_file', { path: 'routes.ts', content: 'with ownership check' }),
      () =>
        call('consult_specialist', {
          role: 'security',
          question: 'Fixed. Check again?',
          resolves: 'security-1',
        }),
      () => call('submit_review', review('ok', 'Ownership is now enforced.', [])),
      () => say('Added the ownership check.'),
    ],
  });

  assert.deepEqual(run.unresolvedBlockers, []);
  assert.notEqual(run.stopReason, 'blocked');
  assert.deepEqual(used.writes, ['/workspace/routes.ts']);
});

test('an unresolved blocker produces a user explanation and never an exception', async () => {
  const { run } = await turn({
    script: [
      () => call('consult_specialist', { role: 'security', question: 'Is this safe?' }),
      () => call('submit_review', review('blocking', 'Cross-user project access.', oneFinding)),
      () => say('Finished.'),
    ],
  });

  // Resolving without throwing is what keeps the session on the IDLE path:
  // a safe refusal is a decision, not an execution failure.
  const explanation = blockerExplanation(run.unresolvedBlockers);
  assert.match(explanation, /couldn't safely complete this change/);
  assert.match(explanation, /Security: Cross-user project access\./);
  assert.match(explanation, /No ownership check/);
});

test('specialist events carry conclusions and never instructions or reasoning', async () => {
  const published: Published[] = [];
  await turn({
    published,
    script: [
      () => call('consult_specialist', { role: 'security', question: 'Is this safe?' }),
      () => call('submit_review', review('blocking', 'No ownership check.', oneFinding)),
      () => say('done'),
    ],
  });

  const started = published.find((event) => event.type === 'agent.specialist_started');
  const completed = published.find((event) => event.type === 'agent.specialist_completed');
  assert.deepEqual(started?.data, { role: 'security', label: 'Security' });
  assert.deepEqual(completed?.data, {
    role: 'security',
    label: 'Security',
    verdict: 'blocking',
    findings: 1,
    summary: 'No ownership check.',
  });
  const wire = JSON.stringify(published);
  assert.equal(wire.includes('SECRET-SECURITY-INSTRUCTIONS'), false);
  assert.equal(wire.includes('src/routes.ts:42'), false);
});

test('the consultation budget is enforced and does not end the turn', async () => {
  const { run, published } = await turn({
    limits: { ...limits, maxSpecialistConsultations: 1 },
    script: [
      () => call('consult_specialist', { role: 'security', question: 'One' }),
      () => call('submit_review', review('ok', 'Fine.', [])),
      () => call('consult_specialist', { role: 'architecture', question: 'Two' }),
      () => say('Carried on by myself.'),
    ],
  });

  assert.equal(run.reply, 'Carried on by myself.');
  // The refused second consultation started nothing.
  assert.equal(
    published.filter((event) => event.type === 'agent.specialist_started').length,
    1,
  );
});

test('a specialist that never reports is abandoned at its step limit', async () => {
  const { run, scripted } = await turn({
    limits: { ...limits, specialistMaxSteps: 2 },
    script: [
      () => call('consult_specialist', { role: 'security', question: 'Is this safe?' }),
      () => call('read_file', { path: 'a.ts' }),
      () => call('read_file', { path: 'b.ts' }),
      () => say('Continued without the review.'),
    ],
  });

  // Two specialist calls, then the primary agent is told and carries on.
  assert.equal(scripted.calls.length, 4);
  assert.equal(run.reply, 'Continued without the review.');
  assert.deepEqual(run.unresolvedBlockers, []);
});

test('a specialist failure alone does not fail the turn', async () => {
  const { run } = await turn({
    script: [
      () => call('consult_specialist', { role: 'nobody', question: 'Is this safe?' }),
      () => say('Carried on.'),
    ],
  });

  assert.equal(run.reply, 'Carried on.');
});

test('specialist output tokens are held before the call and settled after', async () => {
  const metering = new FakeMetering();
  await turn({
    metering,
    script: [
      () => call('consult_specialist', { role: 'security', question: 'Is this safe?' }),
      () => call('submit_review', review('ok', 'Fine.', [])),
      () => say('done'),
    ],
  });

  // Reserved at the ceiling the consultation could reach, then settled at what
  // it actually spent — never charged twice.
  assert.deepEqual(metering.reserved, [
    { meterKey: 'ai.tokens.output', quantity: limits.specialistMaxSteps * limits.maxOutputTokens },
  ]);
  assert.deepEqual(metering.settled, [20]);
  assert.equal(
    metering.consumed.filter((entry) => entry.meterKey === 'ai.tokens.output').length,
    2,
  );
});

test('cancellation stops the primary model call', async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    turn({ signal: controller.signal, script: [() => say('never reached')] }),
    /aborted/,
  );
});

test('cancellation stops a specialist model call', async () => {
  const controller = new AbortController();

  await assert.rejects(
    turn({
      signal: controller.signal,
      script: [
        () => {
          // Cancelled while the primary turn is mid-flight; the specialist call
          // that follows must not start paying for a stream of its own.
          controller.abort();
          return call('consult_specialist', { role: 'security', question: 'Is this safe?' });
        },
        () => say('never reached'),
      ],
    }),
    /aborted/,
  );
});

const consultMessage = (question = 'Is this safe?'): ReturnType<Responder> =>
  call('consult_specialist', { role: 'security', question });

const consult = (question = 'Is this safe?'): Responder => () => consultMessage(question);

test('a normal consultation records its hold, settles once, and clears the record', async () => {
  const { metering, reservations } = await turn({
    script: [consult(), () => call('submit_review', review('ok', 'Fine.', [])), () => say('done')],
  });

  assert.equal(metering.reserved.length, 1);
  assert.deepEqual(metering.settled, [20]);
  assert.deepEqual(metering.released, []);
  // Taken and recorded in one step, forgotten only after the settle.
  assert.deepEqual(reservations.order, ['take:reservation-1', 'forget:reservation-1']);
  assert.equal(reservations.open.size, 0);
});

test('a specialist that fails normally still finalises its hold', async () => {
  const { run, metering, reservations } = await turn({
    limits: { ...limits, specialistMaxSteps: 1 },
    // One step, no review recorded: an ordinary specialist failure.
    script: [consult(), () => call('read_file', { path: 'a.ts' }), () => say('carried on')],
  });

  assert.equal(run.reply, 'carried on');
  assert.deepEqual(metering.settled, [20]);
  assert.equal(reservations.open.size, 0);
});

test('cancellation before a consultation prevents both the tool and its reservation', async () => {
  const controller = new AbortController();
  const metering = new FakeMetering();
  const reservations = new FakeReservations(metering);
  await assert.rejects(turn({ metering, reservations, signal: controller.signal,
    script: [() => { controller.abort(); return consultMessage(); }, () => say('never reached')],
  }), /aborted/);
  assert.deepEqual(metering.reserved, []);
  assert.deepEqual(metering.settled, []);
  assert.equal(reservations.open.size, 0);
});

test('a refused take creates neither the hold nor the session record', async () => {
  const metering = new FakeMetering();
  const reservations = new FakeReservations(metering);
  reservations.takeFails = true;

  const { scripted } = await turn({
    metering,
    reservations,
    script: [consult(), () => say('carried on without the review')],
  });

  // One transaction, refused: no hold, no pointer, nothing to recover.
  assert.deepEqual(metering.reserved, []);
  assert.deepEqual(metering.released, []);
  assert.deepEqual(metering.settled, []);
  assert.equal(reservations.open.size, 0);
  // The consultation is a tool call, so the agent is told it failed rather than
  // the whole turn dying over an optional review.
  const afterFailure = scripted.calls[1];
  assert.ok(afterFailure !== undefined);
  assert.match(JSON.stringify(afterFailure.messages), /the session could not be written/);
});

test('a taken hold is recorded in the same step it is created', async () => {
  const { reservations, metering } = await turn({
    script: [consult(), () => call('submit_review', review('ok', 'Fine.', [])), () => say('done')],
  });

  // There is no representable committed state with a reservation and no record:
  // the fake mirrors the single transaction, so both appear together or not.
  assert.equal(metering.reserved.length, 1);
  assert.deepEqual(reservations.order, ['take:reservation-1', 'forget:reservation-1']);
});

test('a settled hold whose record cannot be cleared does not fail the consultation', async () => {
  const metering = new FakeMetering();
  const reservations = new FakeReservations(metering);
  const problems: { error: Error; what: string }[] = [];
  const { run } = await turn({
    metering,
    reservations,
    problems,
    script: [
      consult(),
      () => {
        // Settles fine; only the bookkeeping write fails afterwards.
        reservations.forgetFails = true;
        return call('submit_review', review('ok', 'Fine.', []));
      },
      () => say('done'),
    ],
  });

  assert.equal(run.reply, 'done');
  assert.deepEqual(metering.settled, [20]);
  assert.equal(problems.length, 1);
  assert.match(problems[0]?.what ?? '', /clearing settled specialist reservation/);
});

test('a settlement failure with no earlier error is raised and reported, never hidden', async () => {
  const metering = new FakeMetering();
  metering.settleFails = true;
  const problems: { error: Error; what: string }[] = [];
  const reservations = new FakeReservations(metering);

  const { scripted } = await turn({
    metering,
    problems,
    reservations,
    script: [
      consult(),
      () => call('submit_review', review('ok', 'Fine.', [])),
      () => say('carried on'),
    ],
  });

  // The review is not handed back as though it had been paid for.
  const afterFailure = scripted.calls[2];
  assert.ok(afterFailure !== undefined);
  const seen = JSON.stringify(afterFailure.messages);
  assert.match(seen, /the ledger could not be written/);
  assert.equal(seen.includes('verdict: ok'), false);
  // Reported to the operator too, and the hold stays recorded so recovery can
  // still reach it.
  assert.equal(problems.length, 1);
  assert.match(problems[0]?.what ?? '', /settling specialist reservation/);
  assert.deepEqual([...reservations.open], ['reservation-1']);
});

test('a settlement failure never displaces the error that actually stopped the work', async () => {
  const controller = new AbortController();
  const metering = new FakeMetering();
  metering.settleFails = true;
  const problems: { error: Error; what: string }[] = [];

  await assert.rejects(
    turn({
      metering,
      problems,
      signal: controller.signal,
      script: [
        consult(),
        () => { controller.abort(); return { ...say('partial'), events: [messageDelta(7)], abortAfterEvents: true }; },
      ],
    }),
    // The cancellation is what went wrong, not the settlement that followed it.
    /aborted/,
  );

  // …and the settlement failure is not discarded.
  assert.equal(problems.length, 1);
  assert.match(problems[0]?.what ?? '', /settling specialist reservation .* after an earlier failure/);
  assert.match(problems[0]?.error.message ?? '', /the ledger could not be written/);
});

/** Recovery, as a successor runner performs it from the session document. */
function recoveryHarness() {
  const metering = new FakeMetering();
  const forgotten: string[] = [];
  const problems: { error: Error; what: string }[] = [];
  return {
    metering,
    forgotten,
    problems,
    run: (reservationIds: readonly string[], forget?: (id: string) => Promise<void>) =>
      reconcileSpecialistReservations({
        uid: 'user-1',
        reservationIds,
        release: (uid, reservationId) => metering.release(uid, reservationId),
        forget:
          forget ??
          (async (reservationId: string) => {
            forgotten.push(reservationId);
          }),
        onProblem: (error, what) => {
          problems.push({ error, what });
        },
        now: new Date(0),
      }),
  };
}

test('recovery releases a hold a dead runner left open', async () => {
  const harness = recoveryHarness();

  await harness.run(['reservation-1']);

  assert.deepEqual(harness.metering.released, ['reservation-1']);
  assert.deepEqual(harness.forgotten, ['reservation-1']);
  assert.deepEqual(harness.problems, []);
});

test('repeated recovery is idempotent and never double-releases', async () => {
  const harness = recoveryHarness();

  await harness.run(['reservation-1']);
  await harness.run(['reservation-1']);
  await harness.run(['reservation-1']);

  // Released once; the later attempts saw a closed hold and did nothing to it.
  assert.deepEqual(harness.metering.released, ['reservation-1']);
  assert.deepEqual(harness.forgotten, ['reservation-1', 'reservation-1', 'reservation-1']);
});

test('an already-settled hold is not released again', async () => {
  const harness = recoveryHarness();
  await harness.metering.settle({ reservationId: 'reservation-1', actualQuantity: 20 });

  await harness.run(['reservation-1']);

  assert.deepEqual(harness.metering.released, []);
  assert.deepEqual(harness.metering.settled, [20]);
  // Reconciled all the same, so it stops being carried on the session.
  assert.deepEqual(harness.forgotten, ['reservation-1']);
});

test('recovery touches only the holds the session records', async () => {
  const harness = recoveryHarness();

  await harness.run(['reservation-1']);

  // A hold belonging to another session is not named here and is never seen.
  assert.deepEqual(harness.metering.released, ['reservation-1']);
  assert.equal(harness.metering.closed.has('someone-elses-reservation'), false);
});

test('a hold that cannot be released stays recorded for a later attempt', async () => {
  const metering = new FakeMetering();
  const forgotten: string[] = [];
  const problems: { error: Error; what: string }[] = [];

  await reconcileSpecialistReservations({
    uid: 'user-1',
    reservationIds: ['reservation-1', 'reservation-2'],
    release: async (_uid, reservationId) => {
      if (reservationId === 'reservation-1') {
        throw new Error('the ledger disagrees with itself');
      }
      return true;
    },
    forget: async (reservationId) => {
      forgotten.push(reservationId);
    },
    onProblem: (error, what) => {
      problems.push({ error, what });
    },
    now: new Date(0),
  });

  // The broken one is neither released nor forgotten, and it is reported.
  assert.deepEqual(forgotten, ['reservation-2']);
  assert.equal(problems.length, 1);
  assert.match(problems[0]?.what ?? '', /releasing abandoned specialist reservation reservation-1/);
  assert.equal(metering.released.length, 0);
});

/** Input-token charges recorded for a turn, in order. */
function inputCharges(metering: FakeMetering): readonly number[] {
  return metering.consumed
    .filter((entry) => entry.meterKey === 'ai.tokens.input')
    .map((entry) => entry.quantity);
}

function outputCharges(metering: FakeMetering): readonly number[] {
  return metering.consumed
    .filter((entry) => entry.meterKey === 'ai.tokens.output')
    .map((entry) => entry.quantity);
}

test('a completed call charges exactly once, from the final message', async () => {
  const metering = new FakeMetering();
  await turn({
    metering,
    specialists: [],
    script: [
      // Usage arrives as events too; the completed call must not charge both.
      () => ({ ...say('done'), events: [messageStart(90), messageDelta(20)] }),
    ],
  });

  assert.deepEqual(inputCharges(metering), [10]);
  assert.deepEqual(outputCharges(metering), [20]);
});

test('a call cancelled after message_start charges the input the provider reported', async () => {
  const metering = new FakeMetering();

  await assert.rejects(
    turn({
      metering,
      specialists: [],
      script: [
        () => ({
          ...say('never returned'),
          // Prompt cost is authoritative the moment message_start lands.
          events: [messageStart(700, 300, 100), textDelta('partial answer')],
          abortAfterEvents: true,
        }),
      ],
    }),
    /aborted/,
  );

  // 700 + 300 cache read + 100 cache creation.
  assert.deepEqual(inputCharges(metering), [1100]);
  // No message_delta arrived, so no authoritative output total exists.
  assert.deepEqual(outputCharges(metering), []);
});

test('streamed text alone never becomes an output charge', async () => {
  const metering = new FakeMetering();

  await assert.rejects(
    turn({
      metering,
      specialists: [],
      script: [
        () => ({
          ...say('never returned'),
          // A great deal of text, and still no authoritative output figure.
          events: [
            messageStart(50),
            textDelta('a'.repeat(4000)),
            textDelta('b'.repeat(4000)),
          ],
          abortAfterEvents: true,
        }),
      ],
    }),
    /aborted/,
  );

  assert.deepEqual(inputCharges(metering), [50]);
  assert.deepEqual(outputCharges(metering), []);
});

test('a call cancelled after message_delta charges the reported output total', async () => {
  const metering = new FakeMetering();

  await assert.rejects(
    turn({
      metering,
      specialists: [],
      script: [
        () => ({
          ...say('never returned'),
          events: [messageStart(60), textDelta('some text'), messageDelta(120)],
          abortAfterEvents: true,
        }),
      ],
    }),
    /aborted/,
  );

  assert.deepEqual(inputCharges(metering), [60]);
  assert.deepEqual(outputCharges(metering), [120]);
});

test('a call cancelled before any usage event charges nothing unknown', async () => {
  const metering = new FakeMetering();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    turn({
      metering,
      specialists: [],
      signal: controller.signal,
      script: [() => say('never reached')],
    }),
    /aborted/,
  );

  assert.deepEqual(metering.consumed, []);
});

test('a specialist reservation settles to the authoritative output actually reported', async () => {
  const metering = new FakeMetering();

  await turn({
    metering,
    script: [
      consult(),
      // First specialist call completes: 20 output from its final message.
      () => call('read_file', { path: 'a.ts' }),
      // Second aborts, but only after reporting an authoritative total of 120.
      () => ({
        ...call('submit_review', review('ok', 'Fine.', [])),
        events: [messageStart(40), messageDelta(120)],
        abortAfterEvents: true,
      }),
      // The consultation failed; the primary agent is told and carries on.
      () => say('carried on without the review'),
    ],
  });

  // 20 from the completed call plus the 120 the provider reported before the
  // abort. Nothing estimated, and never the 4000-token ceiling.
  assert.deepEqual(metering.reserved, [
    { meterKey: 'ai.tokens.output', quantity: limits.specialistMaxSteps * limits.maxOutputTokens },
  ]);
  assert.deepEqual(metering.settled, [140]);
});

test('the primary agent uses the same cancellation accounting as a specialist', async () => {
  const metering = new FakeMetering();

  await assert.rejects(
    turn({
      metering,
      specialists: [],
      script: [
        () => ({
          ...say('never returned'),
          events: [messageStart(200), messageDelta(35)],
          abortAfterEvents: true,
        }),
      ],
    }),
    /aborted/,
  );

  // Charged through the shared loop, so there is no specialist-only behaviour.
  assert.deepEqual(inputCharges(metering), [200]);
  assert.deepEqual(outputCharges(metering), [35]);
});

// ---------------------------------------------------------------------------
// V1.1: parallel read-only specialist consultations within one tool-use batch.
// ---------------------------------------------------------------------------

function batchOf(
  ...uses: { id: string; name: string; input: Record<string, unknown> }[]
): Reply {
  return {
    content: uses.map((use) => ({
      type: 'tool_use',
      id: use.id,
      name: use.name,
      input: use.input,
      caller: { type: 'direct' },
    })),
    stop_reason: 'tool_use',
  };
}

/** Routes a scripted reply by which specialist the model call belongs to. */
function byRole(handlers: { security: Responder; architecture: Responder }): Responder {
  return (modelCall) => {
    if (modelCall.system.includes(security.instructions)) {
      return handlers.security(modelCall);
    }
    if (modelCall.system.includes(architecture.instructions)) {
      return handlers.architecture(modelCall);
    }
    throw new Error('a call reached the specialist script without a specialist system prompt');
  };
}

/**
 * Releases every arriving party only once all of them have arrived. Proof of
 * concurrency: a serialized execution leaves the first arrival waiting on a
 * party that can never start, which times out and fails the test rather than
 * hanging it.
 */
function barrier(parties: number): () => Promise<void> {
  let arrived = 0;
  const waiters: (() => void)[] = [];
  return async () => {
    arrived += 1;
    if (arrived >= parties) {
      for (const release of waiters) {
        release();
      }
      return;
    }
    await new Promise<void>((resolve, reject) => {
      waiters.push(resolve);
      const timer = setTimeout(
        () => reject(new Error(`barrier: only ${arrived} of ${parties} parties arrived`)),
        2000,
      );
      timer.unref();
    });
  };
}

/** The tool_result blocks a follow-up model call was shown, in order. */
function toolResultsOf(modelCall: ModelCall): { id: string; text: string; isError: boolean }[] {
  const last = modelCall.messages[modelCall.messages.length - 1];
  if (last === undefined || !Array.isArray(last.content)) {
    throw new Error('the call does not end with a tool-result message');
  }
  const results: { id: string; text: string; isError: boolean }[] = [];
  for (const block of last.content) {
    if (block.type !== 'tool_result') {
      continue;
    }
    if (typeof block.content !== 'string' || typeof block.is_error !== 'boolean') {
      throw new Error(`tool result ${block.tool_use_id} has an unexpected shape`);
    }
    results.push({ id: block.tool_use_id, text: block.content, isError: block.is_error });
  }
  return results;
}

const secUse = {
  id: 'use-sec',
  name: 'consult_specialist',
  input: { role: 'security', question: 'Q-security' },
};
const archUse = {
  id: 'use-arch',
  name: 'consult_specialist',
  input: { role: 'architecture', question: 'Q-architecture' },
};

test('consultations issued in one batch run concurrently, each on its own hold', async () => {
  const meet = barrier(2);
  const metering = new FakeMetering();
  const reservations = new FakeReservations(metering);
  let holdsWhileBothRan = 0;
  const observe = (): void => {
    holdsWhileBothRan = Math.max(holdsWhileBothRan, reservations.open.size);
  };
  const specialists = byRole({
    security: async () => {
      await meet();
      observe();
      return call('submit_review', review('ok', 'Safe.', []));
    },
    architecture: async () => {
      await meet();
      observe();
      return call('submit_review', review('ok', 'Sound.', []));
    },
  });

  const { run } = await turn({
    metering,
    reservations,
    script: [() => batchOf(secUse, archUse), specialists, specialists, () => say('done')],
  });

  assert.equal(run.reply, 'done');
  // The barrier only opens once both model calls are in flight, and at that
  // moment each consultation already held its own recoverable reservation.
  assert.equal(holdsWhileBothRan, 2);
  assert.deepEqual(
    metering.reserved.map((hold) => hold.quantity),
    [4000, 4000],
  );
  // Each settled independently, and both records were cleared after settling.
  assert.equal(metering.settled.length, 2);
  assert.equal(reservations.open.size, 0);
});

test('concurrent specialists receive independent conversations', async () => {
  const specialists = byRole({
    security: () => call('submit_review', review('ok', 'Safe.', [])),
    architecture: () => call('submit_review', review('ok', 'Sound.', [])),
  });
  const { scripted } = await turn({
    script: [() => batchOf(secUse, archUse), specialists, specialists, () => say('done')],
  });

  const secCall = scripted.calls.find((c) => c.system.includes(security.instructions));
  const archCall = scripted.calls.find((c) => c.system.includes(architecture.instructions));
  assert.ok(secCall !== undefined && archCall !== undefined);
  // Each starts from its own single question, with nothing of the other's.
  assert.equal(secCall.messages.length, 1);
  assert.equal(archCall.messages.length, 1);
  const secText = JSON.stringify(secCall.messages);
  const archText = JSON.stringify(archCall.messages);
  assert.ok(secText.includes('Q-security') && !secText.includes('Q-architecture'));
  assert.ok(archText.includes('Q-architecture') && !archText.includes('Q-security'));
});

test('completion order inversion never mis-associates results or events', async () => {
  let architectureFinished = (): void => {};
  const architectureDone = new Promise<void>((resolve) => {
    architectureFinished = resolve;
  });
  const specialists = byRole({
    security: async () => {
      // Emitted first, answers last: security holds until architecture's
      // consultation has fully completed, settlement and events included.
      await architectureDone;
      await new Promise<void>((resolve) => setImmediate(resolve));
      return call('submit_review', review('concern', 'Worth tightening.', oneFinding));
    },
    architecture: () => {
      architectureFinished();
      return call('submit_review', review('ok', 'Sound.', []));
    },
  });

  const { run, scripted, published } = await turn({
    script: [() => batchOf(secUse, archUse), specialists, specialists, () => say('done')],
  });

  assert.equal(run.reply, 'done');
  // Architecture genuinely completed first, and each event carries its own
  // specialist's identity and verdict.
  const completed = published.filter((event) => event.type === 'agent.specialist_completed');
  assert.deepEqual(
    completed.map((event) => [event.data['role'], event.data['verdict']]),
    [
      ['architecture', 'ok'],
      ['security', 'concern'],
    ],
  );
  // Yet each tool result sits with the call that asked for it, in the model's
  // original order.
  const followUp = scripted.calls[scripted.calls.length - 1];
  assert.ok(followUp !== undefined);
  const results = toolResultsOf(followUp);
  assert.deepEqual(
    results.map((result) => result.id),
    ['use-sec', 'use-arch'],
  );
  assert.ok(results[0]?.text.includes('Security specialist — verdict: concern'));
  assert.ok(results[1]?.text.includes('Architecture specialist — verdict: ok'));
});

test('one specialist failing leaves a sibling result standing', async () => {
  const metering = new FakeMetering();
  const reservations = new FakeReservations(metering);
  const specialists = byRole({
    security: () => call('submit_review', review('ok', 'Safe.', [])),
    architecture: () => {
      throw new Error('the provider returned 529');
    },
  });

  const { run, scripted } = await turn({
    metering,
    reservations,
    script: [() => batchOf(secUse, archUse), specialists, specialists, () => say('carried on')],
  });

  // The batch did not fail: the primary agent saw both outcomes and went on.
  assert.equal(run.reply, 'carried on');
  assert.deepEqual(run.unresolvedBlockers, []);
  const followUp = scripted.calls[scripted.calls.length - 1];
  assert.ok(followUp !== undefined);
  const results = toolResultsOf(followUp);
  assert.deepEqual(
    results.map((result) => [result.id, result.isError]),
    [
      ['use-sec', false],
      ['use-arch', true],
    ],
  );
  assert.ok(results[0]?.text.includes('Security specialist — verdict: ok'));
  assert.ok(results[1]?.text.includes('the provider returned 529'));
  // Only known usage settles; the failed provider call remains held.
  assert.equal(metering.settled.length, 1);
  assert.equal(reservations.open.size, 1);
});

test('a blocking verdict survives a sibling specialist failure', async () => {
  const specialists = byRole({
    security: () => call('submit_review', review('blocking', 'Deletes skip ownership.', oneFinding)),
    architecture: () => {
      throw new Error('the provider returned 529');
    },
  });

  const { run } = await turn({
    script: [() => batchOf(secUse, archUse), specialists, specialists, () => say('done')],
  });

  assert.equal(run.stopReason, 'blocked');
  assert.deepEqual(
    run.unresolvedBlockers.map((blocker) => blocker.role),
    ['security'],
  );
});

test('an ok from one specialist does not clear a blocker from another', async () => {
  const specialists = byRole({
    security: () => call('submit_review', review('ok', 'Safe.', [])),
    architecture: () =>
      call('submit_review', review('blocking', 'The layers are inverted.', oneFinding)),
  });

  const { run } = await turn({
    script: [() => batchOf(secUse, archUse), specialists, specialists, () => say('done')],
  });

  assert.equal(run.stopReason, 'blocked');
  assert.deepEqual(
    run.unresolvedBlockers.map((blocker) => blocker.role),
    ['architecture'],
  );
});

test('simultaneous blockers are both tracked and each clears only through its own specialist', async () => {
  const specialists = byRole({
    security: () => call('submit_review', review('blocking', 'Secrets in the bundle.', oneFinding)),
    architecture: () =>
      call('submit_review', review('blocking', 'The layers are inverted.', oneFinding)),
  });

  const { run } = await turn({
    limits: { ...limits, maxSpecialistConsultations: 3 },
    script: [
      () => batchOf(secUse, archUse),
      specialists,
      specialists,
      () =>
        call('consult_specialist', {
          role: 'architecture',
          question: 'Fixed the layering?',
          resolves: 'architecture-1',
        }),
      () => call('submit_review', review('ok', 'Resolved.', [])),
      () => say('done'),
    ],
  });

  // Architecture's later ok cleared architecture's blocker and no one else's.
  assert.equal(run.stopReason, 'blocked');
  assert.deepEqual(
    run.unresolvedBlockers.map((blocker) => blocker.role),
    ['security'],
  );
});

test('workspace mutations never run concurrently with specialist analysis', async () => {
  const sandbox = new FakeSandbox();
  const order: string[] = [];
  const specialists = byRole({
    security: () => {
      order.push('security');
      // Nothing mutated before or beside the first consultation.
      assert.equal(sandbox.writes.length, 0);
      assert.equal(sandbox.commands.length, 0);
      return call('submit_review', review('ok', 'Safe.', []));
    },
    architecture: () => {
      order.push('architecture');
      // The write and the command both landed, whole, before this one began.
      assert.equal(sandbox.writes.length, 1);
      assert.equal(sandbox.commands.length, 1);
      return call('submit_review', review('ok', 'Sound.', []));
    },
  });

  const { run } = await turn({
    sandbox,
    script: [
      () =>
        batchOf(
          secUse,
          { id: 'use-write', name: 'write_file', input: { path: 'src/app.ts', content: 'x' } },
          { id: 'use-cmd', name: 'run_command', input: { command: 'npm test' } },
          archUse,
        ),
      specialists,
      specialists,
      () => say('done'),
    ],
  });

  assert.equal(run.reply, 'done');
  assert.deepEqual(order, ['security', 'architecture']);
});

test('specialists issued together inspect the workspace before any queued write', async () => {
  const sandbox = new FakeSandbox();
  const meet = barrier(2);
  const sameState =
    (reply: Reply): Responder =>
    async () => {
      await meet();
      // Both are in flight at once and neither has seen a mutation: the write
      // the model queued in the same batch has not happened yet.
      assert.equal(sandbox.writes.length, 0);
      return reply;
    };
  const specialists = byRole({
    security: sameState(call('submit_review', review('ok', 'Safe.', []))),
    architecture: sameState(call('submit_review', review('ok', 'Sound.', []))),
  });

  const { run } = await turn({
    sandbox,
    script: [
      () =>
        batchOf(secUse, archUse, {
          id: 'use-write',
          name: 'write_file',
          input: { path: 'src/app.ts', content: 'x' },
        }),
      specialists,
      specialists,
      () => say('done'),
    ],
  });

  assert.equal(run.reply, 'done');
  assert.deepEqual(sandbox.writes, ['/workspace/src/app.ts']);
});

test('a tool the agent was not granted is never treated as parallel-safe', async () => {
  const metering = new FakeMetering();
  const specialists = byRole({
    security: () => call('submit_review', review('ok', 'Safe.', [])),
    architecture: () => {
      // Security settled before this consultation began: the unknown tool
      // between them split the batch into strictly ordered groups.
      assert.equal(metering.settled.length, 1);
      return call('submit_review', review('ok', 'Sound.', []));
    },
  });

  const { scripted } = await turn({
    metering,
    script: [
      () => batchOf(secUse, { id: 'use-mystery', name: 'mystery_tool', input: {} }, archUse),
      specialists,
      specialists,
      () => say('done'),
    ],
  });

  const followUp = scripted.calls[scripted.calls.length - 1];
  assert.ok(followUp !== undefined);
  const results = toolResultsOf(followUp);
  assert.deepEqual(
    results.map((result) => result.id),
    ['use-sec', 'use-mystery', 'use-arch'],
  );
  assert.equal(results[1]?.isError, true);
  assert.ok(results[1]?.text.includes('not available to this agent'));
});

test('simultaneous consultations cannot exceed the per-turn budget', async () => {
  const metering = new FakeMetering();
  const specialists = byRole({
    security: () => call('submit_review', review('ok', 'Safe.', [])),
    architecture: () => call('submit_review', review('ok', 'Sound.', [])),
  });

  const { run, scripted } = await turn({
    metering,
    script: [
      () =>
        batchOf(secUse, archUse, {
          id: 'use-third',
          name: 'consult_specialist',
          input: { role: 'security', question: 'One more look?' },
        }),
      specialists,
      specialists,
      () => say('done'),
    ],
  });

  assert.equal(run.reply, 'done');
  // Two holds, never three: simultaneous claims took the budget one at a time.
  assert.equal(metering.reserved.length, 2);
  const followUp = scripted.calls[scripted.calls.length - 1];
  assert.ok(followUp !== undefined);
  const results = toolResultsOf(followUp);
  assert.deepEqual(
    results.map((result) => result.id),
    ['use-sec', 'use-arch', 'use-third'],
  );
  const refused = results.filter((result) =>
    result.text.includes('No further specialist consultations'),
  );
  assert.equal(refused.length, 1);
  assert.equal(refused[0]?.isError, true);
  // The permitted siblings still ran to their reviews.
  assert.equal(results.filter((result) => result.text.includes('verdict: ok')).length, 2);
});

test('cancellation reaches every in-flight consultation and leaves nothing detached', async () => {
  const controller = new AbortController();
  const meet = barrier(2);
  const metering = new FakeMetering();
  const reservations = new FakeReservations(metering);
  const abortedCall = async (): Promise<Reply> => {
    // Both streams are in flight when the session is cancelled, and both then
    // fail the way the SDK fails an aborted request.
    await meet();
    controller.abort();
    throw new Error('Request was aborted.');
  };
  const specialists = byRole({ security: abortedCall, architecture: abortedCall });

  await assert.rejects(
    turn({
      signal: controller.signal,
      metering,
      reservations,
      script: [() => batchOf(secUse, archUse), specialists, specialists],
    }),
    /aborted/,
  );

  // Control returned only after every started consultation had settled its own
  // accounting — nothing kept running past the turn — and both holds stayed
  // recorded for recovery.
  assert.deepEqual(metering.settled, []);
  assert.equal(reservations.open.size, 2);
});

// ---------------------------------------------------------------------------
// Blocker identity: id-keyed ledger and targeted resolution.
// ---------------------------------------------------------------------------

/** Routes a scripted reply by a marker in the consultation's question. */
function byQuestion(handlers: Record<string, Responder>): Responder {
  return (modelCall) => {
    const text = JSON.stringify(modelCall.messages);
    for (const [needle, handler] of Object.entries(handlers)) {
      if (text.includes(needle)) {
        return handler(modelCall);
      }
    }
    throw new Error('no scripted reply matches the consultation question');
  };
}

function consultOf(
  id: string,
  role: string,
  question: string,
  resolves?: string,
): { id: string; name: string; input: Record<string, unknown> } {
  return {
    id,
    name: 'consult_specialist',
    input: resolves === undefined ? { role, question } : { role, question, resolves },
  };
}

test('an unrelated ok from the same specialist does not clear an earlier blocker', async () => {
  const { run } = await turn({
    script: [
      () => call('consult_specialist', { role: 'security', question: 'Review authorization.' }),
      () => call('submit_review', review('blocking', 'Cross-user access is possible.', oneFinding)),
      () => call('consult_specialist', { role: 'security', question: 'Any secrets exposed?' }),
      () => call('submit_review', review('ok', 'No secret exposure found.', [])),
      () => say('done'),
    ],
  });

  // The second review answered a different question; the blocker stands.
  assert.equal(run.stopReason, 'blocked');
  assert.deepEqual(
    run.unresolvedBlockers.map((blocker) => blocker.id),
    ['security-1'],
  );
});

test('each new blocking review mints its own blocker id', async () => {
  const { run } = await turn({
    script: [
      () => call('consult_specialist', { role: 'security', question: 'Review authorization.' }),
      () => call('submit_review', review('blocking', 'Cross-user access.', oneFinding)),
      () => call('consult_specialist', { role: 'security', question: 'Review secret handling.' }),
      () =>
        call(
          'submit_review',
          review('blocking', 'A key is committed.', [
            { severity: 'high', claim: 'API key in repo', evidence: '.env:1' },
          ]),
        ),
      () => say('done'),
    ],
  });

  // Two issues, two identities — the second did not overwrite the first, and
  // each entry carries everything the blocked delivery reports.
  assert.deepEqual(run.unresolvedBlockers, [
    {
      id: 'security-1',
      role: 'security',
      label: 'Security',
      summary: 'Cross-user access.',
      claims: ['No ownership check'],
    },
    {
      id: 'security-2',
      role: 'security',
      label: 'Security',
      summary: 'A key is committed.',
      claims: ['API key in repo'],
    },
  ]);
});

test('a targeted ok clears exactly its blocker and nothing else', async () => {
  const specialists = byQuestion({
    'Q-security': () => call('submit_review', review('blocking', 'Cross-user access.', oneFinding)),
    'Q-architecture': () =>
      call('submit_review', review('blocking', 'The layers are inverted.', oneFinding)),
    'Q-recheck': () => call('submit_review', review('ok', 'Fixed.', [])),
  });

  const { run } = await turn({
    limits: { ...limits, maxSpecialistConsultations: 3 },
    script: [
      () => batchOf(secUse, archUse),
      specialists,
      specialists,
      () => call('consult_specialist', { role: 'security', question: 'Q-recheck', resolves: 'security-1' }),
      specialists,
      () => say('done'),
    ],
  });

  assert.equal(run.stopReason, 'blocked');
  assert.deepEqual(
    run.unresolvedBlockers.map((blocker) => blocker.id),
    ['architecture-1'],
  );
});

test('a targeted blocking review keeps its id and carries the remaining findings', async () => {
  const threeFindings = [
    { severity: 'high', claim: 'Missing ownership validation', evidence: 'routes.ts:10' },
    { severity: 'high', claim: 'Leaked API secret', evidence: '.env:1' },
    { severity: 'high', claim: 'Unsafe command injection', evidence: 'exec.ts:5' },
  ];
  const twoFindings = [
    { severity: 'high', claim: 'Leaked API secret', evidence: '.env:1' },
    { severity: 'high', claim: 'Unsafe command injection', evidence: 'exec.ts:5' },
  ];

  const { run } = await turn({
    script: [
      () => call('consult_specialist', { role: 'security', question: 'Review the change.' }),
      () => call('submit_review', review('blocking', 'Three issues.', threeFindings)),
      () =>
        call('consult_specialist', {
          role: 'security',
          question: 'Fixed the ownership check. Re-review.',
          resolves: 'security-1',
        }),
      () => call('submit_review', review('blocking', 'Two issues remain.', twoFindings)),
      () => say('done'),
    ],
  });

  // Same identity, updated evidence: one finding fixed, two still standing.
  assert.equal(run.stopReason, 'blocked');
  assert.deepEqual(
    run.unresolvedBlockers.map((blocker) => [blocker.id, blocker.summary]),
    [['security-1', 'Two issues remain.']],
  );
  assert.deepEqual(run.unresolvedBlockers[0]?.claims, [
    'Leaked API secret',
    'Unsafe command injection',
  ]);
});

test('a targeted concern does not resolve the blocker', async () => {
  const { run, scripted } = await turn({
    script: [
      () => call('consult_specialist', { role: 'security', question: 'Review authorization.' }),
      () => call('submit_review', review('blocking', 'Cross-user access.', oneFinding)),
      () =>
        call('consult_specialist', {
          role: 'security',
          question: 'Is it better now?',
          resolves: 'security-1',
        }),
      () => call('submit_review', review('concern', 'Improved but unproven.', oneFinding)),
      () => say('done'),
    ],
  });

  // Unchanged, original claims and all: advice is not evidence of resolution.
  assert.equal(run.stopReason, 'blocked');
  assert.deepEqual(
    run.unresolvedBlockers.map((blocker) => [blocker.id, blocker.summary]),
    [['security-1', 'Cross-user access.']],
  );
  const followUp = scripted.calls[scripted.calls.length - 1];
  assert.ok(followUp !== undefined);
  const results = toolResultsOf(followUp);
  assert.ok(results[0]?.text.includes('Blocker security-1 remains unresolved'));
});

test('two same-role blockers are independent and resolving one leaves the other intact', async () => {
  const specialists = byQuestion({
    'Q-auth': () =>
      call(
        'submit_review',
        review('blocking', 'Cross-user access.', [
          { severity: 'high', claim: 'Auth claim', evidence: 'routes.ts:10' },
        ]),
      ),
    'Q-secrets': () =>
      call(
        'submit_review',
        review('blocking', 'Secret in bundle.', [
          { severity: 'high', claim: 'Secret claim', evidence: '.env:1' },
        ]),
      ),
    'Q-recheck': () => call('submit_review', review('ok', 'Fixed.', [])),
  });

  const { run } = await turn({
    limits: { ...limits, maxSpecialistConsultations: 3 },
    script: [
      () =>
        batchOf(
          consultOf('use-a', 'security', 'Q-auth'),
          consultOf('use-b', 'security', 'Q-secrets'),
        ),
      specialists,
      specialists,
      () => call('consult_specialist', { role: 'security', question: 'Q-recheck', resolves: 'security-1' }),
      specialists,
      () => say('done'),
    ],
  });

  // Two ids were minted; resolving the first left the second whole.
  assert.equal(run.stopReason, 'blocked');
  assert.deepEqual(
    run.unresolvedBlockers.map((blocker) => [blocker.id, blocker.summary]),
    [['security-2', 'Secret in bundle.']],
  );
  assert.deepEqual(run.unresolvedBlockers[0]?.claims, ['Secret claim']);
});

test('an unknown resolves id is refused before any specialist runs', async () => {
  const { run, scripted, metering } = await turn({
    script: [
      () =>
        call('consult_specialist', {
          role: 'security',
          question: 'Recheck the fix.',
          resolves: 'security-9',
        }),
      () => say('understood'),
    ],
  });

  // No specialist model call, no reservation, no ledger change — just a
  // refusal the primary agent can read.
  assert.equal(scripted.calls.length, 2);
  assert.deepEqual(metering.reserved, []);
  assert.deepEqual(run.unresolvedBlockers, []);
  const followUp = scripted.calls[1];
  assert.ok(followUp !== undefined);
  const results = toolResultsOf(followUp);
  assert.equal(results[0]?.isError, true);
  assert.ok(results[0]?.text.includes('no unresolved blocker "security-9"'));
});

test('a specialist cannot resolve another role’s blocker', async () => {
  const { run, scripted, metering } = await turn({
    script: [
      () => call('consult_specialist', { role: 'architecture', question: 'Review the layering.' }),
      () => call('submit_review', review('blocking', 'The layers are inverted.', oneFinding)),
      () =>
        call('consult_specialist', {
          role: 'security',
          question: 'Is the layering fixed?',
          resolves: 'architecture-1',
        }),
      () => say('understood'),
    ],
  });

  // Refused without a specialist call, and the blocker is untouched.
  assert.equal(scripted.calls.length, 4);
  assert.equal(metering.reserved.length, 1);
  assert.equal(run.stopReason, 'blocked');
  assert.deepEqual(
    run.unresolvedBlockers.map((blocker) => blocker.id),
    ['architecture-1'],
  );
  const followUp = scripted.calls[3];
  assert.ok(followUp !== undefined);
  const results = toolResultsOf(followUp);
  assert.equal(results[0]?.isError, true);
  assert.ok(results[0]?.text.includes('raised by the "architecture" specialist'));
});

for (const okFirst of [false, true]) {
  const order = okFirst ? 'the ok completing first' : 'the blocking completing first';
  test(`a parallel untargeted ok never clears a sibling blocker, with ${order}`, async () => {
    let firstDone = (): void => {};
    const firstFinished = new Promise<void>((resolve) => {
      firstDone = resolve;
    });
    const second = async (reply: Reply): Promise<Reply> => {
      await firstFinished;
      await new Promise<void>((resolve) => setImmediate(resolve));
      return reply;
    };
    const first = (reply: Reply): Reply => {
      firstDone();
      return reply;
    };
    const blocking = call('submit_review', review('blocking', 'Cross-user access.', oneFinding));
    const ok = call('submit_review', review('ok', 'Secrets are fine.', []));
    const specialists = byQuestion({
      'Q-auth': () => (okFirst ? second(blocking) : first(blocking)),
      'Q-secrets': () => (okFirst ? first(ok) : second(ok)),
    });

    const { run } = await turn({
      script: [
        () =>
          batchOf(
            consultOf('use-a', 'security', 'Q-auth'),
            consultOf('use-b', 'security', 'Q-secrets'),
          ),
        specialists,
        specialists,
        () => say('done'),
      ],
    });

    assert.equal(run.stopReason, 'blocked');
    assert.deepEqual(
      run.unresolvedBlockers.map((blocker) => blocker.id),
      ['security-1'],
    );
  });
}

for (const okFirst of [false, true]) {
  const order = okFirst ? 'the ok completing first' : 'the blocking completing first';
  test(`a targeted blocking beats a concurrent targeted ok, with ${order}`, async () => {
    let firstDone = (): void => {};
    const firstFinished = new Promise<void>((resolve) => {
      firstDone = resolve;
    });
    const second = async (reply: Reply): Promise<Reply> => {
      await firstFinished;
      await new Promise<void>((resolve) => setImmediate(resolve));
      return reply;
    };
    const first = (reply: Reply): Reply => {
      firstDone();
      return reply;
    };
    const ok = call('submit_review', review('ok', 'Looks fixed to me.', []));
    const stillBlocking = call(
      'submit_review',
      review('blocking', 'Still reachable.', [
        { severity: 'high', claim: 'Still no ownership check', evidence: 'routes.ts:42' },
      ]),
    );
    const specialists = byQuestion({
      'Q-initial': () => call('submit_review', review('blocking', 'Cross-user access.', oneFinding)),
      'Q-recheck-ok': () => (okFirst ? first(ok) : second(ok)),
      'Q-recheck-block': () => (okFirst ? second(stillBlocking) : first(stillBlocking)),
    });

    const { run } = await turn({
      limits: { ...limits, maxSpecialistConsultations: 3 },
      script: [
        () => call('consult_specialist', { role: 'security', question: 'Q-initial' }),
        specialists,
        () =>
          batchOf(
            consultOf('use-ok', 'security', 'Q-recheck-ok', 'security-1'),
            consultOf('use-block', 'security', 'Q-recheck-block', 'security-1'),
          ),
        specialists,
        specialists,
        () => say('done'),
      ],
    });

    // Blocking wins in both completion orders, with the re-review's findings.
    assert.equal(run.stopReason, 'blocked');
    assert.deepEqual(
      run.unresolvedBlockers.map((blocker) => [blocker.id, blocker.summary]),
      [['security-1', 'Still reachable.']],
    );
  });
}

test('concurrent targeted oks resolve the blocker once', async () => {
  const specialists = byQuestion({
    'Q-initial': () => call('submit_review', review('blocking', 'Cross-user access.', oneFinding)),
    'Q-recheck': () => call('submit_review', review('ok', 'Fixed.', [])),
  });

  const { run } = await turn({
    limits: { ...limits, maxSpecialistConsultations: 3 },
    script: [
      () => call('consult_specialist', { role: 'security', question: 'Q-initial' }),
      specialists,
      () =>
        batchOf(
          consultOf('use-a', 'security', 'Q-recheck one', 'security-1'),
          consultOf('use-b', 'security', 'Q-recheck two', 'security-1'),
        ),
      specialists,
      specialists,
      () => say('done'),
    ],
  });

  assert.notEqual(run.stopReason, 'blocked');
  assert.deepEqual(run.unresolvedBlockers, []);
});

test('concurrent targeted blocking reviews leave exactly one open blocker', async () => {
  const specialists = byQuestion({
    'Q-initial': () => call('submit_review', review('blocking', 'Cross-user access.', oneFinding)),
    'Q-recheck': () => call('submit_review', review('blocking', 'Still reachable.', oneFinding)),
  });

  const { run } = await turn({
    limits: { ...limits, maxSpecialistConsultations: 3 },
    script: [
      () => call('consult_specialist', { role: 'security', question: 'Q-initial' }),
      specialists,
      () =>
        batchOf(
          consultOf('use-a', 'security', 'Q-recheck one', 'security-1'),
          consultOf('use-b', 'security', 'Q-recheck two', 'security-1'),
        ),
      specialists,
      specialists,
      () => say('done'),
    ],
  });

  assert.equal(run.stopReason, 'blocked');
  assert.deepEqual(
    run.unresolvedBlockers.map((blocker) => blocker.id),
    ['security-1'],
  );
});

test('completion succeeds only after every blocker is explicitly resolved', async () => {
  const specialists = byQuestion({
    'Q-security': () => call('submit_review', review('blocking', 'Cross-user access.', oneFinding)),
    'Q-architecture': () =>
      call('submit_review', review('blocking', 'The layers are inverted.', oneFinding)),
    'Q-sec-recheck': () => call('submit_review', review('ok', 'Fixed.', [])),
    'Q-arch-recheck': () => call('submit_review', review('ok', 'Fixed too.', [])),
  });

  const { run } = await turn({
    limits: { ...limits, maxSpecialistConsultations: 4 },
    script: [
      () => batchOf(secUse, archUse),
      specialists,
      specialists,
      () => call('consult_specialist', { role: 'security', question: 'Q-sec-recheck', resolves: 'security-1' }),
      specialists,
      () =>
        call('consult_specialist', {
          role: 'architecture',
          question: 'Q-arch-recheck',
          resolves: 'architecture-1',
        }),
      specialists,
      () => say('done'),
    ],
  });

  assert.notEqual(run.stopReason, 'blocked');
  assert.deepEqual(run.unresolvedBlockers, []);
});

test('a blocking result names its blocker and how to re-review it', async () => {
  const { scripted } = await turn({
    script: [
      () => call('consult_specialist', { role: 'security', question: 'Review authorization.' }),
      () => call('submit_review', review('blocking', 'Cross-user access.', oneFinding)),
      () => say('done'),
    ],
  });

  const followUp = scripted.calls[scripted.calls.length - 1];
  assert.ok(followUp !== undefined);
  const results = toolResultsOf(followUp);
  assert.ok(results[0]?.text.includes('This is blocking: blocker security-1'));
  assert.ok(results[0]?.text.includes('resolves: "security-1"'));
});

// ---------------------------------------------------------------------------
// V1.2: Testing / Validation specialist and run_validation.
// ---------------------------------------------------------------------------

/** Observes the greatest number of tracked operations in flight at once. */
class Tracker {
  active = 0;
  max = 0;
  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    this.active += 1;
    this.max = Math.max(this.max, this.active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      return await fn();
    } finally {
      this.active -= 1;
    }
  }
}

interface ValidationOptions {
  readonly files?: Record<string, string>;
  readonly onCommand?: (
    command: string,
    files: Map<string, string>,
  ) => { exitCode: number; stdout: string; stderr: string };
  readonly tracker?: Tracker;
  readonly failRestore?: boolean;
  readonly breakVerify?: boolean;
}

/** Separate maps represent separate VM filesystems; disposal never copies back. */
class ValidationSandbox implements RunningSandbox {
  readonly externalId = 'sandbox-1';
  readonly files: Map<string, string>;
  readonly writes: string[] = [];
  readonly commands: string[] = [];
  readonly allCommands: string[] = [];
  readonly profileCommands: { command: string; envs: Record<string, string> | undefined }[] = [];
  stopped = 0;
  forks = 0;
  readonly #options: ValidationOptions;
  constructor(options: ValidationOptions = {}) {
    this.files = new Map(Object.entries(options.files ?? {}));
    this.#options = options;
  }
  async runCommand(command: string, options?: { envs?: Readonly<Record<string, string>> }): Promise<CommandOutcome> {
    this.commands.push(command);
    return this.#run(command, this.files, options);
  }
  async #run(command: string, files: Map<string, string>, options?: { envs?: Readonly<Record<string, string>> }): Promise<CommandOutcome> {
    this.allCommands.push(command);
    this.profileCommands.push({ command, envs: options?.envs === undefined ? undefined : { ...options.envs } });
    const exec = () => this.#options.onCommand?.(command, files) ?? { exitCode: 0, stdout: '', stderr: '' };
    return this.#options.tracker === undefined ? exec() : this.#options.tracker.run(exec);
  }
  async withCopy(run: (copy: RunningSandbox) => Promise<CommandOutcome>): Promise<CommandOutcome> {
    if (this.#options.breakVerify) throw new Error('fork failed');
    this.forks += 1;
    const files = new Map(this.files);
    const copy: RunningSandbox = {
      externalId: 'validation-copy',
      runCommand: (command, options) => this.#run(command, files, options),
      writeFile: async (path, content) => { files.set(path, content); },
      readFile: async (path) => files.get(path) ?? '',
      previewUrl: () => { throw new Error('No validation preview'); },
      stop: async () => { this.stopped += 1; if (this.#options.failRestore) throw new Error('disposal failed'); },
    };
    try { return await run(copy); } finally { await copy.stop(); }
  }
  async writeFile(path: string): Promise<void> {
    const work = () => { this.writes.push(path); };
    if (this.#options.tracker === undefined) work(); else await this.#options.tracker.run(work);
  }
  async readFile(): Promise<string> { return 'file contents'; }
  previewUrl(): string { return 'https://preview.invalid'; }
  async stop(): Promise<void> {}
}

/** Routes each model call to the right role, giving Testing two steps. */
function testingRouter(handlers: {
  readonly security?: Responder;
  readonly architecture?: Responder;
  readonly testing: readonly Responder[];
}): Responder {
  let testingStep = 0;
  return (modelCall) => {
    const sys = modelCall.system;
    if (handlers.security !== undefined && sys.includes(security.instructions)) {
      return handlers.security(modelCall);
    }
    if (handlers.architecture !== undefined && sys.includes(architecture.instructions)) {
      return handlers.architecture(modelCall);
    }
    if (sys.includes(testing.instructions)) {
      const responder = handlers.testing[testingStep];
      testingStep += 1;
      if (responder === undefined) {
        throw new Error('testing script ran out of steps');
      }
      return responder(modelCall);
    }
    throw new Error('no handler for this specialist');
  };
}

const testUse = {
  id: 'use-test',
  name: 'consult_specialist',
  input: { role: 'testing', question: 'Q-testing validate the change' },
};

const okTesting = [
  () => call('run_validation', { operation: 'test' }),
  () => call('submit_review', review('ok', 'Validation passes.', [])),
];

test('the Testing specialist is offered and receives exactly its four tools', async () => {
  const { scripted } = await turn({
    specialists: [architecture, security, testing],
    sandbox: new ValidationSandbox(),
    script: [
      () => call('consult_specialist', { role: 'testing', question: 'Validate it.' }),
      ...okTesting,
      () => say('done'),
    ],
  });

  const primary = scripted.calls[0];
  assert.ok(primary?.system !== undefined);
  assert.ok(primary.toolNames.includes('consult_specialist'));
  const testingCall = scripted.calls.find((c) => c.system.includes(testing.instructions));
  assert.ok(testingCall !== undefined);
  assert.deepEqual([...testingCall.toolNames].sort(), [
    'list_files',
    'read_file',
    'run_validation',
    'search_files',
    'submit_review',
  ]);
  // Never the mutating or delegating tools.
  for (const forbidden of ['run_command', 'write_file', 'start_preview', 'consult_specialist']) {
    assert.equal(testingCall.toolNames.includes(forbidden), false);
  }
});

test('Testing is optional: a turn that does not consult it runs no validation', async () => {
  const sandbox = new ValidationSandbox();
  const { run } = await turn({
    specialists: [architecture, security, testing],
    sandbox,
    script: [() => say('Renamed a variable.')],
  });

  assert.equal(run.reply, 'Renamed a variable.');
  assert.deepEqual(sandbox.allCommands, []);
});

test('a valid validation profile resolves to the platform command and runs it', async () => {
  const sandbox = new ValidationSandbox({
    onCommand: () => ({ exitCode: 0, stdout: 'All tests passed', stderr: '' }),
  });
  const { scripted } = await turn({
    specialists: [testing],
    sandbox,
    script: [() => call('consult_specialist', { role: 'testing', question: 'Validate.' }), ...okTesting, () => say('done')],
  });

  // The specialist chose "test"; the runtime resolved it to the trusted command.
  assert.deepEqual(
    sandbox.profileCommands.map((c) => c.command),
    ['run-tests'],
  );
  const testingSecond = scripted.calls.filter((c) => c.system.includes(testing.instructions))[1];
  assert.ok(testingSecond !== undefined);
  const results = toolResultsOf(testingSecond);
  assert.ok(results[0]?.text.includes('Exit status: 0 (passed)'));
  assert.ok(results[0]?.text.includes('All tests passed'));
  assert.equal(results[0]?.isError, false);
});

for (const operation of ['deploy', 'test; rm -rf /']) {
  test(`an unconfigured operation "${operation}" fails closed with nothing executed`, async () => {
    const sandbox = new ValidationSandbox();
    const { scripted } = await turn({
      specialists: [testing],
      sandbox,
      script: [
        () => call('consult_specialist', { role: 'testing', question: 'Validate.' }),
        () => call('run_validation', { operation }),
        () => call('submit_review', review('concern', 'Could not validate.', oneFinding)),
        () => say('done'),
      ],
    });

    // No checkpoint, no command, no restore — the resolution refused first.
    assert.deepEqual(sandbox.allCommands, []);
    const testingSecond = scripted.calls.filter((c) => c.system.includes(testing.instructions))[1];
    assert.ok(testingSecond !== undefined);
    const results = toolResultsOf(testingSecond);
    assert.equal(results[0]?.isError, true);
    assert.ok(results[0]?.text.includes('no validation profile'));
  });
}

test('the restore strategy reconstructs from checkpoint trees, never reset --hard or the live index', async () => {
  // A structural guard on the real scripts: reset --hard would destroy the
  // primary agent's uncommitted work, which is the one thing forbidden.
  assert.equal(validationRestoreScript.includes('reset --hard'), false);
  // The index and working tree are rebuilt from the checkpoint trees, and HEAD
  // from the checkpoint ref/commit — never copied back from the post-validation
  // .git/index, which validation may have corrupted.
  assert.ok(validationRestoreScript.includes('read-tree "$LOTUSBUILD_WORKING_TREE"'));
  assert.ok(validationRestoreScript.includes('read-tree "$LOTUSBUILD_INDEX_TREE"'));
  assert.ok(validationRestoreScript.includes('checkout-index'));
  assert.ok(validationRestoreScript.includes('symbolic-ref HEAD'));
  assert.ok(validationRestoreScript.includes('update-ref'));
  // The live index is only ever read through a throwaway GIT_INDEX_FILE probe,
  // never copied over the authoritative index as the restored state.
  assert.ok(validationRestoreScript.includes('GIT_INDEX_FILE'));
  assert.equal(validationRestoreScript.includes('/tmp/lotusbuild-val-probe .git/index'), false);
  assert.ok(validationCheckpointScript.includes('write-tree'));
  assert.ok(validationCheckpointScript.includes('symbolic-ref -q HEAD'));
});

async function runValidationOnce(
  options: ValidationOptions,
): Promise<{ sandbox: ValidationSandbox; result: { text: string; isError: boolean } }> {
  const sandbox = new ValidationSandbox(options);
  const context: ToolContext = {
    withValidationSandbox: sandbox.withCopy.bind(sandbox),
    sandbox,
    provider,
    commandTimeoutMs: 1000,
    previewReadyTimeoutSeconds: 5,
    toolOutputMaxChars: limits.toolOutputMaxChars,
    onPreview: async () => {},
  };
  const tool = makeRunValidation({
    signal: new AbortController().signal,
    assertStillOurs: () => {},
  });
  const result = await tool.run({ operation: 'test' }, context);
  return { sandbox, result };
}

test('a pre-existing tracked primary modification survives validation unchanged', async () => {
  const { sandbox } = await runValidationOnce({
    files: { 'src/auth.ts': 'primary version', 'README.md': 'unchanged' },
    onCommand: (_command, files) => {
      files.set('coverage.txt', 'generated');
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    },
  });
  assert.equal(sandbox.files.get('src/auth.ts'), 'primary version');
  assert.equal(sandbox.files.get('README.md'), 'unchanged');
});

test('a pre-existing untracked primary file survives validation deleting it', async () => {
  const { sandbox } = await runValidationOnce({
    files: { 'src/new-file.ts': 'brand new primary work' },
    onCommand: (_command, files) => {
      files.delete('src/new-file.ts');
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    },
  });
  assert.equal(sandbox.files.get('src/new-file.ts'), 'brand new primary work');
});

test('a validation-created file never reaches the primary', async () => {
  const { sandbox, result } = await runValidationOnce({
    files: { 'src/app.ts': 'x' },
    onCommand: (_command, files) => {
      files.set('.snapshot', 'created by test run');
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    },
  });
  assert.equal(sandbox.files.has('.snapshot'), false);
  assert.ok(result.text.includes('disposable sandbox copy'));
});

test('a validation modification stays in the copy', async () => {
  const { sandbox } = await runValidationOnce({
    files: { 'src/app.ts': 'original' },
    onCommand: (_command, files) => {
      files.set('src/app.ts', 'rewritten by validation');
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    },
  });
  assert.equal(sandbox.files.get('src/app.ts'), 'original');
});

test('a validation deletion stays in the copy', async () => {
  const { sandbox } = await runValidationOnce({
    files: { 'src/app.ts': 'original', 'package.json': '{}' },
    onCommand: (_command, files) => {
      files.delete('src/app.ts');
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    },
  });
  assert.equal(sandbox.files.get('src/app.ts'), 'original');
});

test('the result identifies the disposable workspace boundary', async () => {
  const { result } = await runValidationOnce({
    files: { 'src/app.ts': 'x' },
    onCommand: (_command, files) => {
      files.set('src/app.ts', 'changed');
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    },
  });
  assert.ok(result.text.includes('disposable sandbox copy'));
  assert.ok(result.text.includes('primary workspace was not changed'));
  assert.equal(result.isError, false);
});

test('validation runs only in the copy and confirms disposal', async () => {
  const { sandbox } = await runValidationOnce({ files: { 'a.ts': '1' } });
  assert.equal(sandbox.forks, 1);
  assert.equal(sandbox.stopped, 1);
  assert.deepEqual(sandbox.commands, []);
  assert.deepEqual(sandbox.allCommands, ['run-tests']);
});

test('failure to provision an isolated copy prevents the validation command', async () => {
  await assert.rejects(runValidationOnce({ breakVerify: true }), /fork failed/);
});

test('failed disposal is an explicit failure', async () => {
  await assert.rejects(runValidationOnce({ failRestore: true }), /disposal failed/);
});

test('a thrown validation command cannot alter primary ignored files or Git configuration', async () => {
  const sandbox = new ValidationSandbox({ files: { '.git/config': 'original', 'ignored.txt': 'original' },
    onCommand: (_command, files) => { files.set('.git/config', 'hostile'); files.set('ignored.txt', 'hostile'); throw new Error('timed out'); },
  });
  const tool = makeRunValidation({ signal: new AbortController().signal, assertStillOurs: () => {} });
  await assert.rejects(tool.run({ operation: 'test' }, { sandbox, provider,
    withValidationSandbox: sandbox.withCopy.bind(sandbox), commandTimeoutMs: 1000,
    previewReadyTimeoutSeconds: 5, toolOutputMaxChars: 4000, onPreview: async () => {},
  }), /timed out/);
  assert.equal(sandbox.files.get('.git/config'), 'original');
  assert.equal(sandbox.files.get('ignored.txt'), 'original');
  assert.equal(sandbox.stopped, 1);
});

test('a failing validation exit code is evidence, not an infrastructure failure', async () => {
  const { result } = await runValidationOnce({
    files: { 'a.ts': '1' },
    onCommand: () => ({ exitCode: 1, stdout: '', stderr: '2 tests failed' }),
  });
  // The tool succeeded (tree is safe); the failure is in the reported status.
  assert.equal(result.isError, false);
  assert.ok(result.text.includes('Exit status: 1 (failed)'));
  assert.ok(result.text.includes('2 tests failed'));
});

test('validation output is bounded', async () => {
  const { result } = await runValidationOnce({
    files: { 'a.ts': '1' },
    onCommand: () => ({ exitCode: 0, stdout: 'x'.repeat(20000), stderr: '' }),
  });
  assert.ok(result.text.includes('more characters not shown'));
  assert.ok(result.text.length < 10000);
});

test('no backend environment is injected into the validation command', async () => {
  const { sandbox } = await runValidationOnce({ files: { 'a.ts': '1' } });
  assert.equal(sandbox.profileCommands.length, 1);
  // The profile command ran with an empty environment: nothing of ours.
  assert.deepEqual(sandbox.profileCommands[0]?.envs, {});
});

test('a session that is stopping starts no new validation command', async () => {
  const controller = new AbortController();
  const sandbox = new ValidationSandbox();
  await assert.rejects(
    turn({
      specialists: [testing],
      sandbox,
      signal: controller.signal,
      script: [
        () => call('consult_specialist', { role: 'testing', question: 'Validate.' }),
        () => {
          // The session is cancelled the instant before validation is asked for.
          controller.abort();
          return call('run_validation', { operation: 'test' });
        },
        () => call('submit_review', review('ok', 'Passes.', [])),
      ],
    }),
    /aborted/,
  );
  // Nothing was run in the sandbox: no checkpoint, no command, no restore.
  assert.deepEqual(sandbox.allCommands, []);
});

test('a Testing blocking review mints testing-1 and a targeted re-review clears only it', async () => {
  const sandbox = new ValidationSandbox({
    onCommand: () => ({ exitCode: 1, stdout: '', stderr: 'auth test failed' }),
  });
  const router = testingRouter({
    architecture: () => call('submit_review', review('blocking', 'Layers inverted.', oneFinding)),
    testing: [
      () => call('run_validation', { operation: 'test' }),
      () => call('submit_review', review('blocking', 'Authorization test fails.', oneFinding)),
      () => call('run_validation', { operation: 'test' }),
      () => call('submit_review', review('ok', 'Now passes.', [])),
    ],
  });
  const { run } = await turn({
    specialists: [architecture, testing],
    sandbox,
    limits: { ...limits, maxSpecialistConsultations: 3 },
    script: [
      () => batchOf(consultOf('use-arch', 'architecture', 'Q-architecture'), testUse),
      router,
      router,
      router,
      () => call('consult_specialist', { role: 'testing', question: 'Fixed it.', resolves: 'testing-1' }),
      router,
      router,
      () => say('done'),
    ],
  });

  assert.equal(run.stopReason, 'blocked');
  // testing-1 was cleared; the unrelated architecture blocker still stands.
  assert.deepEqual(
    run.unresolvedBlockers.map((blocker) => blocker.id),
    ['architecture-1'],
  );
});

test('a Testing concern on a targeted re-review does not clear its blocker', async () => {
  const sandbox = new ValidationSandbox({
    onCommand: () => ({ exitCode: 1, stdout: '', stderr: 'still failing' }),
  });
  const router = testingRouter({
    testing: [
      () => call('run_validation', { operation: 'test' }),
      () => call('submit_review', review('blocking', 'Test fails.', oneFinding)),
      () => call('run_validation', { operation: 'test' }),
      () => call('submit_review', review('concern', 'Looks better but unproven.', oneFinding)),
    ],
  });
  const { run } = await turn({
    specialists: [testing],
    sandbox,
    limits: { ...limits, maxSpecialistConsultations: 3 },
    script: [
      () => call('consult_specialist', { role: 'testing', question: 'Validate.' }),
      router,
      router,
      () => call('consult_specialist', { role: 'testing', question: 'Now?', resolves: 'testing-1' }),
      router,
      router,
      () => say('done'),
    ],
  });

  assert.equal(run.stopReason, 'blocked');
  assert.deepEqual(
    run.unresolvedBlockers.map((blocker) => blocker.id),
    ['testing-1'],
  );
});

test('Architecture and Security still run concurrently', async () => {
  const tracker = new Tracker();
  const specialists = byRole({
    security: async () => tracker.run(() => call('submit_review', review('ok', 'Safe.', []))),
    architecture: async () => tracker.run(() => call('submit_review', review('ok', 'Sound.', []))),
  });
  await turn({
    specialists: [architecture, security],
    script: [() => batchOf(secUse, archUse), specialists, specialists, () => say('done')],
  });
  assert.equal(tracker.max, 2);
});

test('a Testing consultation serializes against a concurrent Security consultation', async () => {
  const tracker = new Tracker();
  const sandbox = new ValidationSandbox({ tracker, onCommand: () => ({ exitCode: 0, stdout: '', stderr: '' }) });
  const router = testingRouter({
    security: async () => tracker.run(() => call('submit_review', review('ok', 'Safe.', []))),
    testing: [
      () => call('run_validation', { operation: 'test' }),
      () => call('submit_review', review('ok', 'Passes.', [])),
    ],
  });
  await turn({
    specialists: [security, testing],
    sandbox,
    script: [() => batchOf(secUse, testUse), router, router, router, () => say('done')],
  });
  // Testing is not parallel-safe, so it never overlapped the Security review.
  assert.equal(tracker.max, 1);
});

for (const other of [
  { id: 'use-write', name: 'write_file', input: { path: 'src/x.ts', content: 'y' } },
  { id: 'use-cmd', name: 'run_command', input: { command: 'npm run something' } },
]) {
  test(`Testing serializes against a concurrent ${other.name}`, async () => {
    const tracker = new Tracker();
    const sandbox = new ValidationSandbox({ tracker, onCommand: () => ({ exitCode: 0, stdout: '', stderr: '' }) });
    const router = testingRouter({
      testing: [
        () => call('run_validation', { operation: 'test' }),
        () => call('submit_review', review('ok', 'Passes.', [])),
      ],
    });
    await turn({
      specialists: [testing],
      sandbox,
      script: [() => batchOf(testUse, other), router, router, () => say('done')],
    });
    assert.equal(tracker.max, 1);
  });
}
