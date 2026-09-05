import { posix } from 'node:path';

import type { Tool } from '@anthropic-ai/sdk/resources/messages';

import type { SandboxProvider } from '../entitlements/schema.ts';
import type { CommandOutcome, RunningSandbox } from '../sandboxes/provider.ts';

export interface ToolContext {
  readonly publicPreviewEnabled?: boolean;
  readonly withValidationSandbox?: (run: (sandbox: RunningSandbox) => Promise<CommandOutcome>) => Promise<CommandOutcome>;
  readonly sandbox: RunningSandbox;
  readonly provider: SandboxProvider;
  readonly commandTimeoutMs: number;
  readonly previewReadyTimeoutSeconds: number;
  /**
   * How much of a tool result the outer loop keeps before it truncates the
   * rest. `read_file` sizes its ranged reads against this directly, so the
   * range it reports as delivered is always the range that actually reaches
   * the model — see `renderFileRange`.
   */
  readonly toolOutputMaxChars: number;
  /** Told when a preview comes up, so the session can show it. */
  readonly onPreview: (preview: { readonly url: string; readonly port: number }) => Promise<void>;
}

async function projectRead(context: ToolContext, path: string): Promise<string> {
  if (context.sandbox.projectFileOperation === undefined) return context.sandbox.readFile(path);
  const result = await context.sandbox.projectFileOperation(context.provider.workdir, { op: 'read', path }, context.commandTimeoutMs);
  if (result.exitCode !== 0) throw new Error('Confined file read failed: ' + result.stderr);
  return (JSON.parse(result.stdout) as { text: string }).text;
}
async function projectWrite(context: ToolContext, path: string, content: string): Promise<void> {
  if (context.sandbox.projectFileOperation === undefined) return context.sandbox.writeFile(path, content);
  const result = await context.sandbox.projectFileOperation(context.provider.workdir,
    { op: 'write', path, data: Buffer.from(content).toString('base64') }, context.commandTimeoutMs);
  if (result.exitCode !== 0) throw new Error('Confined file write failed: ' + result.stderr);
}
async function projectWindow(context: ToolContext, path: string, offset: number, limit: number): Promise<{ text: string; start: number; total: number }> {
  const result = await context.sandbox.projectFileOperation!(context.provider.workdir,
    { op: 'range', path, offset, limit: Math.min(limit, Math.max(1, Math.floor(context.toolOutputMaxChars / 6))) }, context.commandTimeoutMs);
  if (result.exitCode !== 0) throw new Error('Confined ranged read failed: ' + result.stderr);
  return JSON.parse(result.stdout) as { text: string; start: number; total: number };
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
  if (posix.relative(workdir, resolved).split('/').some((part) => part.toLowerCase() === '.git')) {
    throw new Error('Git internals are not accessible through project file tools.');
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

/** An omitted value returns `undefined`; a present one must be a valid offset. */
function optionalNonNegativeInteger(input: Record<string, unknown>, name: string): number | undefined {
  const value = input[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`"${name}" must be a non-negative integer when given.`);
  }
  return value;
}

/** An omitted value returns `undefined`; a present one must be a valid length. */
function optionalPositiveInteger(input: Record<string, unknown>, name: string): number | undefined {
  const value = input[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`"${name}" must be a positive integer when given.`);
  }
  return value;
}

/**
 * Renders one read result with the metadata the model needs to continue: the
 * exact range being returned, the file's total length, and whether more
 * remains. `end` is exclusive, so `end - start` is exactly how many units of
 * `content` follow.
 *
 * The unit is the UTF-16 code unit — what JavaScript's `string.length` and
 * `string.slice` count — not the Unicode code point and not a
 * human-perceived character. They agree for plain ASCII/BMP text, which is
 * most source code, but a character outside the Basic Multilingual Plane
 * (many emoji, some CJK extensions) is two code units, and this offset/limit
 * addresses those two individually. Calling that "characters" would be false,
 * so the wire format says what it actually is.
 */
function renderFileRange(
  path: string,
  start: number,
  end: number,
  total: number,
  content: string,
): string {
  const hasMore = end < total;
  return [
    `${path}: UTF-16 code units ${start}-${end} of ${total} (has_more: ${hasMore})`,
    '---',
    content,
  ].join('\n');
}

/**
 * Moves a candidate offset/end back by one position if it sits between the
 * two halves of a surrogate pair, so a range boundary this tool chooses never
 * slices a non-BMP character in two.
 *
 * Only a genuine pair triggers the move — a high surrogate immediately
 * followed by its low surrogate. A lone, already-malformed surrogate in the
 * source is left exactly where it is: this corrects boundaries this tool
 * introduces, not content it did not write.
 */
function snapBeforeSurrogatePair(content: string, position: number): number {
  if (position <= 0 || position >= content.length) {
    return position;
  }
  const before = content.charCodeAt(position - 1);
  const at = content.charCodeAt(position);
  const splitsAPair = before >= 0xd800 && before <= 0xdbff && at >= 0xdc00 && at <= 0xdfff;
  return splitsAPair ? position - 1 : position;
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

/** How many entries a page returns when the model does not specify `limit`. */
const defaultEntryPageSize = 200;

/**
 * Turns a full, already-ordered list of entries into one bounded page: the
 * `offset`/`limit` window, shrunk — by dropping whole trailing entries, never
 * by slicing into one — so the rendered result fits `toolOutputMaxChars`.
 *
 * This mirrors ranged `read_file`'s truthful-metadata contract (the range
 * reported is always the range actually delivered), adapted to whole entries
 * rather than character positions. Because a page only ever loses whole
 * entries, never part of one, nothing here can cut a result mid-character —
 * there is no surrogate-pair boundary to reuse `snapBeforeSurrogatePair` for,
 * unlike read_file's own character-offset slicing.
 *
 * `offset === total` is a legitimate empty final page (the caller reached the
 * end). `offset < total` but not even one entry fitting is not: that would
 * silently claim nothing was available when something was, so it fails
 * explicitly instead.
 */
function paginateEntries<T>(input: {
  readonly entries: readonly T[];
  readonly offset: number;
  readonly limit: number;
  readonly maxChars: number;
  /** Plural, used only in messages: "entries" or "matches". */
  readonly noun: string;
  readonly render: (page: readonly T[], start: number, end: number, total: number) => string;
}): ToolResult {
  const total = input.entries.length;
  if (input.offset > total) {
    return {
      text: `"offset" (${input.offset}) is beyond the end: there are ${total} ${input.noun}.`,
      isError: true,
    };
  }
  if (input.offset === total) {
    return { text: input.render([], input.offset, input.offset, total), isError: false };
  }

  let end = Math.min(input.offset + input.limit, total);
  let rendered = input.render(input.entries.slice(input.offset, end), input.offset, end, total);
  // Each iteration drops at least one entry and never more than are left, so
  // `end` strictly decreases and is bounded below by `offset + 1` — this
  // always terminates. The drop size is only an estimate (rendered size
  // divided across the page); a wrong estimate costs another iteration, never
  // correctness, since the loop re-renders and re-checks exactly every time.
  while (rendered.length > input.maxChars && end > input.offset + 1) {
    const overshoot = rendered.length - input.maxChars;
    const pageCount = end - input.offset;
    const perEntry = rendered.length / pageCount;
    const drop = Math.max(1, Math.min(pageCount - 1, Math.ceil(overshoot / perEntry)));
    end -= drop;
    rendered = input.render(input.entries.slice(input.offset, end), input.offset, end, total);
  }
  if (rendered.length > input.maxChars) {
    return {
      text:
        `Not even one of the ${total} available ${input.noun} fits in the tool output budget ` +
        'for this page.',
      isError: true,
    };
  }
  return { text: rendered, isError: false };
}

/**
 * Lists the files eligible for navigation and search in the CURRENT working
 * tree: tracked files plus untracked files not excluded by `.gitignore`, when
 * the current directory is inside a Git working tree — so a file `write_file`
 * or `edit_file` created earlier in this same turn is included immediately,
 * before it is ever staged or committed. Outside a Git working tree there is
 * no tracked/ignored distinction to make, so every regular file is eligible;
 * `git.persistence` is an entitlement, not a runtime guarantee, and
 * `ProjectPersistence.restore` only runs `git init` when it is granted, so a
 * plain (non-Git) working tree is a real, reachable state, not a defensive
 * assumption — `list_files` already branched on exactly this before this
 * change, for the same reason.
 *
 * A symlink is never eligible, in either branch: excluded once here, at the
 * one place both tools build their file set, rather than trusted to a lexical
 * path check that cannot see where a link actually points. `list_files` could
 * safely show a symlink's path alone, but this list also feeds
 * `search_files`, which reads content — so the exclusion lives where both
 * can rely on it.
 *
 * `LOTUSBUILD_PATHSPEC`, when set, restricts a Git working tree to that
 * pathspec. A pathspec has no equivalent outside Git, so a request for one
 * there is refused explicitly (`LOTUSBUILD_ERROR=glob-requires-git`) rather
 * than silently reinterpreted under different matching semantics.
 *
 * Everything is NUL-separated, including through the intermediate file: a
 * shell variable cannot hold a NUL byte, so nothing here ever assigns this
 * output to one — `git ls-files`/`find`'s own output is written straight to a
 * file and read back from it, never captured with `$(...)`.
 */
const eligibleFilesFunction = [
  'lotusbuild_eligible_files() {',
  '  is_git=0',
  '  git -c core.fsmonitor=false -c core.hooksPath=/dev/null rev-parse --git-dir >/dev/null 2>&1 && is_git=1',
  '  if [ "$is_git" = 0 ] && [ -n "${LOTUSBUILD_PATHSPEC:-}" ]; then',
  '    echo LOTUSBUILD_ERROR=glob-requires-git',
  '    return 1',
  '  fi',
  '  raw=$(mktemp)',
  '  if [ "$is_git" = 1 ]; then',
  '    if [ -n "${LOTUSBUILD_PATHSPEC:-}" ]; then',
  '      git -c core.fsmonitor=false -c core.hooksPath=/dev/null ls-files -z --cached --others --exclude-standard -- "$LOTUSBUILD_PATHSPEC" > "$raw"',
  '    else',
  '      git -c core.fsmonitor=false -c core.hooksPath=/dev/null ls-files -z --cached --others --exclude-standard > "$raw"',
  '    fi',
  '  else',
  '    find . -mindepth 1 -not -path "./.git" -not -path "./.git/*" -type f -print0 > "$raw"',
  '  fi',
  '  status=$?',
  '  if [ "$status" != 0 ]; then',
  '    rm -f "$raw"',
  '    echo "LOTUSBUILD_ERROR=file-listing-failed exit=$status"',
  '    return 1',
  '  fi',
  '  while IFS= read -r -d \'\' entry; do',
  '    path=${entry#./}',
  '    if [ ! -L "$path" ] && [ -f "$path" ]; then',
  "      printf '%s\\0' \"$path\"",
  '    fi',
  '  done < "$raw" | sort -z',
  '  rm -f "$raw"',
  '}',
].join('\n');

/**
 * Lists the eligible files, bounded and reported: `$LOTUSBUILD_SCOPE_PATH` is
 * `cd`'d into first, exactly like the original `list_files`, so both a
 * directory scope and Git's own cwd-relative path reporting fall out of one
 * mechanism rather than two. A unique temp file (`mktemp`, not a fixed name)
 * holds the listing before it is streamed back, because this tool is
 * parallel-safe and a fixed path would race a concurrent call to itself.
 *
 * `LC_ALL=C` makes `sort` order strictly by byte value, independent of
 * whatever locale the sandbox happens to be configured with — the same
 * ordering everywhere, rather than one that could vary by deployment.
 */
const listFilesScript = [
  'set -eu',
  'export LC_ALL=C',
  'cd "$LOTUSBUILD_SCOPE_PATH"',
  eligibleFilesFunction,
  'tmpfile=$(mktemp)',
  'if ! lotusbuild_eligible_files > "$tmpfile"; then',
  '  cat "$tmpfile"',
  '  rm -f "$tmpfile"',
  '  exit 1',
  'fi',
  'cat "$tmpfile"',
  'rm -f "$tmpfile"',
].join('\n');

/** How many files one grep invocation searches — comfortably under any realistic ARG_MAX. */
const searchBatchSize = 200;

/**
 * Searches one batch of files for literal text. `$@` is the batch.
 *
 * `grep --null -H -n -F -I`: `-F` is fixed-string matching, never a regex;
 * `-H`/`-n` guarantee the filename and line number are always present, even
 * for one file; `--null` puts a NUL (not `:`) right after the filename, so a
 * match parses back into (path, line, content) unambiguously even when a
 * path or a matched line itself contains a colon. `-I` makes a binary file
 * behave as though it were searched and had no matching data — no output
 * line for it at all, confirmed empirically — which is deterministic and
 * needs no parsing of a human-readable diagnostic, unlike grep's default
 * "Binary file ... matches" text.
 *
 * grep's own exit convention is used directly, never translated: 0 means it
 * matched something in this batch, 1 means it searched successfully and
 * matched nothing, and anything else is the search itself failing (a file
 * that could not be opened, for instance). This turns that into a plain
 * success/failure return — 0 or 1 is fine, anything else is not — which is
 * what the caller uses to decide whether the whole search may be trusted.
 */
const searchBatchFunction = [
  'lotusbuild_search_batch() {',
  '  if [ "$#" -eq 0 ]; then',
  '    return 0',
  '  fi',
  '  status=0',
  '  grep --null -H -n -F -I -- "$LOTUSBUILD_QUERY" "$@" || status=$?',
  '  [ "$status" -le 1 ]',
  '}',
].join('\n');

/**
 * Searches every file named in the NUL-delimited list at path `$1`, in
 * batches of `searchBatchSize` so no single grep invocation risks the
 * platform's ARG_MAX regardless of how many files are eligible.
 *
 * Deliberately not `xargs`: GNU xargs remaps any exit status 1-125 from the
 * command it runs to 123 (confirmed empirically), which destroys exactly the
 * "no match" (1) versus "search failed" (>1) distinction grep otherwise
 * gives for free. A plain loop building explicit argument batches keeps
 * grep's real exit code reachable, at the cost of writing the batching by
 * hand — the smaller, more deterministic mechanism the failure demanded.
 *
 * Returns immediately, without starting another batch, the moment one fails
 * — there is no reason to keep searching once the answer is already "this
 * failed". A batch that both matched something and then hit a failure later
 * in the same grep call (one call can do both, across its files) still fails
 * the whole search: the caller only trusts this function's stdout when it
 * returns success, so a failed batch's partial stdout is simply never read.
 */
const searchOverFilesFunction = [
  'lotusbuild_search_over_files() {',
  // $1 is this function's own argument (the file-list path) and must be
  // saved before "set --" below, which — clearing positional parameters to
  // start accumulating a batch in them — would otherwise wipe it out first.
  '  files_list=$1',
  '  set --',
  '  batch_count=0',
  '  while IFS= read -r -d "" entry; do',
  '    set -- "$@" "$entry"',
  '    batch_count=$((batch_count + 1))',
  `    if [ "$batch_count" -ge ${searchBatchSize} ]; then`,
  '      lotusbuild_search_batch "$@" || return 1',
  '      set --',
  '      batch_count=0',
  '    fi',
  '  done < "$files_list"',
  '  lotusbuild_search_batch "$@"',
  '}',
].join('\n');

/**
 * Runs `lotusbuild_search_over_files` against a file list given as `$1`,
 * standalone — exported so the failure-propagation behaviour above can be
 * proven directly against a hand-built file list, independent of how (or
 * whether) `search_files` itself would ever produce one that fails. `$1`
 * arrives as a script argument, not an env var: `bash -c script _ path`.
 */
export const searchOverFilesScript = [
  'set -eu',
  'export LC_ALL=C',
  searchBatchFunction,
  searchOverFilesFunction,
  'lotusbuild_search_over_files "$1"',
].join('\n');

/**
 * Searches the eligible file set for literal text.
 *
 * Two markers on stdout are what let the caller distinguish three outcomes
 * without guessing from an exit code: `LOTUSBUILD_ERROR=...` (from
 * `lotusbuild_eligible_files`, e.g. glob requested outside Git) means the
 * listing itself never got to run a search; `LOTUSBUILD_SEARCH_FAILED` means
 * listing succeeded but the search itself did not — `search_over_files`
 * above returned failure — and the diagnostic that follows is grep's own
 * stderr; `LOTUSBUILD_MATCHES_START` means the search genuinely completed,
 * and everything after it is real output, possibly empty. Zero matches and
 * zero eligible files both take the success path with nothing captured —
 * neither is a failure.
 */
const searchFilesScript = [
  'set -eu',
  // Confirmed empirically: under a UTF-8 locale, `grep -F` can fail to match
  // a literal multi-byte sequence — including plain ASCII characters that
  // are byte-identical between query and file — that it matches correctly
  // under `C`. Forcing `LC_ALL=C` makes the match purely byte-for-byte,
  // which is what "exact, literal text" is supposed to mean here regardless
  // of the sandbox's own locale configuration.
  'export LC_ALL=C',
  'cd "$LOTUSBUILD_SCOPE_PATH"',
  eligibleFilesFunction,
  searchBatchFunction,
  searchOverFilesFunction,
  'tmpfile=$(mktemp)',
  'if ! lotusbuild_eligible_files > "$tmpfile"; then',
  '  cat "$tmpfile"',
  '  rm -f "$tmpfile"',
  '  exit 1',
  'fi',
  'if [ ! -s "$tmpfile" ]; then',
  '  echo LOTUSBUILD_MATCHES_START',
  '  rm -f "$tmpfile"',
  '  exit 0',
  'fi',
  'if lotusbuild_search_over_files "$tmpfile" > "$tmpfile.out" 2> "$tmpfile.err"; then',
  '  echo LOTUSBUILD_MATCHES_START',
  '  cat "$tmpfile.out"',
  '  rm -f "$tmpfile" "$tmpfile.out" "$tmpfile.err"',
  'else',
  '  echo LOTUSBUILD_SEARCH_FAILED',
  '  cat "$tmpfile.err"',
  '  rm -f "$tmpfile" "$tmpfile.out" "$tmpfile.err"',
  '  exit 1',
  'fi',
].join('\n');

interface SearchMatch {
  readonly path: string;
  readonly line: number;
  readonly content: string;
}

/** Read the NUL-terminated filename before parsing a matching line: filenames can contain newlines. */
function parseSearchMatches(raw: string): SearchMatch[] {
  const matches: SearchMatch[] = [];
  let offset = 0;
  while (offset < raw.length) {
    const nul = raw.indexOf('\u0000', offset);
    const end = nul < 0 ? -1 : raw.indexOf('\n', nul + 1);
    const colon = nul < 0 ? -1 : raw.indexOf(':', nul + 1);
    if (nul <= offset || end < 0 || colon < nul || colon > end) {
      throw new Error('Search returned malformed or incomplete match data.');
    }
    const number = raw.slice(nul + 1, colon);
    const line = Number(number);
    if (!/^[1-9]\d*$/.test(number) || !Number.isSafeInteger(line)) {
      throw new Error('Search returned an invalid line number.');
    }
    matches.push({ path: raw.slice(offset, nul), line, content: raw.slice(colon + 1, end) });
    offset = end + 1;
  }
  return matches;
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
      await projectWrite(context, path, content);
      return { text: `Wrote ${content.length} characters to ${path}.`, isError: false };
    },
  },
  {
    spec: {
      name: 'edit_file',
      description:
        'Replace one exact occurrence of text in an existing file. "old_string" must match the ' +
        "current file's content exactly, character for character, and occur exactly once — the " +
        'call fails if it occurs zero times or more than once, and never guesses which occurrence ' +
        'you meant or repairs whitespace to make it match. If it fails, read the file again and ' +
        'give a longer, more specific old_string (more surrounding lines) rather than retrying the ' +
        'same input. "new_string" may be empty to delete old_string. Prefer this over write_file ' +
        'for changes to part of an existing file: it costs far less than resending the whole file ' +
        'and cannot disturb content you did not intend to touch.',
      input_schema: {
        type: 'object',
        required: ['path', 'old_string', 'new_string'],
        properties: {
          path: { type: 'string', description: 'Path relative to the project directory.' },
          old_string: {
            type: 'string',
            description: 'Exact text to replace. Must occur exactly once in the current file.',
          },
          new_string: {
            type: 'string',
            description: 'Replacement text. An empty string deletes old_string.',
          },
        },
      },
    },
    async run(input, context) {
      const path = resolveInWorkdir(context.provider, requireString(input, 'path'));
      const oldString = requireString(input, 'old_string');
      const newStringRaw = input['new_string'];
      if (typeof newStringRaw !== 'string') {
        throw new Error('"new_string" must be a string.');
      }
      const newString = newStringRaw;

      // Read fresh at execution time rather than trusting anything the model
      // saw earlier: if the file changed since its last read, old_string is
      // matched against what the file actually contains now. A match that no
      // longer holds fails exactly like a match that never held — there is no
      // separate staleness check to write, because there is nothing cached to
      // go stale.
      const content = await projectRead(context, path);
      // Every starting position old_string could match, not just a
      // non-overlapping tiling of them: "aaa" in "aaaa" matches at both index
      // 0 and index 1, and replacing one or the other produces a different
      // file, so both count toward ambiguity. Advancing the search by one
      // position after each hit (rather than by old_string's length) is what
      // finds the overlapping candidate as well as the tiled one.
      const matches: number[] = [];
      for (let from = 0; ; from += 1) {
        const at = content.indexOf(oldString, from);
        if (at === -1) {
          break;
        }
        matches.push(at);
        from = at;
      }

      if (matches.length === 0) {
        return { text: `edit_file failed:\nold_string was not found in ${path}`, isError: true };
      }
      if (matches.length > 1) {
        return {
          text:
            `edit_file failed:\nold_string matched ${matches.length} locations in ${path}. ` +
            'Provide a more specific old_string.',
          isError: true,
        };
      }

      const [at] = matches;
      if (at === undefined) {
        // Unreachable: matches.length === 1 was just checked.
        throw new Error('edit_file: the single match could not be read back.');
      }
      const startLine = content.slice(0, at).split('\n').length;
      const endLine = startLine + oldString.split('\n').length - 1;
      const updated = content.slice(0, at) + newString + content.slice(at + oldString.length);
      await projectWrite(context, path, updated);

      const where = endLine === startLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
      return { text: `Replaced 1 occurrence in ${path} (${where}).`, isError: false };
    },
  },
  {
    spec: {
      name: 'read_file',
      description:
        'Read a file from the project directory. Paths are relative to the project directory. ' +
        'The result reports the range actually returned (start, end, total, has_more), in UTF-16 ' +
        'code units — JavaScript string length units, where plain ASCII text is one per character ' +
        'but an emoji or other character outside the Basic Multilingual Plane is two — so you can ' +
        'page through a file larger than one read: pass the previous result\'s "end" as the next ' +
        '"offset" and repeat until has_more is false. Omit "offset" to start at the beginning; ' +
        'omit "limit" to use the standard read window. There is no separate maximum on "limit" — ' +
        'the amount actually returned is always capped to what one tool result can carry, and the ' +
        'reported range always matches what you actually received. A boundary is never placed in ' +
        'the middle of a two-unit character: if that would happen, the actual range is shifted by ' +
        'one unit and reported as it truly is.',
      input_schema: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'Path relative to the project directory.' },
          offset: {
            type: 'number',
            description: 'UTF-16 code unit offset to start reading from. Omit to start at 0.',
          },
          limit: {
            type: 'number',
            description:
              'Maximum UTF-16 code units to read from offset. Omit to use the standard window.',
          },
        },
      },
    },
    async run(input, context) {
      const path = resolveInWorkdir(context.provider, requireString(input, 'path'));
      const requestedOffset = optionalNonNegativeInteger(input, 'offset') ?? 0;
      // The standard window is the tool-output budget itself: a deliberate
      // default derived from AGENT_TOOL_OUTPUT_MAX_CHARS, not an arbitrary
      // constant of its own, and it is what the shrink loop below would end up
      // enforcing regardless of what was asked for.
      const limit = optionalPositiveInteger(input, 'limit') ?? context.toolOutputMaxChars;

      const window = context.sandbox.projectFileOperation !== undefined
        ? await projectWindow(context, path, requestedOffset, limit)
        : context.sandbox.readFileRange === undefined
        ? { text: await projectRead(context, path), start: 0 }
        : await context.sandbox.readFileRange(path, requestedOffset, Math.min(limit, context.toolOutputMaxChars), context.commandTimeoutMs);
      const content = window.text;
      const start = window.start;
      const total = 'total' in window ? window.total : content.length;
      if (requestedOffset > total) {
        return {
          text:
            `"offset" (${requestedOffset}) is beyond the end of ${path}, which has ${total} ` +
            `UTF-16 code units. The largest valid offset is ${total}.`,
          isError: true,
        };
      }
      // An explicit offset the model chose, rather than one this tool handed
      // back from a previous read, could land inside a surrogate pair; a
      // previous `end` never does, because every `end` below is snapped the
      // same way before it is returned.
      const offset = start + snapBeforeSurrogatePair(content, requestedOffset - start);

      let end = start + snapBeforeSurrogatePair(content, Math.min(offset + limit, total, start + content.length - ('total' in window && start + content.length < total ? 1 : 0)) - start);
      let rendered = renderFileRange(path, offset, end, total, content.slice(offset - start, end - start));
      // The generic tool-output truncation in the outer loop would otherwise
      // cut this reply after it has already claimed a larger range as
      // delivered. Shrinking the range here, before returning, is what keeps
      // "end" truthful: whatever this says was returned is what the model
      // actually receives, never more. Each iteration reduces `end` by at
      // least the current overshoot before the surrogate snap (which only
      // ever moves it one further back), so this always terminates.
      while (rendered.length > context.toolOutputMaxChars && end > offset) {
        const overshoot = rendered.length - context.toolOutputMaxChars;
        end = start + snapBeforeSurrogatePair(content, Math.max(offset, end - overshoot) - start);
        rendered = renderFileRange(path, offset, end, total, content.slice(offset - start, end - start));
      }
      if (rendered.length > context.toolOutputMaxChars) {
        // Only reachable if even an empty range plus this path's own name
        // cannot fit the configured budget — a configuration problem, not a
        // normal read, so it is reported rather than silently returned oversize.
        return {
          text: `${path} could not be read: even an empty range does not fit in the tool output budget.`,
          isError: true,
        };
      }
      return { text: rendered, isError: false };
    },
  },
  {
    // Read-only and side-effect-free: it only ever inspects the sandbox's
    // current files, so it is safe to run concurrently with itself and with
    // any other read-only tool.
    parallelSafe: true,
    spec: {
      name: 'list_files',
      description:
        'List the files eligible for navigation under the project directory, or one directory ' +
        'within it: every Git-tracked file plus every untracked file not excluded by ' +
        '.gitignore, when the project is a Git working tree — including a file you just wrote ' +
        'or edited earlier in this turn, before it is ever staged. Outside a Git working tree, ' +
        'every regular file is listed, since there is no tracked/ignored distinction to make. ' +
        'Symlinks and .git internals are never listed. Results are ordered by path and ' +
        'paginated: the response reports the range actually returned (start, end, total, ' +
        'has_more) — pass the previous result\'s "end" as the next "offset" to continue.',
      input_schema: {
        type: 'object',
        required: [],
        properties: {
          path: {
            type: 'string',
            description: 'Directory relative to the project directory to scope to. Omit for the whole project.',
          },
          glob: {
            type: 'string',
            description:
              'Restrict results to a Git pathspec (e.g. "*.ts", "src/**/*.tsx"). Only accepted ' +
              'when the project is a Git working tree.',
          },
          offset: {
            type: 'number',
            description: 'Entry offset to start listing from. Omit to start at 0.',
          },
          limit: {
            type: 'number',
            description: 'Maximum entries to return. Omit to use the standard page size.',
          },
        },
      },
    },
    async run(input, context) {
      const requestedPath = input['path'];
      if (requestedPath !== undefined && typeof requestedPath !== 'string') {
        throw new Error('"path" must be a string when given.');
      }
      const scopePath = resolveInWorkdir(context.provider, requestedPath ?? '.');

      const rawGlob = input['glob'];
      if (rawGlob !== undefined && (typeof rawGlob !== 'string' || rawGlob === '')) {
        throw new Error('"glob" must be a non-empty string when given.');
      }

      const offset = optionalNonNegativeInteger(input, 'offset') ?? 0;
      const limit = optionalPositiveInteger(input, 'limit') ?? defaultEntryPageSize;

      const outcome = context.sandbox.projectFileOperation !== undefined
        ? await context.sandbox.projectFileOperation(context.provider.workdir, { op: 'list', path: scopePath, glob: rawGlob ?? '' }, context.commandTimeoutMs)
        : await context.sandbox.runCommand(listFilesScript, {
        cwd: context.provider.workdir,
        timeoutMs: context.commandTimeoutMs,
        envs: { LOTUSBUILD_SCOPE_PATH: scopePath, LOTUSBUILD_PATHSPEC: rawGlob ?? '' },
      });

      if (outcome.exitCode !== 0) {
        if (outcome.stdout.includes('LOTUSBUILD_ERROR=glob-requires-git')) {
          return {
            text: '"glob" requires the project to be a Git working tree, which it is not right now.',
            isError: true,
          };
        }
        return describe(outcome);
      }

      const entries = outcome.stdout.split('\u0000').filter((entry) => entry !== '');
      return paginateEntries({
        entries,
        offset,
        limit,
        maxChars: context.toolOutputMaxChars,
        noun: 'entries',
        render: (page, start, end, total) => {
          const hasMore = end < total;
          return [
            `${scopePath}: entries ${start}-${end} of ${total} (has_more: ${hasMore})`,
            '---',
            ...page,
          ].join('\n');
        },
      });
    },
  },
  {
    parallelSafe: true,
    spec: {
      name: 'search_files',
      description:
        'Search file contents for exact, literal text — not a regular expression — across every ' +
        'file list_files would list: Git-tracked files, plus untracked non-ignored files when ' +
        'the project is a Git working tree, or every regular file otherwise. Case-sensitive, ' +
        'single-line: "query" must not contain a line break, since a literal search cannot ' +
        'truthfully represent one — search once per line instead. Binary files and symlinks are ' +
        'skipped, never their content. Each result is one matching line: file path, 1-based line ' +
        'number, and the line\'s content, exactly as it currently stands in the working tree — ' +
        'including an unstaged edit to a tracked file. A search that ran successfully and found ' +
        'nothing reports zero matches; if the search itself could not be completed, the call ' +
        'fails explicitly instead — zero matches is never used to mean "the search did not run". ' +
        'Results are ordered by file path, then by line, and paginated by match: the response ' +
        'reports the range actually returned (start, end, total, has_more) — pass the previous ' +
        'result\'s "end" as the next "offset" to continue. Use ranged read_file afterward to see ' +
        'more context around a match.',
      input_schema: {
        type: 'object',
        required: ['query'],
        properties: {
          query: {
            type: 'string',
            description:
              'Exact, literal text to search for, on a single line — no \\n, \\r, or NUL.',
          },
          path: {
            type: 'string',
            description: 'Directory relative to the project directory to scope to. Omit for the whole project.',
          },
          glob: {
            type: 'string',
            description:
              'Restrict the search to a Git pathspec (e.g. "*.ts"). Only accepted when the ' +
              'project is a Git working tree.',
          },
          offset: {
            type: 'number',
            description: 'Match offset to start returning results from. Omit to start at 0.',
          },
          limit: {
            type: 'number',
            description: 'Maximum matches to return. Omit to use the standard page size.',
          },
        },
      },
    },
    async run(input, context) {
      const query = requireString(input, 'query');
      // A pattern spanning more than one line is not "exact, literal text"
      // for a line-oriented search: grep treats each line of a multi-line
      // -F pattern as a separate alternative to match against (confirmed
      // empirically), so "foo\nbar" would silently become "lines containing
      // foo OR bar" rather than the two-line sequence it looks like. Refused
      // rather than reinterpreted.
      if (query.includes('\n') || query.includes('\r')) {
        throw new Error(
          '"query" must be a single line. Line breaks are not supported: search once per line, ' +
            'or use ranged read_file to inspect the surrounding text directly.',
        );
      }
      // Environment variable values cannot contain a NUL byte at the OS
      // level — Node's own child-process layer refuses one outright
      // (confirmed empirically) — so this is refused here, explicitly and
      // with a clear reason, rather than left to fail unpredictably however
      // the sandbox's own transport happens to handle it.
      if (query.includes('\u0000')) {
        throw new Error('"query" must not contain a NUL character.');
      }

      const requestedPath = input['path'];
      if (requestedPath !== undefined && typeof requestedPath !== 'string') {
        throw new Error('"path" must be a string when given.');
      }
      const scopePath = resolveInWorkdir(context.provider, requestedPath ?? '.');

      const rawGlob = input['glob'];
      if (rawGlob !== undefined && (typeof rawGlob !== 'string' || rawGlob === '')) {
        throw new Error('"glob" must be a non-empty string when given.');
      }

      const offset = optionalNonNegativeInteger(input, 'offset') ?? 0;
      const limit = optionalPositiveInteger(input, 'limit') ?? defaultEntryPageSize;

      const outcome = context.sandbox.projectFileOperation !== undefined
        ? await context.sandbox.projectFileOperation(context.provider.workdir, { op: 'search', path: scopePath, glob: rawGlob ?? '', query }, context.commandTimeoutMs)
        : await context.sandbox.runCommand(searchFilesScript, {
        cwd: context.provider.workdir,
        timeoutMs: context.commandTimeoutMs,
        envs: {
          LOTUSBUILD_SCOPE_PATH: scopePath,
          LOTUSBUILD_PATHSPEC: rawGlob ?? '',
          LOTUSBUILD_QUERY: query,
        },
      });

      if (outcome.exitCode !== 0 && outcome.stdout.startsWith('LOTUSBUILD_ERROR=glob-requires-git\n')) {
        return {
          text: '"glob" requires the project to be a Git working tree, which it is not right now.',
          isError: true,
        };
      }

      const failedMarker = 'LOTUSBUILD_SEARCH_FAILED\n';
      if (outcome.exitCode !== 0 && outcome.stdout.startsWith(failedMarker)) {
        // Listing succeeded, but the search over those files did not — never
        // reported as zero matches, which would tell the model source text
        // is absent when the truth is that it was never actually searched.
        const diagnostic = outcome.stdout.slice(failedMarker.length).trim();
        return {
          text:
            'search_files could not complete: the search itself failed partway through, so its ' +
            `result cannot be trusted as "no matches".\n${diagnostic === '' ? outcome.stderr : diagnostic}`,
          isError: true,
        };
      }

      const marker = 'LOTUSBUILD_MATCHES_START\n';
      if (outcome.exitCode !== 0) {
        return describe(outcome);
      }
      if (!outcome.stdout.startsWith(marker)) {
        throw new Error('Search returned no valid completion header.');
      }
      const matches = parseSearchMatches(outcome.stdout.slice(marker.length));

      return paginateEntries({
        entries: matches,
        offset,
        limit,
        maxChars: context.toolOutputMaxChars,
        noun: 'matches',
        render: (page, start, end, total) => {
          const hasMore = end < total;
          const lines = page.map((match) => `${match.path}:${match.line}: ${match.content}`);
          return [
            `"${query}": matches ${start}-${end} of ${total} (has_more: ${hasMore})`,
            '---',
            ...lines,
          ].join('\n');
        },
      });
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
      if (context.publicPreviewEnabled !== true) return { isError: true,
        text: 'Public previews are disabled for this project. Only the project owner can enable them outside this build. Do not expose another public port or tunnel.' };

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
  'edit_file',
  'read_file',
  'list_files',
  'search_files',
  'start_preview',
]);

/**
 * What a consulted specialist may do: look, and nothing else.
 *
 * `run_command` is deliberately absent. It is a write primitive — `sed -i`,
 * `npm install`, `git checkout` all go through it — so granting it to a
 * read-only role would make the role read-only in name only.
 */
export const readOnlyTools: ToolSet = setOf(['read_file', 'list_files', 'search_files']);

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

// The whole point of a throwaway index is that `git add -A` never touches the
// authoritative `.git/index`. `GIT_INDEX_FILE` seeds it from a copy of the real
// index so staged state is the base, then adds everything on disk on top — the
// result is a tree of the complete working state, computed without disturbing
// anything. The same recipe serves the checkpoint, the mutation probe, and
// verification; it is a shell function so the fixed temp path lives in one
// place.
const workingTreeProbe = [
  'lotusbuild_working_tree() {',
  '  rm -f /tmp/lotusbuild-val-probe',
  '  [ -f .git/index ] && cp -p .git/index /tmp/lotusbuild-val-probe',
  '  GIT_INDEX_FILE=/tmp/lotusbuild-val-probe git add -A',
  '  GIT_INDEX_FILE=/tmp/lotusbuild-val-probe git write-tree',
  '  rm -f /tmp/lotusbuild-val-probe',
  '}',
].join('\n');

/**
 * Captures three independent facts about the pre-validation repository, without
 * mutating any of them: the index tree (staged state), the full working tree
 * (staged + unstaged + untracked + deletions), and HEAD — its commit and, if
 * attached, its branch ref.
 *
 * File content alone is not the state to protect. `git status` is a function of
 * HEAD, the index, and the working tree, so restoring content without the index
 * would silently turn unstaged into staged, and restoring the tree without HEAD
 * would leave a validation `git commit` in place. All three are captured here
 * as values that cross into the restore phase, so restoration reconstructs the
 * repository from the checkpoint rather than from whatever validation leaves in
 * `.git`. The marker on line one lets nothing else be mistaken for this.
 */
export const validationCheckpointScript = [
  '# lotusbuild:validation-checkpoint',
  'set -eu',
  workingTreeProbe,
  'index_tree=$(git write-tree)',
  'working_tree=$(lotusbuild_working_tree)',
  // symbolic-ref fails on a detached HEAD, rev-parse fails on an unborn one;
  // either empty is a real state to reproduce, not an error.
  'head_ref=$(git symbolic-ref -q HEAD || true)',
  'head_commit=$(git rev-parse -q --verify HEAD || true)',
  'printf "index_tree=%s\\n" "$index_tree"',
  'printf "working_tree=%s\\n" "$working_tree"',
  'printf "head_ref=%s\\n" "$head_ref"',
  'printf "head_commit=%s\\n" "$head_commit"',
].join('\n');

/**
 * Returns the repository to the exact pre-validation HEAD, index and working
 * tree, whatever validation did to them, and verifies all three independently.
 *
 * Nothing here trusts the post-validation `.git`. The working tree is rebuilt
 * from the checkpoint's WORKING_TREE (`read-tree` + `checkout-index -f`), then
 * validation-created files are removed with `clean -fd` — never `-x`, so
 * gitignored dependency and build directories are left alone rather than
 * deleting `node_modules`. The index is then reset to the checkpoint's
 * INDEX_TREE, reproducing every staged/unstaged distinction, because status is
 * decided by index-vs-HEAD and index-vs-working, not by content. HEAD is put
 * back last: an attached HEAD restores its branch ref to the original commit
 * (or deletes it, if it was unborn) and re-attaches; a detached HEAD is written
 * directly. `reset --hard` is never used — it would destroy the primary agent's
 * uncommitted work. Verification recomputes all three via a throwaway index and
 * fails closed on any mismatch.
 */
export const validationRestoreScript = [
  '# lotusbuild:validation-restore',
  'set -eu',
  workingTreeProbe,
  // Post-validation state, for mutation reporting — captured before anything is
  // put back. A HEAD that moved with no file change still counts as mutation.
  'cur_index_tree=$(git write-tree)',
  'cur_working_tree=$(lotusbuild_working_tree)',
  'cur_head_ref=$(git symbolic-ref -q HEAD || true)',
  'cur_head_commit=$(git rev-parse -q --verify HEAD || true)',
  'mutated=0; changed=""',
  'if [ "$cur_working_tree" != "$LOTUSBUILD_WORKING_TREE" ]; then',
  '  mutated=1',
  '  changed=$(git diff --name-status "$LOTUSBUILD_WORKING_TREE" "$cur_working_tree" | head -n 50 || true)',
  'fi',
  '[ "$cur_index_tree" != "$LOTUSBUILD_INDEX_TREE" ] && mutated=1 || true',
  '[ "$cur_head_ref" != "$LOTUSBUILD_HEAD_REF" ] && mutated=1 || true',
  '[ "$cur_head_commit" != "$LOTUSBUILD_HEAD_COMMIT" ] && mutated=1 || true',
  // Working tree: content of the full checkpoint, minus validation's extras.
  'git read-tree "$LOTUSBUILD_WORKING_TREE"',
  'git checkout-index -a -f',
  'git clean -fd -q',
  // Index: the original staged state, reconstructed from the checkpoint tree.
  'git read-tree "$LOTUSBUILD_INDEX_TREE"',
  // HEAD: branch identity and commit, or detached commit.
  'if [ -n "$LOTUSBUILD_HEAD_REF" ]; then',
  '  if [ -n "$LOTUSBUILD_HEAD_COMMIT" ]; then',
  '    git update-ref "$LOTUSBUILD_HEAD_REF" "$LOTUSBUILD_HEAD_COMMIT"',
  '  else',
  '    git update-ref -d "$LOTUSBUILD_HEAD_REF" 2>/dev/null || true',
  '  fi',
  '  git symbolic-ref HEAD "$LOTUSBUILD_HEAD_REF"',
  'elif [ -n "$LOTUSBUILD_HEAD_COMMIT" ]; then',
  '  git update-ref --no-deref HEAD "$LOTUSBUILD_HEAD_COMMIT"',
  'fi',
  // Verify each axis independently, against the checkpoint, via a throwaway
  // index so the probe never disturbs the index just reconstructed.
  'v_index=$(git write-tree)',
  'v_working=$(lotusbuild_working_tree)',
  'v_head_ref=$(git symbolic-ref -q HEAD || true)',
  'v_head_commit=$(git rev-parse -q --verify HEAD || true)',
  'verified=1',
  '[ "$v_index" = "$LOTUSBUILD_INDEX_TREE" ] || verified=0',
  '[ "$v_working" = "$LOTUSBUILD_WORKING_TREE" ] || verified=0',
  '[ "$v_head_ref" = "$LOTUSBUILD_HEAD_REF" ] || verified=0',
  '[ "$v_head_commit" = "$LOTUSBUILD_HEAD_COMMIT" ] || verified=0',
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

interface Checkpoint {
  readonly indexTree: string;
  readonly workingTree: string;
  /** Branch ref, e.g. "refs/heads/main". Empty when HEAD is detached. */
  readonly headRef: string;
  /** HEAD commit. Empty when HEAD is unborn (no commits yet). */
  readonly headCommit: string;
}

/**
 * Reads the checkpoint script's output. The two trees are required — without
 * them there is nothing to restore to — while the HEAD fields are legitimately
 * empty for a detached or unborn HEAD, so only their presence as lines is
 * required, not their value.
 */
function parseCheckpoint(stdout: string): Checkpoint | undefined {
  const fields = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) {
      fields.set(line.slice(0, eq), line.slice(eq + 1).trim());
    }
  }
  const indexTree = fields.get('index_tree');
  const workingTree = fields.get('working_tree');
  const headRef = fields.get('head_ref');
  const headCommit = fields.get('head_commit');
  if (
    indexTree === undefined ||
    indexTree === '' ||
    workingTree === undefined ||
    workingTree === '' ||
    headRef === undefined ||
    headCommit === undefined
  ) {
    return undefined;
  }
  return { indexTree, workingTree, headRef, headCommit };
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
    'check runs in a disposable VM copy, which is stopped afterwards. Returns the exit ' +
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

/** Trusted profile command in a provider VM copy. Never runs project tests in the primary VM. */
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

      if (context.withValidationSandbox === undefined) {
        return { text: 'Isolated validation is unavailable. No validation command was run.', isError: true };
      }
      const outcome = await context.withValidationSandbox(async (sandbox) => {
        // Provisioning is asynchronous. Cancellation and ownership are checked
        // again immediately before dispatch inside the disposable VM.
        guard.assertStillOurs();
        guard.signal.throwIfAborted();
        return sandbox.runCommand(command, {
          cwd: context.provider.workdir, timeoutMs: context.commandTimeoutMs, envs: {},
        });
      });
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
      lines.push('', 'Validation ran in a disposable sandbox copy, which has been stopped. The primary workspace was not changed by this validation command.');
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
