import assert from 'node:assert/strict';
import test from 'node:test';

import Fastify from 'fastify';
import type { Auth } from 'firebase-admin/auth';

import { registerAuth } from '../src/auth/plugin.ts';
import { registerErrorHandler } from '../src/http/errors.ts';
import { systemPrompt } from '../src/runner/agent.ts';
import { validateSkillInput, type Skill } from '../src/skills/model.ts';
import { mentionedSkills, skillCatalogue, skillInstructionsText } from '../src/skills/prompt.ts';
import { registerSkillRoutes } from '../src/skills/routes.ts';
import type { SkillRepository } from '../src/skills/repository.ts';

const skill = (name: string, extra: Partial<Skill> = {}): Skill => ({
  id: `id-${name}`, ownerUid: 'alice', name, title: name.replace(/-/g, ' '), description: `Use for ${name} work`, instructions: `Do ${name} things`,
  enabled: true, createdAt: new Date(0), updatedAt: new Date(0), ...extra,
});

test('skill input is normalised and bounded', () => {
  const valid = validateSkillInput({ name: ' Shopify-Theme ', title: ' Shopify theme ', description: 'Use  when\n editing  liquid', instructions: 'Edit sections/*.liquid\r\n' });
  assert.deepEqual(valid, { name: 'shopify-theme', title: 'Shopify theme', description: 'Use when editing liquid', instructions: 'Edit sections/*.liquid', enabled: true });
  for (const name of ['-bad', 'Has Space', 'x'.repeat(49), '']) assert.throws(() => validateSkillInput({ name, title: 't', description: 'd', instructions: 'i' }), /skill name/);
  assert.throws(() => validateSkillInput({ name: 'ok', title: 'a\u0007', description: 'd', instructions: 'i' }), /title/);
  assert.throws(() => validateSkillInput({ name: 'ok', title: 't', description: 'd', instructions: 'x'.repeat(20_001) }), /instructions/);
});

test('the prompt carries only the catalogue; mentions load exact skills in order, once', () => {
  const skills = [skill('shopify-theme'), skill('seo-audit')];
  const lines = skillCatalogue(skills);
  assert.ok(lines.some((line) => line.includes('- shopify-theme: shopify theme — Use for shopify-theme work')));
  assert.ok(!lines.join('\n').includes('Do shopify-theme things'), 'instructions never sit in the prompt');
  assert.deepEqual(skillCatalogue([]), []);
  assert.deepEqual(mentionedSkills('Please /seo-audit this and @shopify-theme (then @seo-audit again) email me@example.com', skills).map((s) => s.name), ['seo-audit', 'shopify-theme']);
  assert.deepEqual(mentionedSkills('nothing here @unknown', skills), []);
  const text = skillInstructionsText(skills[0]!);
  assert.deepEqual(JSON.parse(text), { type: 'user_skill_instructions', name: 'shopify-theme', title: 'shopify theme', instructions: 'Do shopify-theme things' });
  const provider = { workdir: '/w', agentInstructions: 'x', desktop: undefined } as unknown as Parameters<typeof systemPrompt>[0];
  assert.ok(systemPrompt(provider, undefined, 'build', skills).includes('call use_skill'));
  assert.ok(!systemPrompt(provider, undefined, 'build', []).includes('use_skill'));
});

async function fixture() {
  const app = Fastify({ logger: false });
  registerAuth(app, { verifyIdToken: async () => ({ uid: 'alice', email_verified: true, auth_time: Date.now() / 1000, exp: Date.now() / 1000 + 3600 }) } as unknown as Auth);
  registerErrorHandler(app);
  app.decorate('enforceRateLimit', () => async () => {});
  const calls: { method: string; args: unknown[] }[] = [];
  const repo = {
    list: async (...args: unknown[]) => { calls.push({ method: 'list', args }); return [skill('seo-audit')]; },
    create: async (...args: unknown[]) => { calls.push({ method: 'create', args }); return skill('new-one'); },
    update: async (...args: unknown[]) => { calls.push({ method: 'update', args }); return skill('seo-audit', { enabled: false }); },
    delete: async (...args: unknown[]) => { calls.push({ method: 'delete', args }); },
  } as unknown as SkillRepository;
  registerSkillRoutes(app, repo);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  return { app, address, calls };
}
const headers = { Authorization: 'Bearer t', 'Content-Type': 'application/json' };

test('skill routes are owner-scoped CRUD with strict bodies', async () => {
  const h = await fixture();
  try {
    const list = await fetch(`${h.address}/skills`, { headers });
    assert.equal(list.status, 200);
    assert.equal(((await list.json()) as { skills: { name: string }[] }).skills[0]?.name, 'seo-audit');
    assert.deepEqual(h.calls[0], { method: 'list', args: ['alice'] });
    const created = await fetch(`${h.address}/skills`, { method: 'POST', headers, body: JSON.stringify({ name: 'new-one', title: 'New', description: 'd', instructions: 'i' }) });
    assert.equal(created.status, 201);
    assert.equal(h.calls[1]?.args[0], 'alice');
    const badName = await fetch(`${h.address}/skills`, { method: 'POST', headers, body: JSON.stringify({ name: 'Bad Name', title: 'New', description: 'd', instructions: 'i' }) });
    assert.equal(badName.status, 400);
    const extra = await fetch(`${h.address}/skills`, { method: 'POST', headers, body: JSON.stringify({ name: 'ok', title: 'New', description: 'd', instructions: 'i', ownerUid: 'bob' }) });
    // Fastify's validator strips unknown fields (removeAdditional), so a smuggled ownerUid never reaches the repository.
    assert.equal(extra.status, 201);
    assert.equal((h.calls.at(-1)?.args[1] as Record<string, unknown>)['ownerUid'], undefined);
    const patched = await fetch(`${h.address}/skills/id-seo-audit`, { method: 'PATCH', headers, body: JSON.stringify({ enabled: false }) });
    assert.equal(patched.status, 200);
    assert.deepEqual(h.calls.at(-1)?.args, ['alice', 'id-seo-audit', { enabled: false }]);
    assert.equal((await fetch(`${h.address}/skills/id-seo-audit`, { method: 'PATCH', headers, body: '{}' })).status, 400);
    assert.equal((await fetch(`${h.address}/skills/id-seo-audit`, { method: 'DELETE', headers: { Authorization: 'Bearer t' } })).status, 204);
    assert.deepEqual(h.calls.at(-1), { method: 'delete', args: ['alice', 'id-seo-audit'] });
  } finally { await h.app.close(); }
});
