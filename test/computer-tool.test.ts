import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';

import { parseRegistry } from '../src/entitlements/schema.ts';
import { computerToolset, createComputer, prunedScreenshotText, pruneScreenshots, screenshotBlock } from '../src/runner/computer.ts';
import { registryDocument } from '../src/seed/config.ts';
import { withDesktop } from '../src/seed/desktop-row.ts';
import type { CommandOutcome, RunningSandbox } from '../src/sandboxes/provider.ts';

const screen = { width: 1280, height: 800 } as const;

/** The smallest thing that reads as a PNG of a given size: signature, then the header's size fields. */
function fakePng(width: number, height: number): Buffer {
  const png = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

interface Ran { readonly command: string; readonly envs: Readonly<Record<string, string>> | undefined; readonly timeoutMs: number }

class DesktopSandbox implements RunningSandbox {
  readonly externalId = 'sandbox-1';
  readonly ran: Ran[] = [];
  outcome: (command: string) => CommandOutcome = () => ({ exitCode: 0, stdout: '', stderr: '' });
  capture: Buffer = fakePng(screen.width, screen.height);
  readBytesCalls: { path: string; maxBytes: number }[] = [];

  async runCommand(command: string, options: { readonly envs?: Readonly<Record<string, string>>; readonly timeoutMs: number }): Promise<CommandOutcome> {
    this.ran.push({ command, envs: options.envs, timeoutMs: options.timeoutMs });
    return this.outcome(command);
  }
  async readBytes(path: string, maxBytes: number): Promise<Buffer> {
    this.readBytesCalls.push({ path, maxBytes });
    return this.capture;
  }
  async writeFile(): Promise<void> {}
  async readFile(): Promise<string> { return ''; }
  previewUrl(): string { return 'https://preview.invalid'; }
  async stop(): Promise<void> {}
}

const signal = () => new AbortController().signal;

function setup() {
  const sandbox = new DesktopSandbox();
  return { sandbox, computer: createComputer(sandbox, screen) };
}

test('a screenshot is captured with the pointer, read back as bytes and checked against the screen size', async () => {
  const { sandbox, computer } = setup();
  const result = await computer.run('screenshot', {}, signal());

  assert.equal(result.isError, false);
  assert.equal(result.text, 'Screenshot 1280x800');
  assert.deepEqual(result.image, sandbox.capture);
  assert.match(sandbox.ran[0]!.command, /scrot -p -o \/tmp\/lotusbuild-screen\.png$/);
  assert.equal(sandbox.readBytesCalls[0]!.path, '/tmp/lotusbuild-screen.png');
  assert.equal(sandbox.readBytesCalls[0]!.maxBytes, 4 * 1024 * 1024);
});

test('a capture that is not the size clicks are measured in is refused, not passed along', async () => {
  const { sandbox, computer } = setup();
  sandbox.capture = fakePng(1024, 768);
  const result = await computer.run('screenshot', {}, signal());
  assert.equal(result.isError, true);
  assert.equal(result.image, undefined);
  assert.match(result.text, /1024x768, not the configured 1280x800/);

  sandbox.capture = Buffer.from('this is not a png at all, only text of a decent length');
  assert.match((await computer.run('screenshot', {}, signal())).text, /not a PNG/);
});

test('zoom captures the region, and its far corner may be the edge of the screen', async () => {
  const { sandbox, computer } = setup();
  sandbox.capture = fakePng(300, 200);
  const result = await computer.run('zoom', { region: [100, 50, 400, 250] }, signal());
  assert.equal(result.isError, false);
  assert.match(sandbox.ran[0]!.command, /scrot -p -a 100,50,300,200 -o/);

  sandbox.capture = fakePng(1280, 800);
  assert.equal((await computer.run('zoom', { region: [0, 0, 1280, 800] }, signal())).isError, false);
  for (const region of [[10, 10, 10, 50], [50, 50, 10, 10], [0, 0, 1281, 800], [-1, 0, 5, 5], [0, 0, 5], 'all', [0.5, 0, 5, 5]]) {
    assert.equal((await computer.run('zoom', { region }, signal())).isError, true, JSON.stringify(region));
  }
});

test('clicks map to the right button and count, at a coordinate or at the pointer', async () => {
  const { sandbox, computer } = setup();
  await computer.run('left_click', { coordinate: [100, 200] }, signal());
  await computer.run('right_click', { coordinate: [1, 2] }, signal());
  await computer.run('middle_click', {}, signal());
  await computer.run('double_click', { coordinate: [5, 6] }, signal());
  await computer.run('triple_click', { coordinate: [7, 8] }, signal());

  assert.deepEqual(sandbox.ran.map((ran) => ran.command), [
    'xdotool mousemove 100 200 sleep 0.05 click --repeat 1 --delay 60 1',
    'xdotool mousemove 1 2 sleep 0.05 click --repeat 1 --delay 60 3',
    'xdotool click --repeat 1 --delay 60 2',
    'xdotool mousemove 5 6 sleep 0.05 click --repeat 2 --delay 60 1',
    'xdotool mousemove 7 8 sleep 0.05 click --repeat 3 --delay 60 1',
  ]);
  // Live, `--sync` to where the pointer already is blocked for 15 seconds, so it must never come back.
  assert.equal(sandbox.ran.some((ran) => ran.command.includes('--sync')), false);
});

test('modifiers are held around the click and released even if the click fails', async () => {
  const { sandbox, computer } = setup();
  await computer.run('left_click', { coordinate: [10, 20], text: 'ctrl+shift' }, signal());
  const command = sandbox.ran[0]!.command;
  assert.match(command, /^xdotool keydown ctrl keydown shift mousemove 10 20 sleep 0.05 click --repeat 1 --delay 60 1 keyup ctrl keyup shift \|\| \{ xdotool keyup ctrl keyup shift; exit 1; \}$/);

  for (const text of ['hyper', 'ctrl+', 'ctrl+ctrl', 'ctrl; reboot', 42]) {
    sandbox.ran.length = 0;
    const result = await computer.run('left_click', { coordinate: [1, 1], text }, signal());
    assert.equal(result.isError, true, String(text));
    assert.equal(sandbox.ran.length, 0, 'a refused input never reaches the shell');
  }
});

test('coordinates outside the screen, or that are not whole numbers, are refused before anything runs', async () => {
  const { sandbox, computer } = setup();
  for (const coordinate of [[1280, 0], [0, 800], [-1, 5], [1.5, 2], ['1', '2'], [1], 'centre', null, [Number.NaN, 1]]) {
    const result = await computer.run('left_click', { coordinate }, signal());
    assert.equal(result.isError, true, JSON.stringify(coordinate));
  }
  assert.equal(sandbox.ran.length, 0);
  assert.match((await computer.run('left_click', { coordinate: [1280, 0] }, signal())).text, /not on the 1280x800 screen; x is 0 to 1279 and y is 0 to 799/);
});

test('typed text never reaches the shell as part of the command', async () => {
  const { sandbox, computer } = setup();
  const hostile = '"; rm -rf / #$(reboot) `id` \n\'quoted\'';
  const result = await computer.run('type', { text: hostile }, signal());

  assert.equal(result.isError, false);
  assert.equal(result.text, `typed ${hostile.length} characters`);
  const ran = sandbox.ran[0]!;
  assert.equal(ran.command, 'xdotool type --delay 12 --clearmodifiers -- "$LOTUSBUILD_TYPED"');
  assert.equal(ran.envs?.['LOTUSBUILD_TYPED'], hostile);
  assert.equal(ran.command.includes('rm -rf'), false);
  // Typing takes as long as it takes, so the timeout grows with the text.
  assert.ok(ran.timeoutMs >= 20_000 + hostile.length * 40);
});

test('typing refuses nothing, too much, or a null character, and says what to do instead', async () => {
  const { sandbox, computer } = setup();
  for (const text of ['', undefined, 5, 'a\0b']) assert.equal((await computer.run('type', { text }, signal())).isError, true);
  const tooLong = await computer.run('type', { text: 'x'.repeat(2001) }, signal());
  assert.equal(tooLong.isError, true);
  assert.match(tooLong.text, /write_file/);
  assert.equal(sandbox.ran.length, 0);
  assert.equal((await computer.run('type', { text: 'x'.repeat(2000) }, signal())).isError, false);
});

test('a typing failure reported on stderr is an error the model can read', async () => {
  const { sandbox, computer } = setup();
  sandbox.outcome = () => ({ exitCode: 0, stdout: '', stderr: 'No matching keysym for char' });
  const result = await computer.run('type', { text: 'é' }, signal());
  assert.equal(result.isError, true);
  assert.match(result.text, /Typing failed: No matching keysym/);
});

test('keys are validated against xdotool key names and travel in the environment', async () => {
  const { sandbox, computer } = setup();
  const result = await computer.run('key', { text: 'ctrl+s Return', repeat: 3 }, signal());
  assert.equal(result.isError, false);
  assert.equal(result.text, 'pressed ctrl+s Return 3 times');
  assert.equal(sandbox.ran[0]!.command, 'set -f; for _ in $(seq 3); do xdotool key --clearmodifiers --delay 40 -- $LOTUSBUILD_KEYS || exit 1; done');
  assert.equal(sandbox.ran[0]!.envs?.['LOTUSBUILD_KEYS'], 'ctrl+s Return');

  sandbox.ran.length = 0;
  for (const text of ['ctrl+s; reboot', '$(id)', '`id`', 'a|b', '../x', '-o', 'ctrl+', '', '   ', 'a b c d e f g h i j k']) {
    assert.equal((await computer.run('key', { text }, signal())).isError, true, JSON.stringify(text));
  }
  for (const repeat of [0, 101, 1.5, '2']) {
    assert.equal((await computer.run('key', { text: 'Tab', repeat }, signal())).isError, true, String(repeat));
  }
  assert.equal(sandbox.ran.length, 0);
});

test('an unknown key name, which xdotool reports on stderr while exiting 0, is an error', async () => {
  const { sandbox, computer } = setup();
  sandbox.outcome = () => ({ exitCode: 0, stdout: '', stderr: "No such key name 'enter'. Ignoring it." });
  const result = await computer.run('key', { text: 'enter' }, signal());
  assert.equal(result.isError, true);
  assert.match(result.text, /No such key name 'enter'/);
});

test('scroll uses the wheel buttons and the amount, at a coordinate or the pointer', async () => {
  const { sandbox, computer } = setup();
  await computer.run('scroll', { scroll_direction: 'down', scroll_amount: 3, coordinate: [640, 400] }, signal());
  await computer.run('scroll', { scroll_direction: 'up', scroll_amount: 1 }, signal());
  await computer.run('scroll', { scroll_direction: 'right', scroll_amount: 2, text: 'shift' }, signal());
  assert.equal(sandbox.ran[0]!.command, 'xdotool mousemove 640 400 sleep 0.05 click --repeat 3 --delay 30 5');
  assert.equal(sandbox.ran[1]!.command, 'xdotool click --repeat 1 --delay 30 4');
  assert.match(sandbox.ran[2]!.command, /keydown shift click --repeat 2 --delay 30 7 keyup shift/);

  sandbox.ran.length = 0;
  for (const input of [{ scroll_direction: 'sideways', scroll_amount: 1 }, { scroll_direction: 'constructor', scroll_amount: 1 }, { scroll_direction: 'up', scroll_amount: 0 },
    { scroll_direction: 'up', scroll_amount: 51 }, { scroll_direction: 'up' }, { scroll_amount: 2 }]) {
    assert.equal((await computer.run('scroll', input, signal())).isError, true, JSON.stringify(input));
  }
  assert.equal(sandbox.ran.length, 0);
});

test('a drag presses, moves and releases in order', async () => {
  const { sandbox, computer } = setup();
  const result = await computer.run('left_click_drag', { start_coordinate: [10, 20], coordinate: [300, 400] }, signal());
  assert.equal(result.text, 'dragged from [10, 20] to [300, 400]');
  assert.equal(sandbox.ran[0]!.command,
    'xdotool mousemove 10 20 sleep 0.05 mousedown 1 sleep 0.15 mousemove 300 400 sleep 0.15 mouseup 1');
  assert.equal((await computer.run('left_click_drag', { coordinate: [1, 1] }, signal())).isError, true);
});

test('mouse move, button down and up, and the pointer position', async () => {
  const { sandbox, computer } = setup();
  await computer.run('mouse_move', { coordinate: [11, 22] }, signal());
  await computer.run('left_mouse_down', {}, signal());
  await computer.run('left_mouse_up', {}, signal());
  assert.deepEqual(sandbox.ran.map((ran) => ran.command), ['xdotool mousemove 11 22 sleep 0.05', 'xdotool mousedown 1', 'xdotool mouseup 1']);

  sandbox.outcome = () => ({ exitCode: 0, stdout: 'X=512\nY=384\nSCREEN=0\nWINDOW=1234\n', stderr: '' });
  assert.equal((await computer.run('cursor_position', {}, signal())).text, 'X=512, Y=384');
  sandbox.outcome = () => ({ exitCode: 0, stdout: 'nonsense', stderr: '' });
  assert.equal((await computer.run('cursor_position', {}, signal())).isError, true);
});

test('a command that fails is an error result carrying its own words', async () => {
  const { sandbox, computer } = setup();
  sandbox.outcome = () => ({ exitCode: 1, stdout: '', stderr: "Can't open display :0\n" });
  const result = await computer.run('left_click', { coordinate: [1, 1] }, signal());
  assert.deepEqual({ isError: result.isError, text: result.text }, { isError: true, text: "Can't open display :0" });
});

test('hold_key is withheld from the model and refused if it asks anyway; so is anything unknown', async () => {
  const { sandbox, computer } = setup();
  assert.deepEqual(computerToolset, { type: 'computer_toolset_20260801', configs: { hold_key: { enabled: false } } });
  for (const member of ['hold_key', 'run_command', 'toString', 'constructor', '__proto__', '']) {
    const result = await computer.run(member, { text: 'shift', duration: 5 }, signal());
    assert.equal(result.isError, true, member);
    assert.match(result.text, /not available/);
  }
  assert.equal(sandbox.ran.length, 0);
});

test('wait is capped and says so, and a cancelled session stops waiting', async (t) => {
  const { computer } = setup();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const capped = computer.run('wait', { duration: 300 }, signal());
  t.mock.timers.tick(30_000);
  assert.equal((await capped).text, 'waited 30 seconds, the longest a single wait can be');

  const short = computer.run('wait', { duration: 2 }, signal());
  t.mock.timers.tick(2000);
  assert.equal((await short).text, 'waited 2 seconds');

  const controller = new AbortController();
  const cancelled = computer.run('wait', { duration: 20 }, controller.signal);
  controller.abort(new Error('session cancelled'));
  await assert.rejects(cancelled, /session cancelled/);

  for (const duration of [0, -1, Number.NaN, '5', undefined]) {
    assert.equal((await computer.run('wait', { duration }, signal())).isError, true, String(duration));
  }
});

test('a session that is already cancelled runs nothing', async () => {
  const { sandbox, computer } = setup();
  const controller = new AbortController();
  controller.abort(new Error('stopped'));
  await assert.rejects(computer.run('screenshot', {}, controller.signal), /stopped/);
  assert.equal(sandbox.ran.length, 0);
});

test('a sandbox that cannot return bytes cannot be given a computer', () => {
  const sandbox = new DesktopSandbox();
  (sandbox as { readBytes?: unknown }).readBytes = undefined;
  assert.throws(() => createComputer(sandbox, screen), /cannot return screenshots/);
});

/** `null` is a result with no toolset; `undefined` would take the default, which is what a caller passing nothing means. */
function screenshotTurn(id: string, toolset: string | null = 'computer'): MessageParam {
  return {
    role: 'user',
    content: [{
      type: 'tool_result', tool_use_id: id, ...(toolset === null ? {} : { toolset_name: toolset }),
      content: [screenshotBlock(fakePng(10, 10))],
    }],
  };
}

const imagesIn = (conversation: readonly MessageParam[]): string[] => conversation.flatMap((message) =>
  typeof message.content === 'string' ? [] : message.content.flatMap((block) =>
    block.type === 'tool_result' && Array.isArray(block.content)
      ? block.content.map((inner) => (inner.type === 'image' ? block.tool_use_id : '-')).filter((id) => id !== '-') : []));

test('screenshots are pruned in a batch once too many are held, keeping the newest', () => {
  const conversation: MessageParam[] = [{ role: 'user', content: 'build it' }];
  for (let index = 1; index <= 16; index += 1) conversation.push(screenshotTurn(`shot-${index}`));
  assert.equal(pruneScreenshots(conversation, { maxImages: 16, keep: 6 }), 0, 'at the maximum nothing is pruned');
  assert.equal(imagesIn(conversation).length, 16);

  conversation.push(screenshotTurn('shot-17'));
  assert.equal(pruneScreenshots(conversation, { maxImages: 16, keep: 6 }), 11);
  assert.deepEqual(imagesIn(conversation), ['shot-12', 'shot-13', 'shot-14', 'shot-15', 'shot-16', 'shot-17']);
  const replaced = conversation[1]!.content as { content: { type: string; text?: string }[] }[];
  assert.deepEqual(replaced[0]!.content, [{ type: 'text', text: prunedScreenshotText }]);

  assert.equal(pruneScreenshots(conversation, { maxImages: 16, keep: 6 }), 0, 'pruning again changes nothing');
  assert.equal(conversation[0]!.content, 'build it', 'the user\'s own messages are never touched');
});

test('only computer screenshots are pruned, and impossible limits are refused', () => {
  const conversation: MessageParam[] = [];
  for (let index = 1; index <= 5; index += 1) conversation.push(screenshotTurn(`other-${index}`, null));
  for (let index = 1; index <= 5; index += 1) conversation.push(screenshotTurn(`shot-${index}`));
  assert.equal(pruneScreenshots(conversation, { maxImages: 3, keep: 2 }), 3);
  assert.equal(imagesIn(conversation).filter((id) => id.startsWith('other-')).length, 5, 'images that are not ours are left alone');
  assert.deepEqual(imagesIn(conversation).filter((id) => id.startsWith('shot-')), ['shot-4', 'shot-5']);
  assert.throws(() => pruneScreenshots(conversation, { maxImages: 3, keep: 0 }), /at least one/);
  assert.throws(() => pruneScreenshots(conversation, { maxImages: 3, keep: 4 }), /no more than/);
});

function registryWithComputerModels(models: unknown, size?: { width: number; height: number }) {
  const { fields } = withDesktop(registryDocument as unknown as Record<string, unknown>, 'enable');
  const rows = (fields['sandboxProviders'] as Record<string, unknown>[]).map((row) => {
    if (row['platform'] !== 'web') return row;
    const desktop: Record<string, unknown> = { ...(row['desktop'] as Record<string, unknown>), ...(size ?? {}) };
    if (models === undefined) delete desktop['computerModels']; else desktop['computerModels'] = models;
    return { ...row, desktop };
  });
  return parseRegistry({ ...fields, sandboxProviders: rows }, 'registry').sandboxProviders.get('web')!;
}

test('the registry says which models may operate the screen, and refuses a list it cannot use', () => {
  assert.deepEqual(registryWithComputerModels(['claude-sonnet-5', 'claude-opus-5']).desktop?.computerModels, ['claude-sonnet-5', 'claude-opus-5']);
  assert.equal(registryWithComputerModels(undefined).desktop?.computerModels, undefined, 'absent means no computer');
  for (const bad of [[], 'claude-sonnet-5', [''], [' claude-sonnet-5'], ['a', 'a'], [5], null]) {
    assert.throws(() => registryWithComputerModels(bad), /computerModels/, JSON.stringify(bad));
  }
});

test('a screen larger than a screenshot can be cannot be given the computer tool', () => {
  assert.equal(registryWithComputerModels(['m'], { width: 1280, height: 800 }).desktop?.width, 1280);
  assert.equal(registryWithComputerModels(['m'], { width: 2560, height: 1440 }).desktop?.width, 2560);
  assert.throws(() => registryWithComputerModels(['m'], { width: 3840, height: 2160 }), /larger than a screenshot can be/);
  // Without the computer tool the same screen is fine: it is only the tool that cannot take it.
  assert.equal(registryWithComputerModels(undefined, { width: 3840, height: 2160 }).desktop?.width, 3840);
});
