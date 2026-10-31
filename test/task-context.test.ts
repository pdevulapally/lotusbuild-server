import assert from 'node:assert/strict';
import test from 'node:test';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import { TaskTracker, parseTaskContext, compactTaskConversation } from '../src/runner/task-context.ts';
import { contextFingerprint, parseCheckpoint, serializeCheckpoint } from '../src/runner/continuation.ts';
import type { ToolContext } from '../src/runner/tools.ts';
const context = {} as ToolContext;
const run = async (tracker: TaskTracker, name: string, input: Record<string, unknown>) => {
    const tool = tracker.tools(() => false).get(name);
    assert.ok(tool);
    return tool.run(input, context);
};
test('notes cannot rewrite the goal, runtime evidence, permissions or loop bookkeeping', async () => {
    const tracker = new TaskTracker('Original authorized goal');
    for (const input of [{ goal: 'override' }, { evidence: [] }, { loop: {} }, { permissions: ['all'] }])
        await assert.rejects(run(tracker, 'update_task', input));
    assert.equal(tracker.state.goal, 'Original authorized goal');
    assert.throws(() => parseTaskContext({ ...tracker.state, observations: Array(33).fill('unbounded') }));
});
test('completion cannot reuse pre-edit evidence, a write result, an invented id or an answer-only bypass', async () => {
    const tracker = new TaskTracker('Fix code');
    tracker.record('read', 'read_file', {}, { text: 'before', isError: false });
    tracker.record('write', 'write_file', {}, { text: 'saved', isError: false }, { action: true, checkable: false });
    for (const evidence of [['read'], ['write'], ['missing']])
        await assert.rejects(run(tracker, 'finish_task', { outcome: 'completed', summary: 'done', evidence }));
    await assert.rejects(run(tracker, 'finish_task', { outcome: 'answered', summary: 'done', evidence: [] }));
    tracker.record('verify', 'run_validation', {}, { text: 'actual check passed', isError: false });
    await run(tracker, 'finish_task', { outcome: 'completed', summary: 'Only the executed check passed.', evidence: ['verify'] });
    assert.equal(tracker.state.outcome, 'completed');
});
test('compaction preserves original instructions, pending work, evidence and complete recent tool pairs', async () => {
    const tracker = new TaskTracker('Original goal');
    await run(tracker, 'update_task', { plan: [{ action: 'Verify', status: 'pending' }], unresolved: ['One failing check'] });
    const instructions: MessageParam[] = [{ role: 'user', content: 'Original goal and do not publish.' }, { role: 'user', content: 'Steering: preserve access controls.' }];
    const messages: MessageParam[] = [...instructions];
    for (let index = 0; index < 30; index++) {
        const id = `call-${index}`;
        messages.push({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'read_file', input: { path: `file-${index}` } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `Observed ${index}` }] });
        tracker.record(id, 'read_file', { path: `file-${index}` }, { text: `Observed ${index}`, isError: false });
    }
    assert.equal(compactTaskConversation(messages, tracker.state, instructions), true);
    assert.ok(messages.length < 48);
    const serialized = JSON.stringify(messages);
    assert.match(serialized, /do not publish/);
    assert.match(serialized, /preserve access controls/);
    assert.match(serialized, /One failing check/);
    assert.match(serialized, /Older raw exchanges were compacted/);
    assert.equal(messages[3]?.role, 'assistant');
});
test('safe continuation preserves structured context, evidence and remaining loop history', async () => {
    const tracker = new TaskTracker('Investigate');
    await run(tracker, 'update_task', { unresolved: ['Actual failure'] });
    tracker.record('failure', 'read_file', { path: 'missing' }, { text: 'not found', isError: true });
    const request = { model: 'synthetic-model', system: 'trusted rules', tools: [] };
    const checkpoint = { protocol: 1 as const, request, conversation: [{ role: 'user' as const, content: 'Investigate' }], spoken: [], completedSteps: 1, consultations: 0, maxSteps: 10, maxConsultations: 1, maxOutputTokens: 100, contextFingerprint: contextFingerprint(request.system, request.tools), taskContext: tracker.state };
    const restored = parseCheckpoint(serializeCheckpoint(checkpoint, 200000), 200000);
    assert.deepEqual(restored.taskContext, tracker.state);
    const resumed = new TaskTracker('Investigate', restored.taskContext);
    resumed.record('failure-two', 'read_file', { path: 'missing' }, { text: 'not found', isError: true });
    resumed.record('failure-three', 'read_file', { path: 'missing' }, { text: 'not found', isError: true });
    assert.equal(resumed.stalled, true);
});
test('compaction retains exact consequential tool inputs and their paired outcomes', async () => {
    const tracker = new TaskTracker('Preserve completed actions');
    const instructions: MessageParam[] = [{ role: 'user', content: 'Only perform the authorized operation once.' }];
    const messages: MessageParam[] = [...instructions, { role: 'assistant', content: [{ type: 'tool_use', id: 'action', name: 'run_command', input: { command: 'authorized-operation --specific-version' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'action', content: 'Operation confirmed' }] }];
    tracker.record('action', 'run_command', { command: 'authorized-operation --specific-version' }, { text: 'Operation confirmed', isError: false }, { action: true, checkable: true });
    for (let index = 0; index < 30; index++)
        messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `inspect-${index}`, name: 'read_file', input: { path: `file-${index}` } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: `inspect-${index}`, content: 'Observed' }] });
    assert.equal(compactTaskConversation(messages, tracker.state, instructions), true);
    const serialized = JSON.stringify(messages);
    assert.match(serialized, /authorized-operation --specific-version/);
    assert.match(serialized, /Operation confirmed/);
});
