import { posix } from 'node:path';

import type { Tool } from '@anthropic-ai/sdk/resources/messages';

import type { SandboxProvider } from '../entitlements/schema.ts';
import type { CommandOutcome, RunningSandbox } from '../sandboxes/provider.ts';

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

export interface ToolDefinition {
  readonly spec: Tool;
  /**
   * Declared only on a tool proven safe to run concurrently with others that
   * declare it — today that is `consult_specialist` alone, because its
   * specialists hold read-only tool sets and touch no mutable workspace state.
   * Absence means serialized: a workspace-mutating, unknown or future tool is
   * never assumed parallel-safe.
   */
  readonly parallelSafe?: true;
  run(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

/**
 * Exactly what one agent invocation may call, by name.
 *
 * Capability is decided by which set an invocation is handed, not by a check
 * inside a tool. A specialist is never offered `write_file` and cannot reach it
 * by naming it, because dispatch resolves against this map alone — there is no
 * global registry to fall through to.
 */
export type ToolSet = ReadonlyMap<string, ToolDefinition>;

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
      name: 'list_files',
      description:
        'List the files tracked in the project, optionally under one directory. Use this to ' +
        'find your way around before reading anything.',
      input_schema: {
        type: 'object',
        required: [],
        properties: {
          path: {
            type: 'string',
            description: 'Directory relative to the project directory. Omit for the whole tree.',
          },
        },
      },
    },
    async run(input, context) {
      const requested = input['path'];
      if (requested !== undefined && typeof requested !== 'string') {
        throw new Error('"path" must be a string when given.');
      }
      const path = resolveInWorkdir(context.provider, requested ?? '.');
      // The command is fixed and the path travels as an environment variable, so
      // a directory name is never spliced into something a shell parses. This is
      // the read-only agents' only way to see the tree, and it must stay one.
      const outcome = await context.sandbox.runCommand(
        'set -eu\ncd "$LOTUSBUILD_LIST_PATH"\n' +
          'if git rev-parse --git-dir >/dev/null 2>&1; then git ls-files; else ls -1A; fi\n',
        {
          cwd: context.provider.workdir,
          timeoutMs: context.commandTimeoutMs,
          envs: { LOTUSBUILD_LIST_PATH: path },
        },
      );
      return describe(outcome);
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

function setOf(names: readonly string[]): ToolSet {
  return new Map(
    names.map((name) => {
      const definition = definitions.find((candidate) => candidate.spec.name === name);
      if (definition === undefined) {
        throw new Error(`No tool called "${name}" exists to grant.`);
      }
      return [name, definition];
    }),
  );
}

/** Everything the primary coding agent may do, including mutating the workspace. */
export const workspaceTools: ToolSet = setOf([
  'run_command',
  'write_file',
  'read_file',
  'list_files',
  'start_preview',
]);

/**
 * What a consulted specialist may do: look, and nothing else.
 *
 * `run_command` is deliberately absent. It is a write primitive — `sed -i`,
 * `npm install`, `git checkout` all go through it — so granting it to a
 * read-only role would make the role read-only in name only.
 */
export const readOnlyTools: ToolSet = setOf(['read_file', 'list_files']);

export function specsOf(tools: ToolSet): readonly Tool[] {
  return [...tools.values()].map((definition) => definition.spec);
}

/**
 * Runs one tool call against the caller's own tool set.
 *
 * A name the caller was not granted is refused here, whether or not some other
 * agent has a tool by that name — the refusal is the enforcement, and it says
 * nothing about what exists elsewhere. A granted tool that throws comes back as
 * an error result rather than ending the turn: the model is expected to read the
 * message and try something else, which is the point of giving it tools.
 */
export async function runTool(
  name: string,
  input: Record<string, unknown>,
  context: ToolContext,
  tools: ToolSet,
): Promise<ToolResult> {
  const definition = tools.get(name);
  if (definition === undefined) {
    return { text: `Tool "${name}" is not available to this agent.`, isError: true };
  }
  try {
    return await definition.run(input, context);
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), isError: true };
  }
}

/**
 * Captures the whole working tree — tracked changes, staged state, untracked
 * files and deletions — as one git tree object, without disturbing the tree.
 *
 * `git add -A` followed by `write-tree` records everything currently on disk;
 * the index is saved and put back around it, so the working tree and the
 * staged/unstaged distinction the primary agent set up are untouched. The tree
 * id it prints is the exact state validation must be returned to. The marker on
 * line one lets nothing but this tool be mistaken for it.
 */
export const validationCheckpointScript = [
  '# lotusbuild:validation-checkpoint',
  'set -eu',
  'had_index=0; [ -f .git/index ] && had_index=1',
  '[ "$had_index" = 1 ] && cp -p .git/index /tmp/lotusbuild-val-index',
  'git add -A',
  'tree=$(git write-tree)',
  'if [ "$had_index" = 1 ]; then cp -p /tmp/lotusbuild-val-index .git/index; else rm -f .git/index; fi',
  'printf "%s\\n" "$tree"',
].join('\n');

/**
 * Detects whether validation changed the tree, restores it to the checkpoint
 * exactly, and verifies the result — all against `LOTUSBUILD_CHECKPOINT_TREE`.
 *
 * Restoration is `read-tree` + `checkout-index -f` + `clean -fd`, never
 * `reset --hard`: it rewrites every checkpoint file over whatever validation
 * left, and removes only files validation created (checkpoint untracked files
 * are in the index after read-tree, so `clean` keeps them). `-x` is omitted, so
 * gitignored build artefacts are left alone rather than deleting node_modules.
 * Mutation and verification are computed the same way the checkpoint was — a
 * full `add -A` tree — so both compare like with like. It prints mutated,
 * verified, and the changed paths; the original index is restored around each
 * probe so the staged state survives.
 */
export const validationRestoreScript = [
  '# lotusbuild:validation-restore',
  'set -eu',
  'had_index=0; [ -f .git/index ] && had_index=1',
  '[ "$had_index" = 1 ] && cp -p .git/index /tmp/lotusbuild-val-index',
  'git add -A',
  'after=$(git write-tree)',
  'if [ "$after" = "$LOTUSBUILD_CHECKPOINT_TREE" ]; then mutated=0; changed=""; else',
  '  mutated=1',
  '  changed=$(git diff --name-status "$LOTUSBUILD_CHECKPOINT_TREE" "$after" | head -n 50 || true)',
  'fi',
  'git read-tree "$LOTUSBUILD_CHECKPOINT_TREE"',
  'git checkout-index -a -f',
  'git clean -fd -q',
  'if [ "$had_index" = 1 ]; then cp -p /tmp/lotusbuild-val-index .git/index; else rm -f .git/index; fi',
  'had_index2=0; [ -f .git/index ] && had_index2=1',
  '[ "$had_index2" = 1 ] && cp -p .git/index /tmp/lotusbuild-val-verify',
  'git add -A',
  'verify=$(git write-tree)',
  'if [ "$had_index2" = 1 ]; then cp -p /tmp/lotusbuild-val-verify .git/index; else rm -f .git/index; fi',
  'verified=0; [ "$verify" = "$LOTUSBUILD_CHECKPOINT_TREE" ] && verified=1',
  'printf "mutated=%s\\n" "$mutated"',
  'printf "verified=%s\\n" "$verified"',
  'printf "changed:\\n%s\\n" "$changed"',
].join('\n');

/** How much validation output the tool keeps before the outer step truncates. */
const validationOutputMaxChars = 4000;

interface RestoreReport {
  readonly mutated: boolean;
  readonly verified: boolean;
  readonly changed: readonly string[];
}

/** Reads the restore script's output. Missing either flag means it did not run. */
function parseRestoreReport(stdout: string): RestoreReport | undefined {
  let mutated: boolean | undefined;
  let verified: boolean | undefined;
  const changed: string[] = [];
  let inChanged = false;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('mutated=')) {
      mutated = line.slice('mutated='.length).trim() === '1';
    } else if (line.startsWith('verified=')) {
      verified = line.slice('verified='.length).trim() === '1';
    } else if (line === 'changed:') {
      inChanged = true;
    } else if (inChanged && line.trim() !== '') {
      changed.push(line.trim());
    }
  }
  if (mutated === undefined || verified === undefined) {
    return undefined;
  }
  return { mutated, verified, changed };
}

const runValidationSpec: Tool = {
  name: 'run_validation',
  description:
    "Run one of the project's trusted validation checks and get its result. You choose the " +
    'operation by name — typically "typecheck", "test" or "lint"; the platform decides the ' +
    'actual command, so you cannot pass one. The check runs the project\'s own code and the ' +
    'workspace is restored afterwards, so your run never changes the project. Returns the exit ' +
    'status and output. A non-zero exit is the check failing, which is evidence to act on, not a ' +
    'tool error.',
  input_schema: {
    type: 'object',
    required: ['operation'],
    properties: {
      operation: {
        type: 'string',
        description: 'The validation to run, e.g. "typecheck", "test" or "lint".',
      },
    },
  },
};

/**
 * Builds the `run_validation` tool for one consultation.
 *
 * The tool has no command field: it resolves the operation against the
 * platform's trusted profiles and runs nothing else, which is what keeps a
 * validation-capable specialist off arbitrary shell authority. Around the
 * profile command it checkpoints the workspace, restores it to that exact
 * state afterwards, and verifies the restore — so the authoritative tree the
 * primary agent is building is protected from anything validation touches.
 *
 * This restores the *workspace*; it does not make the project's code trusted,
 * and it is not a network boundary. The validation command runs real project
 * code in a sandbox that still has outbound network access, and can still cause
 * external side effects. What is guaranteed is that the project tree comes back
 * unchanged, or the tool fails loudly.
 *
 * The signal and lease check are captured here rather than read from the tool
 * context because they are per-consultation. Foreground sandbox commands cannot
 * be aborted mid-flight by the installed SDK — the signal only cancels the
 * request, not the remote process — so cancellation is enforced at the one
 * point it can be: no new validation command is started once the session is
 * stopping or the lease is gone.
 */
export function makeRunValidation(guard: {
  readonly signal: AbortSignal;
  readonly assertStillOurs: () => void;
}): ToolDefinition {
  return {
    spec: runValidationSpec,
    async run(input, context): Promise<ToolResult> {
      const operation = requireString(input, 'operation');
      const command = context.provider.validationProfiles.get(operation);
      if (command === undefined) {
        const known = [...context.provider.validationProfiles.keys()];
        return {
          text:
            `There is no validation profile "${operation}" for this project. ` +
            (known.length === 0
              ? 'No validation is configured for this platform.'
              : `Available: ${known.join(', ')}.`),
          isError: true,
        };
      }

      // Ownership first, then cancellation: a lease that is gone ends the turn,
      // and a session that is stopping starts no new validation command.
      guard.assertStillOurs();
      if (guard.signal.aborted) {
        return {
          text: 'Validation was not started because the session is stopping.',
          isError: true,
        };
      }

      const run = (
        script: string,
        envs?: Readonly<Record<string, string>>,
      ): Promise<CommandOutcome> =>
        context.sandbox.runCommand(script, {
          cwd: context.provider.workdir,
          timeoutMs: context.commandTimeoutMs,
          ...(envs === undefined ? {} : { envs }),
        });

      const checkpoint = await run(validationCheckpointScript);
      const checkpointTree = checkpoint.stdout.trim().split('\n').pop() ?? '';
      if (checkpoint.exitCode !== 0 || checkpointTree === '') {
        return {
          text:
            'Validation could not checkpoint the workspace and was not run, so nothing was ' +
            'changed.',
          isError: true,
        };
      }

      // The profile command runs with no environment of ours: backend
      // credentials are never propagated, and nothing from the runner process
      // is inherited. Only the sandbox's own default environment applies.
      const outcome = await run(command, {});

      const restore = await run(validationRestoreScript, {
        LOTUSBUILD_CHECKPOINT_TREE: checkpointTree,
      });
      const report = parseRestoreReport(restore.stdout);
      if (restore.exitCode !== 0 || report === undefined) {
        // Restoration did not complete. The authoritative tree may now hold
        // validation's changes, so this is a hard failure, not a warning.
        return {
          text:
            'Validation ran but the workspace could not be restored. The project may now contain ' +
            'changes made by the validation run and must be treated as unsafe until checked.',
          isError: true,
        };
      }
      if (!report.verified) {
        return {
          text:
            'Validation ran but restoration could not be verified: the workspace does not match ' +
            'its pre-validation state. Treat the project tree as unsafe.',
          isError: true,
        };
      }

      const passed = outcome.exitCode === 0;
      const lines = [
        `Validation "${operation}" ran.`,
        `Exit status: ${outcome.exitCode} (${passed ? 'passed' : 'failed'}).`,
      ];
      const out = truncate(outcome.stdout.trim(), validationOutputMaxChars);
      const err = truncate(outcome.stderr.trim(), validationOutputMaxChars);
      if (out !== '') {
        lines.push('stdout:', out);
      }
      if (err !== '') {
        lines.push('stderr:', err);
      }
      if (report.mutated) {
        lines.push(
          '',
          'Note: this validation modified the workspace. The changes were discarded and the ' +
            'pre-validation project state was restored.',
          ...(report.changed.length === 0
            ? []
            : [`Changed: ${report.changed.slice(0, 20).join('; ')}`]),
        );
      } else {
        lines.push('', 'The validation did not modify the workspace.');
      }
      // isError stays false: validation ran and the tree is safe. A failing
      // check is reported in the exit status above, for the specialist to judge.
      return { text: lines.join('\n'), isError: false };
    },
  };
}

/** Keeps one oversized result from crowding out the rest of the conversation. */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const dropped = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n… ${dropped} more characters not shown.`;
}
