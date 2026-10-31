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
