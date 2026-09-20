import { registryDocument } from './config.ts';

/**
 * What turning the desktop on changes on the `web` sandbox provider row, and the
 * rule for changing it back.
 *
 * The seeded registry deliberately has no desktop, and re-seeding a live registry
 * overwrites limits an operator has edited since. So enabling the desktop is its
 * own small, reviewable edit to one row, not a reseed.
 */

/** The template that carries Node, a browser and the desktop stack. Built in the E2B account. */
const desktopTemplate = 'lotusbuild-desktop-dev';

/**
 * The desktop the agent gets, and the models that may operate it.
 *
 * 1280x800 is what the docs recommend for web apps and is one screenshot of about
 * 1,300 tokens. The models are the ones the API supports the computer tool on
 * that a paid plan can already choose, so Free, which is Haiku only, gets a
 * desktop to watch and no screen to operate.
 */
export const desktopSettings = { width: 1280, height: 800, computerModels: ['claude-sonnet-5', 'claude-opus-5'] } as const;

/**
 * The instructions for a desktop build. The seeded ones tell the agent to use
 * `start_preview`, which a desktop provider refuses, so they must change with the
 * template.
 *
 * They say how the machine is set up and nothing about what the agent can do with
 * the screen. That depends on the model and on whether the desktop came up, which
 * configuration cannot know, so the runner says it for each session.
 */
export const desktopAgentInstructions = [
  'This is a web project. Scaffold with Vite unless the user asks for something else, and prefer React with TypeScript.',
  '',
  'The sandbox has a desktop: DISPLAY is already set to :0 and Google Chrome is installed.',
  '',
  'To run the app on the desktop:',
  '1. Start the dev server in the background with its output redirected, as one command with no cd (commands',
  '   already run in the project directory), for example:',
  '   nohup npm run dev -- --host 0.0.0.0 --port 5173 > /tmp/dev.log 2>&1 &',
  '   The --host flag is required, or the server cannot be reached at all. Do not write "cd dir && server &":',
  '   the background part keeps the output of the command open, so the call hangs until it times out.',
  '2. Confirm it is up before you go on: curl -sf http://127.0.0.1:5173/ (retry a few times, and read',
  '   /tmp/dev.log if it does not answer).',
  '3. Open it in the browser (the first-run flags stop Chrome waiting on a welcome dialog and never opening the page):',
  '   nohup google-chrome --no-sandbox --disable-gpu --no-first-run --no-default-browser-check --start-maximized --new-window http://127.0.0.1:5173 > /tmp/chrome.log 2>&1 &',
  '',
  'start_preview and public URLs are not available in this sandbox. Do not try to expose a port.',
].join('\n');

const seededWeb = (() => {
  const row = registryDocument.sandboxProviders.find((candidate) => candidate.platform === 'web');
  if (row === undefined) throw new Error('The seeded registry has no web sandbox provider.');
  return row;
})();

export type DesktopMode = 'enable' | 'disable';

export interface RowChange {
  readonly field: string;
  readonly from: unknown;
  readonly to: unknown;
}

/**
 * Returns the registry fields with the `web` provider row switched, and what
 * changed. Nothing else in the document is touched: not the other provider rows,
 * not the capabilities, meters or specialists. Pure, so it can be shown as a
 * dry run and tested without a database.
 *
 * Disabling restores the seeded template, size and instructions and removes the
 * `desktop` field, which is what makes it the exact inverse of enabling.
 */
export function withDesktop(
  registry: Readonly<Record<string, unknown>>,
  mode: DesktopMode,
): { readonly fields: Record<string, unknown>; readonly changes: readonly RowChange[] } {
  const rows = registry['sandboxProviders'];
  if (!Array.isArray(rows)) throw new Error('The registry has no sandboxProviders list.');
  const matching = rows.flatMap((row: unknown, index) =>
    typeof row === 'object' && row !== null && (row as Record<string, unknown>)['platform'] === 'web' ? [index] : []);
  if (matching.length !== 1) {
    throw new Error(`The registry must have exactly one web sandbox provider; it has ${matching.length}.`);
  }
  const index = matching[0]!;
  const current = rows[index] as Record<string, unknown>;

  const { desktop: _removed, ...withoutDesktop } = current;
  const next: Record<string, unknown> = mode === 'enable'
    ? { ...current, template: desktopTemplate, memoryMb: 4096, desktop: { ...desktopSettings, computerModels: [...desktopSettings.computerModels] }, agentInstructions: desktopAgentInstructions }
    : { ...withoutDesktop, template: seededWeb.template, memoryMb: seededWeb.memoryMb, agentInstructions: seededWeb.agentInstructions };

  const changes: RowChange[] = [];
  for (const field of new Set([...Object.keys(current), ...Object.keys(next)])) {
    if (JSON.stringify(current[field]) !== JSON.stringify(next[field])) {
      changes.push({ field, from: current[field], to: next[field] });
    }
  }
  const sandboxProviders = rows.map((row: unknown, position) => (position === index ? next : row));
  return { fields: { ...registry, sandboxProviders }, changes };
}
