import type {
  ComputerToolset20260801,
  ImageBlockParam,
  MessageParam,
} from '@anthropic-ai/sdk/resources/messages';

import type { CommandOutcome, RunningSandbox } from '../sandboxes/provider.ts';

/**
 * The computer tool: the agent looks at the sandbox's screen and drives it.
 *
 * The screen is the desktop the user is already watching, so this adds no new
 * surface to the user and none to the network. It gives the agent eyes and
 * hands on the same X display: a screenshot is taken with `scrot`, and input is
 * `xdotool`, which is also why the user's view can stay read-only — the agent's
 * input never goes through the VNC stream.
 *
 * Deliberately not a `ToolDefinition`. Those return text, and a screenshot is an
 * image; the toolset is also a single `tools[]` entry whose members arrive as
 * separate tool calls, so it is dispatched by the model loop on the toolset name
 * rather than looked up by tool name.
 */

/** The `toolset_name` the API puts on every member call and expects on every result. */
export const computerToolsetName = 'computer';

/**
 * `hold_key` is withheld: it holds a key for up to five minutes, which is a way
 * to wedge the one screen the agent has and is not needed to build software.
 */
export const computerToolset: ComputerToolset20260801 = {
  type: 'computer_toolset_20260801',
  configs: { hold_key: { enabled: false } },
};

export interface ComputerResult {
  readonly text: string;
  readonly isError: boolean;
  /** A PNG, for `screenshot` and `zoom`. Never persisted: it lives for the turn. */
  readonly image?: Buffer;
}

export interface Screen {
  readonly width: number;
  readonly height: number;
}

export interface Computer {
  readonly toolset: ComputerToolset20260801;
  /** Runs one member call. A failure comes back as an error result, like any tool. */
  run(member: string, input: unknown, signal: AbortSignal): Promise<ComputerResult>;
}

/** An input the model got wrong. Reported to it, so it can correct itself. */
class InvalidComputerInput extends Error {}

/** Where a capture is written and read back from. Serialized calls mean one file is enough. */
const screenshotPath = '/tmp/lotusbuild-screen.png';
/** The API accepts 5 MB an image. A screen that busy is refused rather than cut. */
const maxScreenshotBytes = 4 * 1024 * 1024;
const actionTimeoutMs = 20_000;
const maxTypedCharacters = 2000;
const maxWaitSeconds = 30;
const maxScrollAmount = 50;
const maxKeyRepeat = 100;
const maxKeysInOneCall = 10;

const buttons = { left_click: 1, middle_click: 2, right_click: 3 } as const;
const clickCounts = { double_click: 2, triple_click: 3 } as const;
const scrollButtons = { up: 4, down: 5, left: 6, right: 7 } as const;
const modifierNames = new Set(['shift', 'ctrl', 'alt', 'super']);

/** What `xdotool key` accepts, minus everything a shell could read as anything else. */
const keyName = /^[A-Za-z0-9_]+(\+[A-Za-z0-9_]+)*$/;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function delay(seconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, seconds * 1000);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function pngSize(png: Buffer): { readonly width: number; readonly height: number } {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.length < 24 || signature.some((byte, index) => png[index] !== byte)) {
    throw new Error('The screen capture is not a PNG image.');
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

export function createComputer(sandbox: RunningSandbox, screen: Screen): Computer {
  const readBytes = sandbox.readBytes?.bind(sandbox);
  if (readBytes === undefined) throw new Error('This sandbox cannot return screenshots.');

  const shell = (script: string, signal: AbortSignal, envs?: Readonly<Record<string, string>>, timeoutMs = actionTimeoutMs): Promise<CommandOutcome> =>
    sandbox.runCommand(script, { cwd: '/', timeoutMs, signal, ...(envs === undefined ? {} : { envs }) });

  /** A command that must exit 0. Its own words are what the model needs to hear when it does not. */
  const succeed = async (script: string, signal: AbortSignal, envs?: Readonly<Record<string, string>>, timeoutMs?: number): Promise<CommandOutcome> => {
    const outcome = await shell(script, signal, envs, timeoutMs);
    if (outcome.exitCode !== 0) {
      throw new Error((outcome.stderr || outcome.stdout || `exit code ${outcome.exitCode}`).trim().slice(0, 500));
    }
    return outcome;
  };

  const integer = (value: unknown, name: string, min: number, max: number): number => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      throw new InvalidComputerInput(`"${name}" must be a whole number from ${min} to ${max}.`);
    }
    return value;
  };

  const point = (value: unknown, name: string): { readonly x: number; readonly y: number } => {
    if (!Array.isArray(value) || value.length !== 2) {
      throw new InvalidComputerInput(`"${name}" must be [x, y], in screenshot pixels.`);
    }
    const [x, y] = value as unknown[];
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isInteger(x) || !Number.isInteger(y)
      || x < 0 || y < 0 || x >= screen.width || y >= screen.height) {
      throw new InvalidComputerInput(
        `"${name}" [${String(x)}, ${String(y)}] is not on the ${screen.width}x${screen.height} screen; ` +
        `x is 0 to ${screen.width - 1} and y is 0 to ${screen.height - 1}.`,
      );
    }
    return { x, y };
  };

  /** The modifier keys held during a click or scroll, as `xdotool` key names. */
  const modifiers = (value: unknown): readonly string[] => {
    if (value === undefined || value === null || value === '') return [];
    if (typeof value !== 'string') throw new InvalidComputerInput('"text" must be modifier keys such as "shift" or "ctrl+shift".');
    const names = value.toLowerCase().split('+');
    if (names.some((name) => !modifierNames.has(name)) || new Set(names).size !== names.length) {
      throw new InvalidComputerInput('"text" for a click may only combine shift, ctrl, alt and super, for example "ctrl+shift".');
    }
    return names;
  };

  /**
   * Wraps input with the modifiers held. If the input itself fails, the keys are
   * released before the failure is reported, so a failed click cannot leave shift
   * down on the one keyboard the agent has.
   */
  const withModifiers = (held: readonly string[], middle: string): string => {
    if (held.length === 0) return `xdotool ${middle}`;
    const down = held.map((name) => `keydown ${name}`).join(' ');
    const up = held.map((name) => `keyup ${name}`).join(' ');
    return `xdotool ${down} ${middle} ${up} || { xdotool ${up}; exit 1; }`;
  };

  // No `--sync`: it waits for the pointer to move, and when it is already at the
  // target nothing moves, so it blocks for 15 seconds. Requests to the X server are
  // handled in order, so the click follows the move; the pause is for hover effects.
  const moveTo = (at: { readonly x: number; readonly y: number } | undefined): string =>
    at === undefined ? '' : `mousemove ${at.x} ${at.y} sleep 0.05 `;

  const capture = async (signal: AbortSignal, region?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }): Promise<ComputerResult> => {
    const crop = region === undefined ? '' : `-a ${region.x},${region.y},${region.width},${region.height} `;
    // -p draws the pointer, so the model can see where its last move left it.
    await succeed(`rm -f ${screenshotPath} && scrot -p ${crop}-o ${screenshotPath}`, signal);
    const png = await readBytes(screenshotPath, maxScreenshotBytes);
    const size = pngSize(png);
    const expected = region ?? screen;
    if (size.width !== expected.width || size.height !== expected.height) {
      // A capture that is not the size clicks are measured in would send every
      // click to the wrong place, so it is refused rather than passed along.
      throw new Error(`The screen is ${size.width}x${size.height}, not the configured ${expected.width}x${expected.height}.`);
    }
    return { text: `Screenshot ${size.width}x${size.height}`, isError: false, image: png };
  };

  const dispatch = async (member: string, input: Record<string, unknown>, signal: AbortSignal): Promise<ComputerResult> => {
    const done = (text: string): ComputerResult => ({ text, isError: false });

    if (member === 'screenshot') return capture(signal);

    if (member === 'zoom') {
      const region = input['region'];
      if (!Array.isArray(region) || region.length !== 4) throw new InvalidComputerInput('"region" must be [x0, y0, x1, y1].');
      const [x0, y0, x1, y1] = region as unknown[];
      // The far corner is exclusive, so a region may end at the screen's own edge.
      const left = integer(x0, 'region x0', 0, screen.width - 1);
      const top = integer(y0, 'region y0', 0, screen.height - 1);
      const right = integer(x1, 'region x1', left + 1, screen.width);
      const bottom = integer(y1, 'region y1', top + 1, screen.height);
      return capture(signal, { x: left, y: top, width: right - left, height: bottom - top });
    }

    // Own properties only: `in` is also true of "toString" and "constructor", and a name the
    // model chose must never select something off the prototype.
    const isClick = Object.hasOwn(buttons, member) || Object.hasOwn(clickCounts, member);
    if (isClick) {
      const held = modifiers(input['text']);
      const at = input['coordinate'] === undefined ? undefined : point(input['coordinate'], 'coordinate');
      const button = Object.hasOwn(buttons, member) ? buttons[member as keyof typeof buttons] : 1;
      const times = Object.hasOwn(clickCounts, member) ? clickCounts[member as keyof typeof clickCounts] : 1;
      await succeed(withModifiers(held, `${moveTo(at)}click --repeat ${times} --delay 60 ${button}`), signal);
      return done(`${member} ${at === undefined ? 'at the pointer' : `at [${at.x}, ${at.y}]`}`);
    }

    switch (member) {
      case 'left_click_drag': {
        const held = modifiers(input['text']);
        const start = point(input['start_coordinate'], 'start_coordinate');
        const end = point(input['coordinate'], 'coordinate');
        await succeed(withModifiers(held,
          `mousemove ${start.x} ${start.y} sleep 0.05 mousedown 1 sleep 0.15 mousemove ${end.x} ${end.y} sleep 0.15 mouseup 1`), signal);
        return done(`dragged from [${start.x}, ${start.y}] to [${end.x}, ${end.y}]`);
      }
      case 'mouse_move': {
        const at = point(input['coordinate'], 'coordinate');
        await succeed(`xdotool mousemove ${at.x} ${at.y} sleep 0.05`, signal);
        return done(`moved the pointer to [${at.x}, ${at.y}]`);
      }
      case 'left_mouse_down':
        await succeed('xdotool mousedown 1', signal);
        return done('left button pressed');
      case 'left_mouse_up':
        await succeed('xdotool mouseup 1', signal);
        return done('left button released');
      case 'cursor_position': {
        const { stdout } = await succeed('xdotool getmouselocation --shell', signal);
        const x = /^X=(\d+)$/m.exec(stdout)?.[1];
        const y = /^Y=(\d+)$/m.exec(stdout)?.[1];
        if (x === undefined || y === undefined) throw new Error('The pointer position could not be read.');
        return done(`X=${x}, Y=${y}`);
      }
      case 'scroll': {
        const direction = input['scroll_direction'];
        if (typeof direction !== 'string' || !Object.hasOwn(scrollButtons, direction)) {
          throw new InvalidComputerInput('"scroll_direction" must be up, down, left or right.');
        }
        const amount = integer(input['scroll_amount'], 'scroll_amount', 1, maxScrollAmount);
        const held = modifiers(input['text']);
        const at = input['coordinate'] === undefined ? undefined : point(input['coordinate'], 'coordinate');
        await succeed(withModifiers(held,
          `${moveTo(at)}click --repeat ${amount} --delay 30 ${scrollButtons[direction as keyof typeof scrollButtons]}`), signal);
        return done(`scrolled ${direction} ${amount}`);
      }
      case 'type': {
        const text = input['text'];
        if (typeof text !== 'string' || text === '') throw new InvalidComputerInput('"text" must be the non-empty text to type.');
        if (text.length > maxTypedCharacters) {
          throw new InvalidComputerInput(
            `"text" is ${text.length} characters; type at most ${maxTypedCharacters} at a time. ` +
            'To put a lot of text in a file, use write_file instead of typing it.',
          );
        }
        if (text.includes('\0')) throw new InvalidComputerInput('"text" cannot contain a null character.');
        // The text is the model's, and often something a page or a file put in its
        // head. It travels as an environment variable so the shell never parses it.
        const outcome = await shell('xdotool type --delay 12 --clearmodifiers -- "$LOTUSBUILD_TYPED"', signal,
          { LOTUSBUILD_TYPED: text }, actionTimeoutMs + text.length * 40);
        if (outcome.exitCode !== 0 || outcome.stderr.trim() !== '') {
          throw new Error(`Typing failed: ${(outcome.stderr || outcome.stdout).trim().slice(0, 300)}`);
        }
        return done(`typed ${text.length} characters`);
      }
      case 'key': {
        const keys = input['text'];
        if (typeof keys !== 'string' || keys.trim() === '') throw new InvalidComputerInput('"text" must be a key or combination such as "Return" or "ctrl+s".');
        const names = keys.trim().split(/\s+/);
        if (names.length > maxKeysInOneCall || names.some((name) => !keyName.test(name))) {
          throw new InvalidComputerInput(
            `"text" must be up to ${maxKeysInOneCall} xdotool key names or combinations, separated by spaces, such as "ctrl+s" or "Return".`,
          );
        }
        const repeat = input['repeat'] === undefined ? 1 : integer(input['repeat'], 'repeat', 1, maxKeyRepeat);
        // Word-splitting the variable is the point, and globbing is off, so the
        // only thing the shell does with it is cut it at spaces.
        const outcome = await shell(
          `set -f; for _ in $(seq ${repeat}); do xdotool key --clearmodifiers --delay 40 -- $LOTUSBUILD_KEYS || exit 1; done`,
          signal, { LOTUSBUILD_KEYS: names.join(' ') }, actionTimeoutMs + repeat * 200);
        // xdotool reports an unknown key name on stderr and still exits 0.
        if (outcome.exitCode !== 0 || outcome.stderr.trim() !== '') {
          throw new Error(`Key press failed: ${(outcome.stderr || outcome.stdout).trim().slice(0, 300)}`);
        }
        return done(`pressed ${names.join(' ')}${repeat > 1 ? ` ${repeat} times` : ''}`);
      }
      case 'wait': {
        const wanted = input['duration'];
        if (typeof wanted !== 'number' || !Number.isFinite(wanted) || wanted <= 0) {
          throw new InvalidComputerInput('"duration" must be a number of seconds greater than 0.');
        }
        const seconds = Math.min(wanted, maxWaitSeconds);
        await delay(seconds, signal);
        return done(seconds < wanted ? `waited ${seconds} seconds, the longest a single wait can be` : `waited ${seconds} seconds`);
      }
      default:
        throw new InvalidComputerInput(`The computer action "${member}" is not available.`);
    }
  };

  return {
    toolset: computerToolset,
    async run(member, input, signal) {
      signal.throwIfAborted();
      try {
        return await dispatch(member, record(input), signal);
      } catch (error) {
        // A cancelled session stops here; it is not a failed click.
        signal.throwIfAborted();
        return { text: error instanceof Error ? error.message : String(error), isError: true };
      }
    },
  };
}

/** What the model is told a pruned screenshot was, so it knows to take another. */
export const prunedScreenshotText = '[An earlier screenshot was removed to save space. Take a new one if you need to see the screen.]';

/**
 * Keeps a long conversation within what the API accepts and affordable.
 *
 * Every screenshot the agent takes stays in the conversation it resends on each
 * step, so a long desktop session would grow without bound and hit the API's
 * image limit. Once more than `maxImages` are held, all but the newest `keep`
 * are replaced with text.
 *
 * Pruning in batches rather than one image per step is deliberate. Editing an
 * earlier message invalidates the prompt cache from that point on, so removing
 * one image every step would make every step a full-price read; removing many at
 * once pays that once per batch.
 *
 * Returns how many were removed.
 */
export function pruneScreenshots(conversation: MessageParam[], limits: { readonly maxImages: number; readonly keep: number }): number {
  if (limits.keep < 1 || limits.keep > limits.maxImages) throw new Error('Screenshot limits must keep at least one image and no more than the maximum.');
  const held: { readonly blocks: unknown[]; readonly index: number }[] = [];
  for (const message of conversation) {
    if (message.role !== 'user' || typeof message.content === 'string') continue;
    for (const block of message.content) {
      if (block.type !== 'tool_result' || block.toolset_name !== computerToolsetName || !Array.isArray(block.content)) continue;
      const blocks: unknown[] = block.content;
      blocks.forEach((inner, index) => {
        if (record(inner)['type'] === 'image') held.push({ blocks, index });
      });
    }
  }
  if (held.length <= limits.maxImages) return 0;
  const drop = held.slice(0, held.length - limits.keep);
  for (const { blocks, index } of drop) blocks[index] = { type: 'text', text: prunedScreenshotText };
  return drop.length;
}

export function screenshotBlock(png: Buffer): ImageBlockParam {
  return { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } };
}
