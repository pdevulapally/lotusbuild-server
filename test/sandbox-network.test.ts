import assert from 'node:assert/strict';
import test from 'node:test';
import { ALL_TRAFFIC, Sandbox } from 'e2b';
import { parsePlan, parseRegistry, parseSandboxNetwork, type SandboxNetworkPolicy } from '../src/entitlements/schema.ts';
import { registryDocument, planDocuments } from '../src/seed/config.ts';
import { E2BAdapter } from '../src/sandboxes/e2b.ts';
import { SandboxService } from '../src/sandboxes/service.ts';
import type { ConfigurationStore } from '../src/entitlements/store.ts';
import type { UserEntitlements } from '../src/entitlements/service.ts';
import type { MeteringService } from '../src/metering/service.ts';
import type { RunningSandbox, SandboxAdapter } from '../src/sandboxes/provider.ts';

const registry = parseRegistry(registryDocument, 'config/registry');
const provider = registry.sandboxProviders.get('web')!;

test('sandbox service takes policy from the resolved plan for primary and validation VMs', async () => {
  const plans = new Map(planDocuments.map((doc) => [doc.key, parsePlan(doc, `plans/${doc.key}`, registry)]));
  const policies: SandboxNetworkPolicy[] = [];
  const running = { externalId: 'fixture', lifetime: async () => ({ startedAt: new Date(0), endAt: new Date(60000) }) } as RunningSandbox;
  const adapter = { start: async (_provider, context) => { policies.push(context.networkPolicy); return running; } } as SandboxAdapter;
  const service = new SandboxService({ get: async () => ({ registry, plans }) } as unknown as ConfigurationStore,
    { markInFlight: async () => {}, recordSandbox: async () => {} } as unknown as MeteringService,
    new Map([['e2b', adapter]]));
  const input = { uid: 'u', platform: 'web' as const, sessionId: 's', now: new Date(),
    entitlements: { planKey: 'business' } as UserEntitlements,
    reservations: { take: async (hold: { meterKey: string; quantity: number; operationId: string }) => ({
      id: `fixture-${hold.meterKey}`, meterKey: hold.meterKey, estimatedQuantity: hold.quantity,
      operationId: hold.operationId, status: 'OPEN' as const,
    }) } };
  await service.acquire(input);
  await service.acquire({ ...input, source: { ...running,
    forkForValidation: async (_timeout, policy) => { policies.push(policy); return running; } } });
  assert.deepEqual(policies, [plans.get('business')!.sandboxNetwork, plans.get('business')!.sandboxNetwork]);
  await assert.rejects(service.acquire({ ...input, entitlements: { planKey: 'unknown' } as UserEntitlements }), /not configured/);
  assert.equal(policies.length, 2);
});

test('plan network policy implements unrestricted Free/Pro and restricted Business', () => {
  for (const document of planDocuments) {
    const plan = parsePlan(document, `plans/${document.key}`, registry);
    assert.deepEqual(plan.sandboxNetwork, document.key === 'business'
      ? { mode: 'restricted', allowedDomains: [] } : { mode: 'unrestricted' });
  }
});

test('existing plan documents without network policy use their existing catalog policy', () => {
  for (const seeded of planDocuments) {
    const document: Record<string, unknown> = { ...seeded };
    delete document['sandboxNetwork'];
    const plan = parsePlan(document, `plans/${seeded.key}`, registry);
    assert.deepEqual(plan.sandboxNetwork, seeded.sandboxNetwork);
    assert.deepEqual(document, Object.fromEntries(Object.entries(seeded).filter(([key]) => key !== 'sandboxNetwork')));
  }
});

test('explicit plan network settings override the catalog and malformed settings still fail', () => {
  const policy = { mode: 'restricted', allowedDomains: ['registry.npmjs.org'] };
  for (const seeded of planDocuments) {
    assert.deepEqual(parsePlan({ ...seeded, sandboxNetwork: policy }, `plans/${seeded.key}`, registry).sandboxNetwork, policy);
    for (const invalid of [null, undefined, {}, { mode: 'restricted', allowedDomains: ['*'] }]) {
      assert.throws(() => parsePlan({ ...seeded, sandboxNetwork: invalid }, `plans/${seeded.key}`, registry));
    }
  }
});

test('unknown plan keys cannot inherit a known plan network policy', () => {
  for (const key of ['custom', 'constructor', '__proto__']) {
    const document: Record<string, unknown> = { ...planDocuments[0], key };
    delete document['sandboxNetwork'];
    assert.throws(() => parsePlan(document, `plans/${key}`, registry), /explicitly configured/);
  }
});

test('restricted policy refuses ambiguous domains and accepts exact approved names', () => {
  for (const domain of ['*', '*.example.com', 'https://example.com', 'example.com:443',
    'example.com/path', '127.0.0.1', '::1', 'localhost', 'example.com\n', 'EXAMPLE.COM', '-bad.example', 'example.com.']) {
    assert.throws(() => parseSandboxNetwork({ mode: 'restricted', allowedDomains: [domain] }, 'test'));
  }
  for (const value of [undefined, null, {}, { mode: 'restricted' },
    { mode: 'unrestricted', allowedDomains: ['example.com'] },
    { mode: 'restricted', allowedDomains: ['example.com', 'example.com'] }]) {
    assert.throws(() => parseSandboxNetwork(value, 'test'));
  }
  assert.deepEqual(parseSandboxNetwork({ mode: 'restricted', allowedDomains: ['registry.npmjs.org'] }, 'test'),
    { mode: 'restricted', allowedDomains: ['registry.npmjs.org'] });
});

for (const policy of [{ mode: 'unrestricted' }, { mode: 'restricted', allowedDomains: [] },
  { mode: 'restricted', allowedDomains: ['registry.npmjs.org'] }] satisfies SandboxNetworkPolicy[]) {
  test(`sandbox creation sends explicit provider-enforced network policy ${JSON.stringify(policy)}`, async (t) => {
    let created: Record<string, unknown> | undefined;
    t.mock.method(Sandbox, 'create', async (_template: string, options: Record<string, unknown>) => {
      created = options;
      return { commands: { run: async () => ({}) } };
    });
    await new E2BAdapter('fixture-key', 'example.test', false, 4096).start(provider,
      { metadata: {}, publicPreviewEnabled: false, networkPolicy: policy });
    assert.equal(created?.['secure'], true);
    assert.deepEqual(created?.['network'], { allowPublicTraffic: false,
      denyOut: policy.mode === 'restricted' ? [ALL_TRAFFIC] : [],
      allowOut: policy.mode === 'restricted' ? policy.allowedDomains : [ALL_TRAFFIC] });
  });
}

test('missing runtime network policy is rejected before provider creation', async (t) => {
  const create = t.mock.method(Sandbox, 'create', async () => { throw new Error('Provider should not be contacted'); });
  await assert.rejects(new E2BAdapter('fixture-key', 'example.test', false, 4096).start(provider,
    { metadata: {}, networkPolicy: undefined as never }), /explicitly configured/);
  assert.equal(create.mock.callCount(), 0);
});

for (const failure of ['none', 'parent', 'child']) {
  test(`validation applies network policy before dispatch and cleans up on failure: ${failure}`, async (t) => {
    const events: string[] = [];
    const policies: unknown[] = [];
    const child = { updateNetwork: async (policy: unknown) => {
      events.push('child-policy'); policies.push(policy);
      if (failure === 'child') throw new Error('Child policy failed');
    }, kill: async () => { events.push('child-stop'); } };
    t.mock.method(Sandbox, 'create', async () => ({
      commands: { run: async () => ({}) },
      updateNetwork: async (policy: unknown) => {
        events.push('parent-policy'); policies.push(policy);
        if (failure === 'parent') throw new Error('Parent policy failed');
      },
      fork: async () => { events.push('fork'); return [child]; },
    }));
    const adapter = new E2BAdapter('fixture-key', 'example.test', false, 4096);
    const primary = await adapter.start(provider, { metadata: {}, networkPolicy: { mode: 'unrestricted' } });
    const fork = primary.forkForValidation!(1000, { mode: 'restricted', allowedDomains: [] });
    if (failure === 'none') await fork;
    else await assert.rejects(fork, /policy failed/);
    assert.deepEqual(events, failure === 'parent' ? ['parent-policy']
      : failure === 'child' ? ['parent-policy', 'fork', 'child-policy', 'child-stop']
        : ['parent-policy', 'fork', 'child-policy']);
    for (const policy of policies) assert.deepEqual(policy, { denyOut: [ALL_TRAFFIC], allowOut: [] });
  });
}
