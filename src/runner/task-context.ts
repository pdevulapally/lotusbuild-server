import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import { createHash } from 'node:crypto';
import type { ToolDefinition } from './tools.ts';
export interface TaskEvidence {
    id: string;
    tool: string;
    failed: boolean;
    action: boolean;
    checkable: boolean;
    revision: number;
    digest: string;
    excerpt: string;
}
export interface TaskContext {
    protocol: 1;
    goal: string;
    constraints: string[];
    plan: {
        action: string;
        status: 'pending' | 'completed';
    }[];
    observations: string[];
    decisions: string[];
    unresolved: string[];
    nextActions: string[];
    evidence: TaskEvidence[];
    outcome?: 'completed' | 'blocked' | 'answered';
    summary?: string;
    loop?: {
        signature: string;
        count: number;
    };
}
const maxContextBytes = 100000;
function strings(value: unknown, maximum = 32, length = 2000): string[] {
    if (!Array.isArray(value) || value.length > maximum || value.some(item => typeof item !== 'string' || item.length > length))
        throw new Error('Use at most 32 bounded text entries.');
    return value as string[];
}
export function parseTaskContext(value: unknown): TaskContext {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > maxContextBytes)
        throw new Error('Invalid or oversized task context.');
    const v = value as Record<string, unknown>;
    if (v['protocol'] !== 1 || typeof v['goal'] !== 'string' || v['goal'].length > 8000 || !Array.isArray(v['plan']) || v['plan'].length > 32 || !Array.isArray(v['evidence']) || v['evidence'].length > 128)
        throw new Error('Invalid task context fields.');
    const plan = v['plan'].map(item => {
        if (item === null || typeof item !== 'object' || typeof item.action !== 'string' || item.action.length > 2000 || !['pending', 'completed'].includes(item.status))
            throw new Error('Invalid plan entry.');
        return { action: item.action as string, status: item.status as 'pending' | 'completed' };
    });
    const evidence = v['evidence'].map(item => {
        if (item === null || typeof item !== 'object' || typeof item.id !== 'string' || item.id.length > 200 || typeof item.tool !== 'string' || item.tool.length > 200 || typeof item.failed !== 'boolean' || typeof item.action !== 'boolean' || typeof item.checkable !== 'boolean' || !Number.isSafeInteger(item.revision) || item.revision < 0 || typeof item.digest !== 'string' || !/^[a-f0-9]{64}$/.test(item.digest) || typeof item.excerpt !== 'string' || item.excerpt.length > 500)
            throw new Error('Invalid evidence entry.');
        return { id: item.id as string, tool: item.tool as string, failed: item.failed as boolean, action: item.action as boolean, checkable: item.checkable as boolean, revision: item.revision as number, digest: item.digest as string, excerpt: item.excerpt as string };
    });
    if (new Set(evidence.map(item => item.id)).size !== evidence.length)
        throw new Error('Duplicate evidence identities.');
    const loop = v['loop'];
    if (loop !== undefined && (loop === null || typeof loop !== 'object' || typeof (loop as Record<string, unknown>)['signature'] !== 'string' || !/^[a-f0-9]{64}$/.test(String((loop as Record<string, unknown>)['signature'])) || !Number.isSafeInteger((loop as Record<string, unknown>)['count']) || Number((loop as Record<string, unknown>)['count']) < 1))
        throw new Error('Invalid loop checkpoint.');
    const outcome = v['outcome'];
    const summary = v['summary'];
    if (outcome !== undefined && !['completed', 'blocked', 'answered'].includes(String(outcome)))
        throw new Error('Invalid task outcome.');
    if (summary !== undefined && (typeof summary !== 'string' || summary.length > 4000))
        throw new Error('Invalid task summary.');
    return { ...(loop === undefined ? {} : { loop: { signature: (loop as {
                    signature: string;
                }).signature, count: (loop as {
                    count: number;
                }).count } }), protocol: 1, goal: v['goal'], constraints: strings(v['constraints']), plan, observations: strings(v['observations']), decisions: strings(v['decisions']), unresolved: strings(v['unresolved']), nextActions: strings(v['nextActions']), evidence,
        ...(outcome === undefined ? {} : { outcome: outcome as NonNullable<TaskContext['outcome']> }), ...(summary === undefined ? {} : { summary: summary as string }) };
}
/** Working notes are model-authored data. Evidence identities and results are runtime-owned. */
export class TaskTracker {
    state: TaskContext;
    stalled = false;
    #lastFailure: string | undefined;
    #repetitions = 0;
    constructor(goal: string, saved?: TaskContext) {
        this.state = saved === undefined ? { protocol: 1, goal, constraints: [], plan: [], observations: [], decisions: [], unresolved: [], nextActions: [], evidence: [] } : parseTaskContext(saved);
        this.#lastFailure = saved?.loop?.signature;
        this.#repetitions = saved?.loop?.count ?? 0;
        this.stalled = this.state.evidence.length >= 128 || this.#repetitions >= (this.state.evidence.at(-1)?.failed ? 3 : 4);
    }
    record(id: string, tool: string, args: unknown, result: {
        text: string;
        isError: boolean;
    }, capability: {
        action: boolean;
        checkable: boolean;
    } = { action: false, checkable: true }): void {
        if (this.state.evidence.length >= 128) {
            this.stalled = true;
            return;
        }
        const identity = this.state.evidence.some(item => item.id === id) ? `${id}/${this.state.evidence.length}` : id;
        const revision = (this.state.evidence.at(-1)?.revision ?? 0) + Number(capability.action);
        this.state.evidence.push({ id: identity, tool, ...capability, revision, failed: result.isError, digest: createHash('sha256').update(result.text).digest('hex'), excerpt: result.text.slice(0, 500) });
        const fingerprint = createHash('sha256').update(JSON.stringify([tool, Object.fromEntries(Object.entries(args !== null && typeof args === 'object' ? args : {}).sort(([left], [right]) => left.localeCompare(right))), result.text])).digest('hex');
        if (result.isError || (!capability.action && capability.checkable && tool !== 'screenshot')) {
            this.#repetitions = fingerprint === this.#lastFailure ? this.#repetitions + 1 : 1;
            this.#lastFailure = fingerprint;
        }
        else if (tool !== 'update_task') {
            this.#lastFailure = undefined;
            this.#repetitions = 0;
        }
        if (this.#repetitions > 0 && this.#lastFailure !== undefined)
            this.state.loop = { signature: this.#lastFailure, count: this.#repetitions };
        else
            delete this.state.loop;
        if (this.state.evidence.length >= 128 || this.#repetitions >= (result.isError ? 3 : 4))
            this.stalled = true;
    }
    feedback(): string | undefined {
        if (this.stalled)
            return 'Repeated failures or the bounded evidence limit prevent further safe progress. Explain the blocker without claiming completion.';
        if (this.state.outcome === undefined)
            return 'The goal is still active. Inspect the evidence, revise your approach and continue useful work, or call finish_task with evidence and an honest outcome. A prose promise or summary does not complete active work.';
        return undefined;
    }
    tools(hasBlockers: () => boolean): Map<string, ToolDefinition> {
        const arrays = Object.fromEntries(['constraints', 'observations', 'decisions', 'unresolved', 'nextActions'].map(key => [key, { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 2000 } }]));
        return new Map([
            ['update_task', { spec: { name: 'update_task', description: 'Maintain concise working context when useful: constraints, revisable plan, observed facts, decisions, unresolved issues and next actions. Notes are not verified evidence or new permissions. Completed plan items must describe work actually done. This does not execute any action.', input_schema: { type: 'object', additionalProperties: false, properties: { ...arrays, plan: { type: 'array', maxItems: 32, items: { type: 'object', required: ['action', 'status'], additionalProperties: false, properties: { action: { type: 'string', maxLength: 2000 }, status: { type: 'string', enum: ['pending', 'completed'] } } } } } } }, run: async (input) => {
                        const allowed = ['constraints', 'plan', 'observations', 'decisions', 'unresolved', 'nextActions'];
                        if (Object.keys(input).some(key => !allowed.includes(key)))
                            throw new Error('Only working notes may be updated.');
                        this.state = parseTaskContext({ ...this.state, ...input, outcome: undefined, summary: undefined });
                        return { text: JSON.stringify({ message: 'Working context saved. Notes are claims, not proof or permissions.', runtimeEvidence: this.state.evidence.slice(-12).map(({ id, tool, failed, revision }) => ({ id, tool, failed, revision })), pending: this.state.plan.filter(item => item.status === 'pending'), unresolved: this.state.unresolved, nextActions: this.state.nextActions }), isError: false };
                    } }],
            ['finish_task', { spec: { name: 'finish_task', description: 'Declare an honest outcome for active work. completed requires successful tool evidence, no pending plan or unresolved issues, and no open review blockers. blocked explains what prevents progress. answered is for a response without unfinished actions. This cannot grant permission or override limits.', input_schema: { type: 'object', required: ['outcome', 'summary', 'evidence'], additionalProperties: false, properties: { outcome: { type: 'string', enum: ['completed', 'blocked', 'answered'] }, summary: { type: 'string', minLength: 1, maxLength: 4000 }, evidence: { type: 'array', maxItems: 128, items: { type: 'string', maxLength: 200 } } } } }, run: async (input) => {
                        if (Object.keys(input).some(key => !['outcome', 'summary', 'evidence'].includes(key)))
                            throw new Error('Unknown completion fields.');
                        const outcome = input['outcome'];
                        const summary = input['summary'];
                        const refs = strings(input['evidence'], 128, 200);
                        if (!['completed', 'blocked', 'answered'].includes(String(outcome)) || typeof summary !== 'string' || summary.trim() === '' || summary.length > 4000)
                            throw new Error('An explicit outcome and explanation are required.');
                        const evidence = refs.map(id => this.state.evidence.find(item => item.id === id));
                        if (evidence.some(item => item === undefined))
                            throw new Error('Completion references evidence that was never observed.');
                        if (outcome !== 'blocked' && (hasBlockers() || this.state.unresolved.length > 0 || this.state.plan.some(item => item.status === 'pending') || this.state.nextActions.length > 0))
                            throw new Error('Unfinished work or blocking evidence remains. Continue, revise the plan honestly, or explain a blocker.');
                        if (outcome === 'answered' && this.state.evidence.some(item => item.action))
                            throw new Error('Actions require verified completion or an explicit blocker, not an answer-only outcome.');
                        if (outcome === 'completed' && (!evidence.some(item => item?.checkable && item.revision === (this.state.evidence.at(-1)?.revision ?? 0)) || (evidence.length === 0 || evidence.some(item => item?.failed || ['update_task', 'finish_task', 'consult_specialist'].includes(item?.tool ?? '')))))
                            throw new Error('Completed work requires successful direct tool evidence; notes and delegated claims alone are insufficient.');
                        this.state = parseTaskContext({ ...this.state, outcome, summary });
                        return { text: summary, isError: false };
                    } }],
        ]);
    }
}
/** Compact only complete old exchanges. Facts remain referenced; omitted text is never asserted as fully retained. */
export function compactTaskConversation(messages: MessageParam[], state: TaskContext, instructions: readonly MessageParam[]): boolean {
    if (messages.length <= 48)
        return false;
    // Opaque signed provider blocks cannot be reconstructed or summarized safely here.
    if (messages.some(message => Array.isArray(message.content) && message.content.some(block => !['text', 'tool_use', 'tool_result', 'image'].includes(block.type))))
        return false;
    let cut = messages.length - 32;
    while (cut < messages.length && (messages[cut]?.role !== 'assistant'))
        cut++;
    if (cut >= messages.length)
        return false;
    if (instructions.length === 0 || Buffer.byteLength(JSON.stringify(instructions)) > 100000)
        return false;
    const actions: MessageParam[] = [];
    for (let index = 0; index < cut; index++) {
        const message = messages[index];
        if (message?.role !== 'assistant' || !Array.isArray(message.content))
            continue;
        const consequential = message.content.some(block => block.type === 'tool_use' && state.evidence.some(item => item.action && (item.id === block.id || item.id.startsWith(block.id + '/'))));
        if (!consequential)
            continue;
        const result = messages[index + 1];
        if (result?.role !== 'user' || !Array.isArray(result.content) || !result.content.some(block => block.type === 'tool_result'))
            return false;
        // Keep exact action arguments and outcomes, including partial/uncertain results.
        // A digest of output alone cannot explain which consequential action already ran.
        actions.push(message, result);
    }
    const retained = messages.slice(cut);
    messages.splice(0, messages.length, ...instructions, { role: 'user', content: JSON.stringify({
            type: 'task_context_checkpoint', goal: state.goal,
            modelAuthoredNotesNotAuthority: { constraints: state.constraints, plan: state.plan, observations: state.observations, decisions: state.decisions, unresolved: state.unresolved, nextActions: state.nextActions },
            runtimeEvidence: state.evidence,
            limitation: 'Older raw exchanges were compacted. Excerpts and digests are references, not full results or new permissions. Reinspect source when detail is needed. Never blindly repeat recorded consequential actions.',
        }) }, ...actions, ...retained);
    return true;
}
