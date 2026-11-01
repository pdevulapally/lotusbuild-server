import { createHash } from 'node:crypto';
import { WebSocket } from 'ws';
import type { VoiceAgentReference } from './config.ts';

export interface VoiceProvider {
  /** Read-only validation; does not start a paid conversation. */
  prepare(signal: AbortSignal): Promise<() => WebSocket>;
}
export const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid provider object.');
  return value as Record<string, unknown>;
};
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};
export function voiceAgentDigest(agent: Record<string, unknown>, tools: readonly unknown[], workspace: Record<string, unknown> = {}): string {
  return createHash('sha256').update(canonical({ conversation_config: agent['conversation_config'], platform_settings: agent['platform_settings'], workflow: agent['workflow'] ?? null, procedures: agent['procedures'] ?? null,
    tools: tools.map(value => { const tool = record(value); return { id: tool['id'], tool_config: tool['tool_config'] }; }), workspace })).digest('hex');
}

function noWebhooks(scope: Record<string, unknown>): void {
  if (scope['conversation_initiation_client_data_webhook']) throw new Error('Provider initiation webhooks are not permitted.');
  if (scope['webhooks'] !== undefined && scope['webhooks'] !== null && record(scope['webhooks'])['post_call_webhook_id']) throw new Error('Provider post-call webhooks are not permitted.');
}

/** Blank dashboard agents include a disconnected Start node, which performs no work. */
function noExecutableWorkflow(value: unknown): void {
  if (value === undefined || value === null) return;
  const workflow = record(value);
  if (Object.keys(workflow).some(key => !['nodes', 'edges', 'subgraphs', 'prevent_subagent_loops'].includes(key)) || Object.keys(record(workflow['edges'])).length ||
      (workflow['subgraphs'] !== undefined && Object.keys(record(workflow['subgraphs'])).length)) throw new Error('Unapproved workflow.');
  const nodes = Object.values(record(workflow['nodes']));
  if (nodes.length > 1) throw new Error('Unapproved workflow.');
  for (const value of nodes) {
    const node = record(value);
    if (node['type'] !== 'start' || Object.keys(node).some(key => !['type', 'position', 'edge_order', 'parent_subgraph_id'].includes(key)) ||
        !Array.isArray(node['edge_order']) || node['edge_order'].length || (node['parent_subgraph_id'] !== null && node['parent_subgraph_id'] !== undefined)) throw new Error('Unapproved workflow.');
    if (node['position'] !== undefined) {
      const position = record(node['position']);
      if (Object.keys(position).some(key => key !== 'x' && key !== 'y') || !Number.isFinite(position['x']) || !Number.isFinite(position['y'])) throw new Error('Invalid Start position.');
    }
  }
}

/** Fail before audio sharing if the pinned agent's privacy, tools or model drifted. */
export function validateVoiceAgent(raw: unknown, tools: readonly unknown[], config: VoiceAgentReference & { agentConfigSha256: string }, workspace: Record<string, unknown> = {}): void {
  const agent = record(raw), conversation = record(agent['conversation_config']), platform = record(agent['platform_settings']);
  if (agent['agent_id'] !== config.agentId || agent['version_id'] !== config.agentVersionId || conversation['realtime_model'] !== 'eleven_realtime_v1_max') throw new Error('Wrong agent version or non-approved realtime model.');
  const auth = record(platform['auth']), privacy = record(platform['privacy']);
  noWebhooks(workspace);
  if (platform['workspace_overrides'] !== undefined && platform['workspace_overrides'] !== null) noWebhooks(record(platform['workspace_overrides']));
  if (auth['enable_auth'] !== true || (Array.isArray(auth['allowlist']) && auth['allowlist'].length) || auth['shareable_token'] || privacy['zero_retention_mode'] !== true || privacy['record_voice'] !== false) throw new Error('Private zero-retention agent required.');
  const settings = record(conversation['conversation']);
  if (!Number.isSafeInteger(settings['max_duration_seconds']) || (settings['max_duration_seconds'] as number) < 1 || (settings['max_duration_seconds'] as number) > config.maxCallSeconds) throw new Error('Agent call duration is not bounded by policy.');
  // Tool calls are handled as protocol messages. The client-tool guide does not
  // require adding client_tool_call to this configurable subscription list.
  const requiredEvents = ['audio', 'interruption', 'user_transcript', 'agent_response', 'agent_response_correction', 'agent_response_complete'];
  if (!Array.isArray(settings['client_events']) || requiredEvents.some(type => !(settings['client_events'] as unknown[]).includes(type))) throw new Error('Required realtime events are missing.');
  if (record(conversation['agent'])['disable_first_message_interruptions'] === true) throw new Error('Voice must remain interruptible.');
  const prompt = record(record(conversation['agent'])['prompt']);
  if (!Number.isSafeInteger(prompt['max_tokens']) || (prompt['max_tokens'] as number) < 1024 || (prompt['max_tokens'] as number) > 4096 || record(prompt['backup_llm_config'])['preference'] !== 'disabled') throw new Error('Bounded output and disabled model cascading required.');
  const toolIds = prompt['tool_ids'];
  if (!Array.isArray(toolIds) || toolIds.length !== 2 || !toolIds.includes(config.statusToolId) || !toolIds.includes(config.submitToolId)) throw new Error('Only the two LotusBuild bridge tools may be attached.');
  for (const field of ['tools', 'mcp_server_ids', 'native_mcp_server_ids', 'knowledge_base']) if (Array.isArray(prompt[field]) && (prompt[field] as unknown[]).length) throw new Error('Provider-side tools, MCP and knowledge bases are not permitted.');
  const builtins = prompt['built_in_tools'];
  if (builtins && Object.values(record(builtins)).some(value => value !== null && value !== undefined)) throw new Error('Unapproved built-in tools.');
  noExecutableWorkflow(agent['workflow']);
  if (agent['procedures'] && Object.keys(record(agent['procedures'])).length) throw new Error('Unapproved procedures.');
  if (conversation['language_presets'] && Object.keys(record(conversation['language_presets'])).length) throw new Error('Unapproved language overrides.');
  const overrides = record(record(platform['overrides'])['conversation_config_override']);
  if (record(record(overrides['agent'])['prompt'])['prompt'] !== true) throw new Error('Server prompt override must be enabled.');
  for (let i = 0; i < tools.length; i++) {
    const tool = record(tools[i]), definition = record(tool['tool_config']);
    const expected = i === 0 ? config.statusToolId : config.submitToolId;
    const name = i === 0 ? 'lotus_task_status' : 'lotus_submit_request';
    const parameters = definition['parameters'] === undefined ? {} : record(definition['parameters']);
    // The provider's custom schema omits JSON Schema additionalProperties. Strict empty arguments are enforced by our dispatcher.
    if (tool['id'] !== expected || definition['type'] !== 'client' || definition['name'] !== name || definition['expects_response'] !== true || definition['pre_tool_speech'] !== 'off' || definition['interruption_mode'] !== 'allow' || (parameters['type'] !== undefined && parameters['type'] !== 'object') || (parameters['properties'] !== undefined && Object.keys(record(parameters['properties'])).length) || (parameters['required'] !== undefined && (!Array.isArray(parameters['required']) || parameters['required'].length))) throw new Error('Bridge tools must be interruptible client tools without arguments.');
  }
  if (tools.length !== 2 || voiceAgentDigest(agent, tools, workspace) !== config.agentConfigSha256) throw new Error('The agent configuration has not been audited.');
}

/** Server-owned TLS connection; signed URLs are single-use and never exposed to a browser. */
export class ElevenLabsRealtime implements VoiceProvider {
  private readonly key: string;
  private readonly config: VoiceAgentReference & { agentConfigSha256?: string };
  private get host() { return this.config.environment === 'eu' ? 'api.eu.residency.elevenlabs.io' : 'api.elevenlabs.io'; }
  constructor(key: string, config: VoiceAgentReference & { agentConfigSha256?: string }) { this.key = key; this.config = config; }
  async #get(path: string, signal: AbortSignal): Promise<unknown> {
    const response = await fetch(`https://${this.host}${path}`, { headers: { 'xi-api-key': this.key }, signal, redirect: 'error' });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('ElevenLabs configuration is unavailable.'); }
    let size = 0; const chunks: Uint8Array[] = [];
    for await (const chunk of response.body) { size += chunk.length; if (size > 256 * 1024) throw new Error('Oversized provider configuration.'); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
  }
  /** Safe read-only operator audit. No signed URL or conversation is created. */
  async audit(signal: AbortSignal): Promise<{ digest: string; matchesPinnedDigest: boolean }> {
    const cfg = this.config;
    const [agent, status, submit, workspace] = await Promise.all([
      this.#get(`/v1/convai/agents/${encodeURIComponent(cfg.agentId)}?version_id=${encodeURIComponent(cfg.agentVersionId)}`, signal),
      this.#get(`/v1/convai/tools/${encodeURIComponent(cfg.statusToolId)}`, signal),
      this.#get(`/v1/convai/tools/${encodeURIComponent(cfg.submitToolId)}`, signal),
      this.#get('/v1/convai/settings', signal),
    ]);
    const digest = voiceAgentDigest(record(agent), [status, submit], record(workspace));
    validateVoiceAgent(agent, [status, submit], { ...cfg, agentConfigSha256: digest }, record(workspace));
    return { digest, matchesPinnedDigest: digest === cfg.agentConfigSha256 };
  }
  async prepare(signal: AbortSignal): Promise<() => WebSocket> {
    const cfg = this.config;
    if (!cfg.agentConfigSha256 || !/^[a-f0-9]{64}$/.test(cfg.agentConfigSha256)) throw new Error('The agent configuration has not been audited.');
    if (!(await this.audit(signal)).matchesPinnedDigest) throw new Error('The agent configuration has not been audited.');
    const result = record(await this.#get(`/v1/convai/conversation/get-signed-url?${new URLSearchParams({ agent_id: cfg.agentId, version_id: cfg.agentVersionId, include_conversation_id: 'true' })}`, signal));
    if (typeof result['signed_url'] !== 'string') throw new Error('Missing authenticated provider URL.');
    const url = new URL(result['signed_url']);
    if (url.protocol !== 'wss:' || url.hostname !== this.host || url.port || url.username || url.password || url.pathname !== '/v1/convai/conversation' || url.searchParams.get('agent_id') !== cfg.agentId || !url.searchParams.get('conversation_signature')) throw new Error('Invalid provider connection URL.');
    let used = false;
    return () => { if (used || signal.aborted) throw new Error('Provider access already used or expired.'); used = true; return new WebSocket(url, { handshakeTimeout: 8000, maxPayload: 256 * 1024, followRedirects: false }); };
  }
}
