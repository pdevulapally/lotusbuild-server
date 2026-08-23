import { posix } from 'node:path';

import type { Tool } from '@anthropic-ai/sdk/resources/messages';

import type { SandboxProvider } from '../entitlements/schema.ts';
import type { RunningSandbox } from '../sandboxes/provider.ts';

export interface ToolContext {
  readonly sandbox: RunningSandbox;
  readonly provider: SandboxProvider;
  readonly commandTimeoutMs: number;
  readonly previewReadyTimeoutSeconds: number;
  /** Told when a preview comes up, so the session can show it. */
  readonly onPreview: (preview: { readonly url: string; readonly port: number }) => Promise<void>;
}

export interface ToolResult {
  readonly text: string;
  readonly isError: boolean;
}

interface ToolDefinition {
  readonly spec: Tool;
  run(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

/**
 * Keeps a path inside the project.
 *
 * The sandbox is already a boundary, so this is not the only thing standing
 * between the model and the host — but a relative path that escapes the
 * workdir writes somewhere the next command will not find, and silently
 * building the wrong tree is worse than refusing.
 */
function resolveInWorkdir(provider: SandboxProvider, candidate: string): string {
  const workdir = posix.resolve(provider.workdir);
  const resolved = posix.resolve(workdir, candidate);
  if (resolved !== workdir && !resolved.startsWith(`${workdir}/`)) {
    throw new Error(`"${candidate}" resolves outside the project directory ${workdir}.`);
  }
  return resolved;
}

function requireString(input: Record<string, unknown>, name: string): string {
  const value = input[name];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`"${name}" must be a non-empty string.`);
  }
  return value;
}

function requirePort(input: Record<string, unknown>, name: string): number {
  const value = input[name];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`"${name}" must be a TCP port between 1 and 65535.`);
  }
  return value;
}

function describe(outcome: { exitCode: number; stdout: string; stderr: string }): ToolResult {
  const parts = [`exit code: ${outcome.exitCode}`];
  if (outcome.stdout !== '') {
    parts.push(`stdout:\n${outcome.stdout}`);
  }
  if (outcome.stderr !== '') {
    parts.push(`stderr:\n${outcome.stderr}`);
  }
  // A non-zero exit is reported as an error result rather than thrown, because
  // it is information the model must act on, not a failure of the tool call.
  return { text: parts.join('\n'), isError: outcome.exitCode !== 0 };
}

/**
 * What the agent can do inside a sandbox.
 *
 * Deliberately four. Everything else a build needs — listing, searching,
 * installing, testing — is a shell command, and a tool per verb would spend
 * context on descriptions the model already knows from the shell.
 */
const definitions: readonly ToolDefinition[] = [
  {
    spec: {
      name: 'run_command',
      description:
        'Run a shell command in the project directory and wait for it to finish. Returns the ' +
        'exit code with stdout and stderr. Use this for installing packages, building, testing, ' +
        'listing files and anything else a shell can do. Do not use it to start a long-running ' +
        'dev server — use start_preview for that.',
      input_schema: {
        type: 'object',
        required: ['command'],
        properties: {
          command: { type: 'string', description: 'The shell command to run.' },
        },
      },
    },
    async run(input, context) {
      return describe(
        await context.sandbox.runCommand(requireString(input, 'command'), {
          cwd: context.provider.workdir,
          timeoutMs: context.commandTimeoutMs,
        }),
      );
    },
  },
  {
    spec: {
      name: 'write_file',
      description:
        'Write a file, creating it and any parent directories if needed and overwriting it if ' +
        'it exists. Paths are relative to the project directory.',
      input_schema: {
        type: 'object',
        required: ['path', 'content'],
        properties: {
          path: { type: 'string', description: 'Path relative to the project directory.' },
          content: { type: 'string', description: 'The complete new contents of the file.' },
        },
      },
    },
    async run(input, context) {
      const path = resolveInWorkdir(context.provider, requireString(input, 'path'));
      const content = input['content'];
      if (typeof content !== 'string') {
        throw new Error('"content" must be a string.');
      }
      await context.sandbox.writeFile(path, content);
      return { text: `Wrote ${content.length} characters to ${path}.`, isError: false };
    },
  },
  {
    spec: {
      name: 'read_file',
      description:
        'Read a file from the project directory. Paths are relative to the project directory.',
      input_schema: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'Path relative to the project directory.' },
        },
      },
    },
    async run(input, context) {
      const path = resolveInWorkdir(context.provider, requireString(input, 'path'));
      return { text: await context.sandbox.readFile(path), isError: false };
    },
  },
  {
    spec: {
      name: 'start_preview',
      description:
        'Start the dev server in the background and wait until it answers on its port, then ' +
        'show the running app to the user. Returns the public URL. The server must listen on ' +
        'all interfaces, not just localhost, or it cannot be reached from outside the sandbox.',
      input_schema: {
        type: 'object',
        required: ['command', 'port'],
        properties: {
          command: { type: 'string', description: 'Command that starts the dev server.' },
          port: { type: 'number', description: 'Port the dev server listens on.' },
        },
      },
    },
    async run(input, context) {
      const command = requireString(input, 'command');
      const port = requirePort(input, 'port');

      await context.sandbox.runCommand(command, {
        cwd: context.provider.workdir,
        timeoutMs: context.commandTimeoutMs,
        background: true,
      });

      // Polled from inside the sandbox rather than from here: the port is only
      // published once something is listening, so probing from outside would be
      // asking a URL that does not exist yet.
      const deadline = context.previewReadyTimeoutSeconds;
      const probe = await context.sandbox.runCommand(
        `for attempt in $(seq 1 ${deadline}); do ` +
          `if curl -sf -o /dev/null "http://127.0.0.1:${port}/"; then exit 0; fi; sleep 1; done; ` +
          'exit 1',
        { cwd: context.provider.workdir, timeoutMs: (deadline + 5) * 1000 },
      );
      if (probe.exitCode !== 0) {
        return {
          text:
            `Nothing answered on port ${port} within ${deadline} seconds. Check that the server ` +
            'started and that it binds to 0.0.0.0 rather than localhost.',
          isError: true,
        };
      }

      const url = context.sandbox.previewUrl(port);
      await context.onPreview({ url, port });
      return { text: `The preview is live at ${url}`, isError: false };
    },
  },
];

export const toolSpecs: readonly Tool[] = definitions.map((definition) => definition.spec);

const byName = new Map(definitions.map((definition) => [definition.spec.name, definition]));

/**
 * Runs one tool call. A tool that throws comes back as an error result rather
 * than ending the turn: the model is expected to read the message and try
 * something else, which is the whole point of giving it tools.
 */
export async function runTool(
  name: string,
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  const definition = byName.get(name);
  if (definition === undefined) {
    return { text: `There is no tool called "${name}".`, isError: true };
  }
  try {
    return await definition.run(input, context);
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), isError: true };
  }
}

/** Keeps one oversized result from crowding out the rest of the conversation. */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const dropped = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n… ${dropped} more characters not shown.`;
}
