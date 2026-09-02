import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SandboxProvider } from '../src/entitlements/schema.ts';
import type { CommandOutcome, RunningSandbox } from '../src/sandboxes/provider.ts';
import {
  type ToolContext,
  readOnlyTools,
  runTool,
  truncate,
  workspaceTools,
} from '../src/runner/tools.ts';

/**
 * Exercises `edit_file` and ranged `read_file` directly against the tool
 * layer, the same way `runModelLoop` dispatches them — through `runTool`
 * against a granted `ToolSet` — rather than through a whole agent turn. The
 * behaviour under test is file-content mechanics and truncation-safety, none
 * of which needs a model, a session or a specialist.
 */

const provider: SandboxProvider = {
  platform: 'web',
  provider: 'e2b',
  template: 'test-template',
  timeoutSeconds: 60,
  memoryMb: 512,
  cpus: 1,
  concurrencyMeterKey: 'sandbox.concurrent.web',
  workdir: '/workspace',
  idleGraceSeconds: 5,
  agentInstructions: 'build the thing',
  validationProfiles: new Map(),
};

/** An in-memory file store, keyed by the resolved absolute path — real read/write, no git. */
class FileSandbox implements RunningSandbox {
  readonly externalId = 'sandbox-1';
  readonly files = new Map<string, string>();
  readonly writes: { path: string; content: string }[] = [];

  async runCommand(): Promise<CommandOutcome> {
    throw new Error('not used by these tests');
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
    this.writes.push({ path, content });
  }

  async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`no such file: ${path}`);
    }
    return content;
  }

  previewUrl(): string {
    return 'https://preview.invalid';
  }

  async stop(): Promise<void> {}
}

/** `path` relative to the fixed workdir, as the tools resolve it before touching the sandbox. */
function at(relative: string): string {
  return `/workspace/${relative}`;
}

function contextOf(sandbox: FileSandbox, toolOutputMaxChars = 5000): ToolContext {
  return {
    sandbox,
    provider,
    commandTimeoutMs: 1000,
    previewReadyTimeoutSeconds: 5,
    toolOutputMaxChars,
    onPreview: async () => {},
  };
}

// ---------------------------------------------------------------------------
// edit_file
// ---------------------------------------------------------------------------

test('edit_file replaces the one exact occurrence and leaves the rest untouched', async () => {
  const sandbox = new FileSandbox();
  sandbox.files.set(at('src/example.ts'), 'const a = 1;\nconst obsolete = 2;\nconst b = 3;\n');

  const result = await runTool(
    'edit_file',
    { path: 'src/example.ts', old_string: 'const obsolete = 2;', new_string: 'const fixed = 2;' },
    contextOf(sandbox),
    workspaceTools,
  );

  assert.equal(result.isError, false);
  assert.equal(
    sandbox.files.get(at('src/example.ts')),
    'const a = 1;\nconst fixed = 2;\nconst b = 3;\n',
  );
});

test('edit_file replaces a unique multi-line old_string, reporting the line span', async () => {
  const sandbox = new FileSandbox();
  sandbox.files.set(
    at('src/example.ts'),
    'function f() {\n  const obsolete = 2;\n  return obsolete;\n}\n',
  );

  const result = await runTool(
    'edit_file',
    {
      path: 'src/example.ts',
      old_string: 'const obsolete = 2;\n  return obsolete;',
      new_string: 'const fixed = 2;\n  return fixed;',
    },
    contextOf(sandbox),
    workspaceTools,
  );

  assert.equal(result.isError, false);
  assert.equal(
    sandbox.files.get(at('src/example.ts')),
    'function f() {\n  const fixed = 2;\n  return fixed;\n}\n',
  );
  assert.match(result.text, /lines 2-3/);
});

test('edit_file zero matches fails explicitly', async () => {
  const sandbox = new FileSandbox();
  sandbox.files.set(at('src/example.ts'), 'const a = 1;\n');

  const result = await runTool(
    'edit_file',
    { path: 'src/example.ts', old_string: 'does not appear', new_string: 'x' },
    contextOf(sandbox),
    workspaceTools,
  );

  assert.equal(result.isError, true);
  assert.match(result.text, /old_string was not found in .*src\/example\.ts/);
  // Nothing was written.
  assert.deepEqual(sandbox.writes, []);
});

test('edit_file multiple matches fails explicitly rather than choosing one', async () => {
  const sandbox = new FileSandbox();
  sandbox.files.set(at('src/example.ts'), 'retry();\nretry();\n');

  const result = await runTool(
    'edit_file',
    { path: 'src/example.ts', old_string: 'retry();', new_string: 'retryOnce();' },
    contextOf(sandbox),
    workspaceTools,
  );

  assert.equal(result.isError, true);
  assert.match(result.text, /matched 2 locations/);
  assert.match(result.text, /more specific old_string/);
  assert.deepEqual(sandbox.writes, []);
});

for (const [content, oldString] of [
  ['aaaa', 'aaa'],
  ['aaa', 'aa'],
  ['abcabc', 'abc'],
] as const) {
  test(`edit_file treats overlapping candidates as ambiguous: "${oldString}" in "${content}"`, async () => {
    const sandbox = new FileSandbox();
    sandbox.files.set(at('src/example.ts'), content);

    const result = await runTool(
      'edit_file',
      { path: 'src/example.ts', old_string: oldString, new_string: 'X' },
      contextOf(sandbox),
      workspaceTools,
    );

    assert.equal(result.isError, true);
    assert.match(result.text, /matched \d+ locations/);
    assert.deepEqual(sandbox.writes, []);
  });
}

test('edit_file succeeds when old_string spans the whole file with no room for a second match', async () => {
  const sandbox = new FileSandbox();
  sandbox.files.set(at('src/example.ts'), 'aaaa');

  const result = await runTool(
    'edit_file',
    { path: 'src/example.ts', old_string: 'aaaa', new_string: 'bbbb' },
    contextOf(sandbox),
    workspaceTools,
  );

  assert.equal(result.isError, false);
  assert.equal(sandbox.files.get(at('src/example.ts')), 'bbbb');
});

test('edit_file rejects an empty old_string', async () => {
  const sandbox = new FileSandbox();
  sandbox.files.set(at('src/example.ts'), 'const a = 1;\n');

  const result = await runTool(
    'edit_file',
    { path: 'src/example.ts', old_string: '', new_string: 'x' },
    contextOf(sandbox),
    workspaceTools,
  );

  assert.equal(result.isError, true);
  assert.match(result.text, /non-empty string/);
  assert.deepEqual(sandbox.writes, []);
});

test('edit_file allows an empty new_string as a deletion', async () => {
  const sandbox = new FileSandbox();
  sandbox.files.set(at('src/example.ts'), 'const a = 1;\nconst obsolete = 2;\nconst b = 3;\n');

  const result = await runTool(
    'edit_file',
    { path: 'src/example.ts', old_string: 'const obsolete = 2;\n', new_string: '' },
    contextOf(sandbox),
    workspaceTools,
  );

  assert.equal(result.isError, false);
  assert.equal(sandbox.files.get(at('src/example.ts')), 'const a = 1;\nconst b = 3;\n');
});

test('edit_file rejects a path that escapes the project workspace', async () => {
  const sandbox = new FileSandbox();

  const result = await runTool(
    'edit_file',
    { path: '../outside.ts', old_string: 'a', new_string: 'b' },
    contextOf(sandbox),
    workspaceTools,
  );

  assert.equal(result.isError, true);
  assert.match(result.text, /resolves outside the project directory/);
  assert.deepEqual(sandbox.writes, []);
});

test('edit_file matches the current file, not whatever the model saw earlier', async () => {
  const sandbox = new FileSandbox();
  sandbox.files.set(at('src/example.ts'), 'const target = 1;\n');
  const context = contextOf(sandbox);

  // The model reads the file, sees a single "const target = 1;" it plans to
  // change...
  const read = await runTool('read_file', { path: 'src/example.ts' }, context, workspaceTools);
  assert.ok(read.text.includes('const target = 1;'));

  // ...but something else changes the file before the edit is issued — a
  // prior write_file call in the same turn, in this test's case.
  await runTool(
    'write_file',
    { path: 'src/example.ts', content: 'const target = 1;\nconst target = 1;\n' },
    context,
    workspaceTools,
  );

  const result = await runTool(
    'edit_file',
    { path: 'src/example.ts', old_string: 'const target = 1;', new_string: 'const target = 2;' },
    context,
    workspaceTools,
  );

  // No cached content, no repair attempt — it fails against the file as it
  // actually stands now, which now has two occurrences.
  assert.equal(result.isError, true);
  assert.match(result.text, /matched 2 locations/);
});

test('edit_file is granted to the primary agent, not to specialists', () => {
  assert.ok(workspaceTools.has('edit_file'));
  assert.equal(readOnlyTools.has('edit_file'), false);
});

test('edit_file is not parallel-safe', () => {
  assert.equal(workspaceTools.get('edit_file')?.parallelSafe, undefined);
});

test('edit_file reports a short confirmation, not the whole file', async () => {
  const sandbox = new FileSandbox();
  const big = `${'x'.repeat(20000)}\nunique-marker\n${'y'.repeat(20000)}`;
  sandbox.files.set(at('src/big.ts'), big);

  const result = await runTool(
    'edit_file',
    { path: 'src/big.ts', old_string: 'unique-marker', new_string: 'replaced-marker' },
    contextOf(sandbox),
    workspaceTools,
  );

  assert.equal(result.isError, false);
  assert.ok(result.text.length < 200, `expected a short confirmation, got ${result.text.length} chars`);
  assert.equal(result.text.includes('x'.repeat(20000)), false);
});

// ---------------------------------------------------------------------------
// read_file — ranged reads
// ---------------------------------------------------------------------------

/** Splits a read_file result into its metadata line and its content, as the model would see it. */
function parseRead(text: string): {
  readonly start: number;
  readonly end: number;
  readonly total: number;
  readonly hasMore: boolean;
  readonly content: string;
} {
  const [meta, separator, ...rest] = text.split('\n');
  assert.equal(separator, '---');
  const match = /UTF-16 code units (\d+)-(\d+) of (\d+) \(has_more: (true|false)\)$/.exec(
    meta ?? '',
  );
  assert.ok(match, `unexpected read_file metadata line: ${meta}`);
  const [, start, end, total, hasMore] = match;
  return {
    start: Number(start),
    end: Number(end),
    total: Number(total),
    hasMore: hasMore === 'true',
    content: rest.join('\n'),
  };
}

test('read_file with no range returns the whole small file', async () => {
  const sandbox = new FileSandbox();
  sandbox.files.set(at('src/small.ts'), 'const a = 1;\n');

  const result = await runTool(
    'read_file',
    { path: 'src/small.ts' },
    contextOf(sandbox),
    workspaceTools,
  );

  assert.equal(result.isError, false);
  const parsed = parseRead(result.text);
  assert.equal(parsed.start, 0);
  assert.equal(parsed.end, 13);
  assert.equal(parsed.total, 13);
  assert.equal(parsed.hasMore, false);
  assert.equal(parsed.content, 'const a = 1;\n');
});

test('read_file pages through a large file with correct metadata at each step', async () => {
  const sandbox = new FileSandbox();
  const content = 'abcdefghij'.repeat(2400); // 24000 characters
  sandbox.files.set(at('src/big.ts'), content);
  // Comfortably above one page (8000) plus metadata, so the truncation-safety
  // shrink never engages and every page comes back at exactly its full size.
  const context = contextOf(sandbox, 20000);

  const first = parseRead(
    (
      await runTool(
        'read_file',
        { path: 'src/big.ts', offset: 0, limit: 8000 },
        context,
        workspaceTools,
      )
    ).text,
  );
  assert.deepEqual([first.start, first.end, first.total, first.hasMore], [0, 8000, 24000, true]);
  assert.equal(first.content, content.slice(0, 8000));

  const middle = parseRead(
    (
      await runTool(
        'read_file',
        { path: 'src/big.ts', offset: 8000, limit: 8000 },
        context,
        workspaceTools,
      )
    ).text,
  );
  assert.deepEqual(
    [middle.start, middle.end, middle.total, middle.hasMore],
    [8000, 16000, 24000, true],
  );
  assert.equal(middle.content, content.slice(8000, 16000));

  const last = parseRead(
    (
      await runTool(
        'read_file',
        { path: 'src/big.ts', offset: 16000, limit: 8000 },
        context,
        workspaceTools,
      )
    ).text,
  );
  assert.deepEqual([last.start, last.end, last.total, last.hasMore], [16000, 24000, 24000, false]);
  assert.equal(last.content, content.slice(16000, 24000));
});

test('read_file at exactly EOF returns an empty, consistent result', async () => {
  const sandbox = new FileSandbox();
  sandbox.files.set(at('src/small.ts'), '0123456789');

  const result = await runTool(
    'read_file',
    { path: 'src/small.ts', offset: 10, limit: 100 },
    contextOf(sandbox),
    workspaceTools,
  );

  assert.equal(result.isError, false);
  const parsed = parseRead(result.text);
  assert.deepEqual([parsed.start, parsed.end, parsed.total, parsed.hasMore, parsed.content], [
    10,
    10,
    10,
    false,
    '',
  ]);
});

test('read_file beyond EOF fails explicitly, citing the actual length', async () => {
  const sandbox = new FileSandbox();
  sandbox.files.set(at('src/small.ts'), '0123456789');

  const result = await runTool(
    'read_file',
    { path: 'src/small.ts', offset: 11, limit: 100 },
    contextOf(sandbox),
    workspaceTools,
  );

  assert.equal(result.isError, true);
  assert.match(result.text, /"offset" \(11\) is beyond the end/);
  assert.match(result.text, /10 UTF-16 code units/);
});

test('read_file rejects a negative offset', async () => {
  const sandbox = new FileSandbox();
  sandbox.files.set(at('src/small.ts'), 'x');

  const result = await runTool(
    'read_file',
    { path: 'src/small.ts', offset: -1 },
    contextOf(sandbox),
    workspaceTools,
  );

  assert.equal(result.isError, true);
  assert.match(result.text, /non-negative integer/);
});

for (const limit of [0, -5]) {
  test(`read_file rejects a limit of ${limit}`, async () => {
    const sandbox = new FileSandbox();
    sandbox.files.set(at('src/small.ts'), 'x');

    const result = await runTool(
      'read_file',
      { path: 'src/small.ts', limit },
      contextOf(sandbox),
      workspaceTools,
    );

    assert.equal(result.isError, true);
    assert.match(result.text, /positive integer/);
  });
}

test('an excessively large limit is bounded to the tool output budget, truthfully', async () => {
  const sandbox = new FileSandbox();
  const content = 'z'.repeat(2000);
  sandbox.files.set(at('src/big.ts'), content);
  const context = contextOf(sandbox, 500);

  const result = await runTool(
    'read_file',
    { path: 'src/big.ts', offset: 0, limit: 10_000_000 },
    context,
    workspaceTools,
  );

  assert.equal(result.isError, false);
  assert.ok(result.text.length <= 500);
  const parsed = parseRead(result.text);
  assert.equal(parsed.start, 0);
  assert.equal(parsed.total, 2000);
  assert.equal(parsed.hasMore, true);
  // What "end" claims was delivered is exactly what the content actually is.
  assert.equal(parsed.content, content.slice(0, parsed.end));
});

test('sequential ranged reads reconstruct the file with no gap and no overlap', async () => {
  const sandbox = new FileSandbox();
  const content = Array.from({ length: 5000 }, (_, i) => String(i % 10)).join('');
  sandbox.files.set(at('src/big.ts'), content);
  const context = contextOf(sandbox);

  let offset = 0;
  let reconstructed = '';
  for (let guard = 0; guard < 100; guard += 1) {
    const parsed = parseRead(
      (
        await runTool(
          'read_file',
          { path: 'src/big.ts', offset, limit: 777 },
          context,
          workspaceTools,
        )
      ).text,
    );
    assert.equal(parsed.start, offset);
    reconstructed += parsed.content;
    if (!parsed.hasMore) {
      assert.equal(parsed.end, parsed.total);
      break;
    }
    offset = parsed.end;
  }

  assert.equal(reconstructed, content);
});

test('the generic tool-output truncation is a no-op on what read_file already returned', async () => {
  const sandbox = new FileSandbox();
  const content = 'q'.repeat(50_000);
  sandbox.files.set(at('src/big.ts'), content);
  const cap = 4000;
  const context = contextOf(sandbox, cap);

  // No explicit limit: the default window is the tool-output budget itself,
  // which is exactly the case most likely to collide with the outer truncate.
  const result = await runTool('read_file', { path: 'src/big.ts' }, context, workspaceTools);

  assert.equal(result.isError, false);
  // Applying the same truncation runModelLoop applies downstream must change
  // nothing: read_file already fits, so end/has_more are never a claim about
  // content the model did not actually receive.
  assert.equal(truncate(result.text, cap), result.text);
});

test('a read-only specialist can page through a large file the same way', async () => {
  const sandbox = new FileSandbox();
  const content = 'm'.repeat(9000);
  sandbox.files.set(at('src/big.ts'), content);
  const context = contextOf(sandbox);

  const result = await runTool(
    'read_file',
    { path: 'src/big.ts', offset: 0, limit: 4000 },
    context,
    readOnlyTools,
  );

  assert.equal(result.isError, false);
  const parsed = parseRead(result.text);
  assert.deepEqual([parsed.start, parsed.end, parsed.total, parsed.hasMore], [0, 4000, 9000, true]);
});

// ---------------------------------------------------------------------------
// read_file — Unicode boundary safety
//
// "characters" in the wire format and in these comments means UTF-16 code
// units, matching JavaScript's `.length`/`.slice` — the unit these offsets and
// limits are actually counted in. A plain-ASCII character is one code unit;
// a character outside the Basic Multilingual Plane (an emoji, among others)
// is two, stored as a surrogate pair, and a naive slice can land between them.
// ---------------------------------------------------------------------------

/** True if `text` contains a surrogate half with no matching other half next to it. */
function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      i += 1; // the low surrogate is accounted for; do not re-examine it alone
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true; // a low surrogate with nothing preceding it
    }
  }
  return false;
}

test('read_file pagination on plain ASCII content is unaffected by surrogate safety', async () => {
  const sandbox = new FileSandbox();
  const content = 'The quick brown fox jumps over the lazy dog. '.repeat(50);
  sandbox.files.set(at('src/ascii.ts'), content);
  const context = contextOf(sandbox, 20000);

  const parsed = parseRead(
    (
      await runTool(
        'read_file',
        { path: 'src/ascii.ts', offset: 100, limit: 200 },
        context,
        workspaceTools,
      )
    ).text,
  );

  assert.deepEqual([parsed.start, parsed.end], [100, 300]);
  assert.equal(parsed.content, content.slice(100, 300));
});

test('read_file can read a file containing a character outside the BMP', async () => {
  const sandbox = new FileSandbox();
  sandbox.files.set(at('src/emoji.ts'), 'a\u{1F600}b'); // 'a' + U+1F600 (2 units) + 'b' = 4 units
  const context = contextOf(sandbox);

  const result = await runTool('read_file', { path: 'src/emoji.ts' }, context, workspaceTools);

  assert.equal(result.isError, false);
  const parsed = parseRead(result.text);
  assert.equal(parsed.total, 4);
  assert.equal(parsed.content, 'a\u{1F600}b');
});

test('a ranged read never returns an isolated high surrogate', async () => {
  const sandbox = new FileSandbox();
  sandbox.files.set(at('src/emoji.ts'), 'a\u{1F600}b'); // indices: a=0, high=1, low=2, b=3
  const context = contextOf(sandbox);

  // offset 1 starts exactly at the pair; limit 1 alone would place the end
  // between the high and low surrogate if it were not adjusted.
  const result = await runTool(
    'read_file',
    { path: 'src/emoji.ts', offset: 1, limit: 1 },
    context,
    workspaceTools,
  );

  assert.equal(result.isError, false);
  const parsed = parseRead(result.text);
  assert.equal(hasLoneSurrogate(parsed.content), false);
  // Smallest correct behaviour: the whole pair is deferred to the next read
  // rather than half of it being handed back.
  assert.deepEqual([parsed.start, parsed.end, parsed.hasMore, parsed.content], [1, 1, true, '']);
});

test('a ranged read never starts on an isolated low surrogate', async () => {
  const sandbox = new FileSandbox();
  sandbox.files.set(at('src/emoji.ts'), 'a\u{1F600}b');
  const context = contextOf(sandbox);

  // offset 2 points directly at the low half of the pair.
  const result = await runTool(
    'read_file',
    { path: 'src/emoji.ts', offset: 2, limit: 10 },
    context,
    workspaceTools,
  );

  assert.equal(result.isError, false);
  const parsed = parseRead(result.text);
  assert.equal(hasLoneSurrogate(parsed.content), false);
  // Shifted back to include the whole pair, and reported truthfully.
  assert.equal(parsed.start, 1);
  assert.equal(parsed.content, '\u{1F600}b');
});

test('continuation metadata reflects a boundary moved to avoid splitting a pair', async () => {
  const sandbox = new FileSandbox();
  sandbox.files.set(at('src/emoji.ts'), 'a\u{1F600}b'); // total 4
  const context = contextOf(sandbox);

  // offset 0 + limit 2 asks for end=2, which splits the pair.
  const result = await runTool(
    'read_file',
    { path: 'src/emoji.ts', offset: 0, limit: 2 },
    context,
    workspaceTools,
  );

  assert.equal(result.isError, false);
  const parsed = parseRead(result.text);
  // What "end" claims was delivered is exactly how much content came back.
  assert.equal(parsed.content.length, parsed.end - parsed.start);
  assert.equal(hasLoneSurrogate(parsed.content), false);
  assert.equal(parsed.end, 1); // shifted back from the requested 2
  assert.equal(parsed.content, 'a');
});

test('sequential ranged reads reconstruct a file with non-BMP characters exactly', async () => {
  const sandbox = new FileSandbox();
  const content = 'x\u{1F600}y\u{1F389}z\u{1F600}w\u{1F389}v'.repeat(30);
  sandbox.files.set(at('src/emoji-big.ts'), content);
  const context = contextOf(sandbox, 5000);

  let offset = 0;
  let reconstructed = '';
  for (let guard = 0; guard < 200; guard += 1) {
    const parsed = parseRead(
      (
        await runTool(
          'read_file',
          { path: 'src/emoji-big.ts', offset, limit: 37 },
          context,
          workspaceTools,
        )
      ).text,
    );
    assert.equal(parsed.start, offset);
    assert.equal(hasLoneSurrogate(parsed.content), false);
    reconstructed += parsed.content;
    if (!parsed.hasMore) {
      assert.equal(parsed.end, parsed.total);
      break;
    }
    offset = parsed.end;
  }

  assert.equal(reconstructed, content);
});

test('the tool-output budget stays truthful when the content is entirely non-BMP', async () => {
  const sandbox = new FileSandbox();
  const content = '\u{1F600}'.repeat(5000); // 5000 pairs, 10000 UTF-16 code units
  sandbox.files.set(at('src/emoji-huge.ts'), content);
  const cap = 4000;
  const context = contextOf(sandbox, cap);

  const result = await runTool(
    'read_file',
    { path: 'src/emoji-huge.ts' },
    context,
    workspaceTools,
  );

  assert.equal(result.isError, false);
  assert.ok(result.text.length <= cap);
  // Same invariant as the ASCII case: the outer truncation must be a no-op.
  assert.equal(truncate(result.text, cap), result.text);
  const parsed = parseRead(result.text);
  assert.equal(hasLoneSurrogate(parsed.content), false);
  assert.equal(parsed.content, content.slice(parsed.start, parsed.end));
});
