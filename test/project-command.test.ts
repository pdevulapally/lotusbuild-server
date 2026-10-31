import assert from 'node:assert/strict';
import test from 'node:test';
import type { EntitlementService } from '../src/entitlements/service.ts';
import { ResolvedEntitlements } from '../src/entitlements/service.ts';
import { ProjectRepository } from '../src/projects/repository.ts';
import { UserRepository } from '../src/users/repository.ts';
import { ledger } from './support/ledger.ts';

test('a lost project response can be reconciled without duplicating projects or retaining deleted project content', async () => {
  const { db, data } = ledger();
  data.set('users/alice', { uid: 'alice', email: 'alice@example.test', projectCount: 0 });
  const capabilities = new ResolvedEntitlements(new Map([
    ['platform.web', { kind: 'boolean' as const, value: true }], ['projects.max', { kind: 'number' as const, value: 5 }],
  ]));
  const entitlements = { forUser: async () => ({ capabilities, planName: 'Test', planKey: 'test' }) } as unknown as EntitlementService;
  const projects = new ProjectRepository(db, new UserRepository(db), entitlements);
  const input = { name: 'Example', description: undefined, platform: 'web' as const };
  const results = await Promise.all(Array.from({ length: 4 }, () => projects.create('alice', input, 'stable-project-command')));
  const first = results[0]!;
  assert.ok(results.every((project) => project.id === first.id));
  assert.equal(data.get('users/alice')?.['projectCount'], 1);
  const receipt = [...data].find(([key]) => key.startsWith('mutationReceipts/'))?.[1];
  assert.deepEqual(JSON.parse(String(receipt?.['acceptance'])), { id: first.id });
  await assert.rejects(projects.create('alice', { ...input, name: 'Changed' }, 'stable-project-command'), { code: 'request/idempotency-conflict' });
  data.delete(`projects/${first.id}`);
  await assert.rejects(projects.create('alice', input, 'stable-project-command'), { code: 'project/not-found' });
  assert.equal([...data.keys()].filter((key) => /^projects\/[a-z0-9-]+$/.test(key)).length, 0);
});

test('an unlimited project cap admits a fourth project without weakening the counter', async () => {
  const { db, data } = ledger();
  data.set('users/alice', { uid: 'alice', email: 'alice@example.test', projectCount: 3 });
  const capabilities = new ResolvedEntitlements(new Map([
    ['platform.web', { kind: 'boolean' as const, value: true }], ['projects.max', { kind: 'number' as const, value: 'unlimited' as const }],
  ]));
  const entitlements = { forUser: async () => ({ capabilities, planName: 'Free', planKey: 'free' }) } as unknown as EntitlementService;
  const projects = new ProjectRepository(db, new UserRepository(db), entitlements);
  const input = { name: 'Fourth', description: undefined, platform: 'web' as const };
  const [fourth, fifth] = await Promise.all([projects.create('alice', input, 'fourth-project-command'), projects.create('alice', { ...input, name: 'Fifth' }, 'fifth-project-command')]);
  assert.notEqual(fourth!.id, fifth!.id);
  assert.equal(data.get('users/alice')?.['projectCount'], 5);
  assert.throws(() => capabilities.number('projects.max'), { code: 'entitlement/misconfigured' });
  assert.equal(capabilities.limit('projects.max'), 'unlimited');
});

test('a finite project cap still rejects the project that would exceed it', async () => {
  const { db, data } = ledger();
  data.set('users/alice', { uid: 'alice', email: 'alice@example.test', projectCount: 3 });
  const capabilities = new ResolvedEntitlements(new Map([
    ['platform.web', { kind: 'boolean' as const, value: true }], ['projects.max', { kind: 'number' as const, value: 3 }],
  ]));
  const entitlements = { forUser: async () => ({ capabilities, planName: 'Pro', planKey: 'pro' }) } as unknown as EntitlementService;
  const projects = new ProjectRepository(db, new UserRepository(db), entitlements);
  await assert.rejects(projects.create('alice', { name: 'Fourth', description: undefined, platform: 'web' as const }, 'fourth-project-command'),
    { code: 'project/limit-reached' });
});
