import type Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlockParam,
  MessageParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/messages';

import type { Registry, SandboxProvider } from '../entitlements/schema.ts';
import type { UserEntitlements } from '../entitlements/service.ts';
import type { MeteringService } from '../metering/service.ts';
import type { Project } from '../projects/repository.ts';
import type { RunningSandbox } from '../sandboxes/provider.ts';
import type { BuildSession, SessionMessage } from '../sessions/repository.ts';
import { type ToolContext, runTool, toolSpecs, truncate } from './tools.ts';

export interface AgentLimits {
  readonly maxSteps: number;
  readonly maxOutputTokens: number;
  readonly toolOutputMaxChars: number;
  readonly commandTimeoutMs: number;
  readonly previewReadyTimeoutSeconds: number;
}

export interface AgentEvents {
  text(delta: string): void;
  toolCall(name: string, input: Record<string, unknown>): Promise<void>;
  toolResult(name: string, result: { text: string; isError: boolean }): Promise<void>;
  preview(preview: { url: string; port: number }): Promise<void>;
  step(step: { number: number; of: number }): Promise<void>;
}

export interface AgentRun {
  /** Everything the model said, for the transcript. */
  readonly reply: string;
  readonly steps: number;
  readonly stopReason: string;
}

/**
 * Composes the system prompt from configuration rather than from a literal here.
 *
 * The sandbox-specific half is `agentInstructions` on the provider row — how to
 * scaffold, which server to start, what not to install. That is where product
 * knowledge belongs: changing how mobile builds are told to work must not need
 * a deploy.
 */
function systemPrompt(project: Project, provider: SandboxProvider): string {
  return [
    `You are building a ${project.platform} application for a user of LotusBuild.`,
    `The project is called "${project.name}".`,
    project.description === undefined ? undefined : `The user describes it as: ${project.description}`,
    `You are working in a sandbox at ${provider.workdir}, which is the project directory and the`,
    'working directory for every command. It is yours alone and is discarded when the session ends.',
    '',
    provider.agentInstructions,
    '',
    'Work in small steps and check your work as you go. When you have finished what was asked,',
    'stop and say what you did. Do not ask the user questions you can answer by looking at the',
    'project yourself.',
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
}

/** Firestore's transcript, as the model's conversation. */
function conversationFrom(messages: readonly SessionMessage[]): MessageParam[] {
  return messages.map((message) => ({ role: message.role, content: message.content }));
}

/**
 * Runs one turn: the model, its tools, and the sandbox, until it stops asking
 * for tools or runs out of the steps it is allowed.
 *
 * Token cost is charged after each call rather than estimated before it, so a
 * turn can overrun its allowance by at most one call's output ceiling — the
 * charge for call N is what refuses call N+1. Reserving instead would mean
 * holding the maximum for a call that usually costs a fraction of it, and
 * refusing users who would never have reached the limit.
 */
export async function runAgentTurn(input: {
  readonly anthropic: Anthropic;
  readonly session: BuildSession;
  readonly project: Project;
  readonly provider: SandboxProvider;
  readonly sandbox: RunningSandbox;
  readonly messages: readonly SessionMessage[];
  readonly entitlements: UserEntitlements;
  readonly registry: Registry;
  readonly metering: MeteringService;
  readonly limits: AgentLimits;
  readonly events: AgentEvents;
  /** Throws if the lease is gone, so a stolen session stops between steps. */
  readonly assertStillOurs: () => void;
}): Promise<AgentRun> {
  const conversation = conversationFrom(input.messages);
  const system = systemPrompt(input.project, input.provider);
  const toolContext: ToolContext = {
    sandbox: input.sandbox,
    provider: input.provider,
    commandTimeoutMs: input.limits.commandTimeoutMs,
    previewReadyTimeoutSeconds: input.limits.previewReadyTimeoutSeconds,
    onPreview: input.events.preview,
  };

  const spoken: string[] = [];

  for (let step = 1; step <= input.limits.maxSteps; step += 1) {
    input.assertStillOurs();
    await input.events.step({ number: step, of: input.limits.maxSteps });

    const stream = input.anthropic.messages.stream({
      // From the session, which took it from the plan's allowlist. Never a
      // literal: which model a plan may use is a commercial decision.
      model: input.session.model,
      max_tokens: input.limits.maxOutputTokens,
      system,
      tools: [...toolSpecs],
      messages: conversation,
    });
    stream.on('text', input.events.text);
    const message = await stream.finalMessage();

    // Charged before anything else happens with the response: a turn that
    // crashes mid-step still used the tokens it used.
    for (const [meterKey, quantity] of [
      [input.registry.inputTokenMeterKey, message.usage.input_tokens],
      [input.registry.outputTokenMeterKey, message.usage.output_tokens],
    ] as const) {
      if (quantity > 0) {
        await input.metering.consume({
          uid: input.session.ownerUid,
          entitlements: input.entitlements,
          meterKey,
          quantity,
          now: new Date(),
        });
      }
    }

    const said = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    if (said !== '') {
      spoken.push(said);
    }

    const toolUses = message.content.filter(
      (block): block is ToolUseBlock => block.type === 'tool_use',
    );
    if (toolUses.length === 0) {
      return {
        reply: spoken.join('\n\n'),
        steps: step,
        stopReason: message.stop_reason ?? 'end_turn',
      };
    }

    conversation.push({ role: 'assistant', content: message.content });

    const results: ContentBlockParam[] = [];
    for (const toolUse of toolUses) {
      const toolInput = (toolUse.input ?? {}) as Record<string, unknown>;
      await input.events.toolCall(toolUse.name, toolInput);
      const result = await runTool(toolUse.name, toolInput, toolContext);
      await input.events.toolResult(toolUse.name, result);
      results.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: truncate(result.text, input.limits.toolOutputMaxChars),
        is_error: result.isError,
      });
    }
    conversation.push({ role: 'user', content: results });
  }

  // Out of steps with the model still working. Reported rather than hidden: the
  // user's app is half built and they need to know why it stopped.
  return {
    reply: spoken.join('\n\n'),
    steps: input.limits.maxSteps,
    stopReason: 'max_steps',
  };
}
