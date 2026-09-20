import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRegistry } from '../src/entitlements/schema.ts';
import { registryDocument } from '../src/seed/config.ts';
import { desktopAgentInstructions, desktopSettings, withDesktop } from '../src/seed/desktop-row.ts';

const seeded = registryDocument as unknown as Record<string, unknown>;
const web = (fields: Record<string, unknown>) => (fields['sandboxProviders'] as Record<string, unknown>[]).find((row) => row['platform'] === 'web')!;

test('enabling changes only the web row, and the result is valid configuration with a desktop', () => {
  const { fields, changes } = withDesktop(seeded, 'enable');

  assert.deepEqual(changes.map((change) => change.field).sort(), ['agentInstructions', 'desktop', 'memoryMb', 'template']);
  assert.equal(web(fields)['template'], 'lotusbuild-desktop-dev');
  assert.deepEqual(web(fields)['desktop'], desktopSettings);
  assert.equal(web(fields)['agentInstructions'], desktopAgentInstructions);
  // Everything else in the document is exactly as it was, including the other provider row.
  for (const [key, value] of Object.entries(seeded)) if (key !== 'sandboxProviders') assert.deepEqual(fields[key], value);
  const mobile = (rows: unknown) => (rows as Record<string, unknown>[]).find((row) => row['platform'] === 'mobile');
  assert.deepEqual(mobile(fields['sandboxProviders']), mobile(seeded['sandboxProviders']));
  // The other fields of the web row are untouched.
  for (const key of ['provider', 'timeoutSeconds', 'cpus', 'concurrencyMeterKey', 'workdir', 'idleGraceSeconds', 'validationProfiles']) {
    assert.deepEqual(web(fields)[key], web(seeded)[key], key);
  }
  const parsed = parseRegistry(fields, 'registry').sandboxProviders.get('web')!;
  assert.deepEqual(parsed.desktop, desktopSettings);
});

test('disabling is the exact inverse of enabling', () => {
  const enabled = withDesktop(seeded, 'enable').fields;
  const back = withDesktop(enabled, 'disable');
  assert.deepEqual(back.fields, seeded);
  assert.equal(parseRegistry(back.fields, 'registry').sandboxProviders.get('web')!.desktop, undefined);
  assert.deepEqual(back.changes.map((change) => change.field).sort(), ['agentInstructions', 'desktop', 'memoryMb', 'template']);
});

test('doing either twice changes nothing the second time', () => {
  const once = withDesktop(seeded, 'enable').fields;
  assert.deepEqual(withDesktop(once, 'enable').changes, []);
  assert.deepEqual(withDesktop(seeded, 'disable').changes, []);
});

test('a registry without exactly one web provider is refused', () => {
  assert.throws(() => withDesktop({ ...seeded, sandboxProviders: [] }, 'enable'), /exactly one web/);
  const rows = seeded['sandboxProviders'] as Record<string, unknown>[];
  assert.throws(() => withDesktop({ ...seeded, sandboxProviders: [...rows, ...rows] }, 'enable'), /exactly one web/);
  assert.throws(() => withDesktop({ ...seeded, sandboxProviders: 'nope' }, 'enable'), /no sandboxProviders/);
});

test('the desktop instructions do not send the agent to start_preview and admit it cannot see the screen', () => {
  assert.equal(/use start_preview|run start_preview/i.test(desktopAgentInstructions), false);
  assert.ok(desktopAgentInstructions.includes('start_preview and public URLs are not available'));
  assert.ok(desktopAgentInstructions.includes('you have no screenshot tool'));
  assert.ok(desktopAgentInstructions.includes('--host 0.0.0.0'));
  // Without these Chrome stops on a welcome dialog and never opens the page.
  assert.ok(desktopAgentInstructions.includes('--no-first-run --no-default-browser-check'));
  assert.ok(desktopAgentInstructions.includes('DISPLAY is already set to :0'));
});
