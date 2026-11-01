import type { BuildSession } from '../sessions/repository.ts';
import type { SessionEvent } from '../sessions/events.ts';

export const voicePrivacyNotice = 'Your live audio and recent project conversation are sent to your configured ElevenLabs realtime agent. LotusBuild saves final voice dialogue as project chat context, not audio. Submitted work uses the same task providers, tools and permissions as text. Voice requires verified provider and downstream privacy coverage. Approvals and task cancellation use the on-screen controls. End the call to stop audio sharing; accepted work continues.';

/** Facts from durable state, without promising tool success or interpreting model-authored claims. */
export function voiceTaskStatus(session: Pick<BuildSession, 'status' | 'pendingInput' | 'cancelRequested' | 'fallback'>): string {
  if (session.cancelRequested) return 'Cancellation was requested. Work may still be stopping. Actions already sent may have completed.';
  if (session.pendingInput?.kind === 'approval') return 'Your approval is needed. Review the exact action and use the on-screen Approve or Reject controls.';
  if (session.pendingInput?.kind === 'question') return session.pendingInput.prompt;
  if (session.fallback && session.fallback.status !== 'COMPLETED') return 'The task is paused or waiting for capacity. Review the continuation options on screen.';
  return { QUEUED: 'Your task is queued.', RUNNING: 'Your task is running. You can add a clarification while it works.',
    IDLE: 'This turn has stopped. Review the response and any checks in the chat.', FAILED: 'The task stopped with a problem. Review the details in the chat.' }[session.status];
}

/** Only factual activity labels. Tool arguments, outputs, external text and model claims never become progress speech. */
export function voiceProgress(event: SessionEvent): string | undefined {
  const lifecycle: Readonly<Record<string, string>> = {
    'project.saved': 'The project files have been saved.',
    'project.save_failed': 'Saving reported a problem. Review the details in chat.',
    'preview.ready': 'The preview is available.',
  };
  if (lifecycle[event.type]) return lifecycle[event.type];
  if (event.type === 'agent.tool_result' && event.data['isError'] === true) return 'A tool call reported a problem. Details are in the chat.';
  if (event.type !== 'agent.tool_call') return undefined;
  const tools: Readonly<Record<string, string>> = {
    read_file: 'I am looking through the project files.', write_file: 'I am updating a project file.',
    edit_file: 'I am editing a project file.', run_command: 'A command is being run in the workspace.',
  };
  return typeof event.data['name'] === 'string' ? tools[event.data['name']] : undefined;
}

export type VoiceCommand = { type: 'interrupt' } | { type: 'end' };
export function parseVoiceCommand(value: unknown): VoiceCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid voice command.');
  const record = value as Record<string, unknown>;
  if ((record['type'] === 'interrupt' || record['type'] === 'end') && Object.keys(record).length === 1) return record as VoiceCommand;
  throw new Error('Invalid voice command.');
}
