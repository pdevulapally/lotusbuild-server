# Native realtime voice for LotusBuild

Voice requires explicit activation policy and provider secrets. The owner reports the private native agent published and has approved launch allowances for all three plans; those registry/plan allowances were applied and read back on 2026-11-01. API activation, provider cost/privacy verification and live voice verification remain outstanding. See `voice-activation-proposal.md` for the approved numerical limits and current operational status. The earlier STT/TTS adapter and illustrative audio-only cost table are superseded.

## Architecture

The browser streams bounded mono PCM16 to the authenticated LotusBuild WebSocket and plays negotiated PCM output. The backend connects to a pinned private **ElevenAgents Realtime** agent using native fetch and the existing `ws` dependency. The live voice model handles conversation and natural turns; every utterance does not automatically become a build request.

Exactly two argument-free provider **client tools** are attached and executed on the server relay:

- `lotus_task_status`: current owned task state, pending question/approval kind and bounded recent chat.
- `lotus_submit_request`: actual latest captured user utterance through the existing authenticated `POST /sessions/:id/messages` route. No model-supplied prompt substitution, identity, project, model, grant or approval is accepted. The server supplies a pending question's identity. Approval and saved-checkpoint continuation require existing UI controls.

The HTTP boundary rechecks Firebase auth, verified email, ownership/project access, permissions, rate limits, admission, metering and durable idempotency receipts. The existing runner executes development tools and MCP integrations. No separate execution pipeline, provider-hosted MCP, knowledge base, webhook action or workflow is created. Existing safe-point steering preserves accepted clarifications within its bounds.

Final voice dialogue shares the existing project chat as explicit voice notes. Voice assistant messages are never worker/tool completion evidence; all voice notes are marked non-executable context for the runner. Separately admitted task commands carry actual instructions. Notes do not change the execution count used to validate durable checkpoints. Text and voice use the same session without starting another task.

Pre-tool speech is disabled and audio is suppressed while a bridge tool runs. Acceptance results say `completionVerified: false`; status/progress uses backend facts rather than raw tool content. Native model wording still needs live evaluation: instructions do not prove perfect model compliance.

## Security and recovery

Firebase tokens go only in the first WebSocket frame, not URLs/subprotocols. The server checks origins, payload/rate bounds, access, plans and leases; revocation/access/entitlements are rechecked every five seconds. Every task command independently traverses the existing HTTP authorization boundary. Speech recognition is never identity.

Before paid connection, read-only agent/tool/workspace GETs validate the pinned version, audited SHA-256 configuration, private authentication, Zero Retention Mode, no recordings, native model, bounded duration/output and exactly two client tools. The live agent GET also expands these attached tool IDs into `prompt.tools`; expanded entries are accepted only as exact, unique copies of the separately fetched tool definitions. Unknown, modified or duplicate definitions remain refused even with a matching digest. Agent and inherited workspace initiation/post-call webhooks are rejected; workspace settings are included in the reviewed digest. Use a suitably isolated workspace if other agents need those callbacks. Signed access uses `include_conversation_id=true`, documented as single use. Signed URLs, provider keys and persistent session tokens stay server-side; fixed TLS host/path and disabled redirects prevent destination substitution.

Provider tool events arrive only on the server-owned authenticated TLS socket. No incoming HTTP tool/webhook endpoint exists, so no invented webhook signature scheme is needed. Unknown tools, arguments, malformed frames and conflicting replay fail closed. Restrict provider administration: shared tool definitions must not be edited behind the reviewed configuration.

One task/conversation/user-event identity fences multiple tool calls for the same utterance; durable HTTP receipts survive API replacement. Uncertain outcomes are retained without blind retry. Reconnection restores actual task state/history but starts with no fresh executable utterance, so history and progress notifications cannot replay work.

- **Stop speech** immediately clears local playback and suppresses the current response; tools/tasks continue. Natural barge-in uses provider interruption events. There is no undocumented upstream cancel-generation message. Local silence does not promise to stop provider token generation.
- **Mute** disables the microphone track; time and idle limits continue.
- **End call**, hiding the page or leaving it closes capture/playback, provider socket, subscription and lease. Accepted task work continues independently.
- **Cancel task** and consequential **Approve/Reject** remain separate authenticated, action-bound UI commands. Spoken agreement cannot approve.
- Unexpected transport failures get at most three bounded reconnect attempts with fresh authentication/task refresh. Gap audio is discarded, never replayed. Privacy/expiry/quota/time-limit failures require explicit restart.

## Limits and costs

Activation requires explicit registry capabilities `voice.enabled` (boolean), `voice.concurrent` (integer 1–10), `voice.call.seconds` (positive integer). The approved voice-only migration adds these without re-seeding existing configuration. Call duration is the lower of plan and deployment ceilings.

Add monthly COUNTER meters `voice.seconds` and `voice.cost.microgbp`, with explicit per-plan allowances/hard limits and **overage disabled**. Seconds are prepaid in up-to-ten-second windows, including silence. The full approved worst-case per-call cost allocation is consumed before each conversation, including reconnects. Existing metering batches both counters atomically with the Firestore global allocation/dispatch claim. Failed/uncertain dispatches conservatively retain allocation. These are budgets, not Stripe charges or exact invoices.

`globalMonthlyMicroGbp` atomically limits allocations across users/replicas, **not an independently proven provider invoice**. Native realtime charges agent minutes plus input/cached/output model tokens. The operator must approve `maxCallMicroGbp`, conservative contract/FX/token assumptions and acceptable provider-account spending controls. If an enforceable spending boundary is unavailable, report that limitation and leave voice disabled. No unit rates are invented.

Redis server-time leases enforce global/per-user concurrency, expire after 20 seconds and renew every five. Local audio authority expires within ten seconds without renewal. Hard call/idle/auth/provider-connect timeouts, turn/tool counts, buffer/byte bounds, realtime upload limits and control-rate limits bound abandoned/abusive sessions. Task work retains the runner's separate lifecycle.

### Approved initial plan allowances

| Existing plan | Monthly voice allowance | Maximum call / concurrent calls per user |
|---|---|---|
| Free | 5 minutes | 5 minutes / 1 |
| Pro | 60 minutes | 10 minutes / 1 |
| Business | 180 minutes | 10 minutes / 1 |

The owner approved a shared GBP 100 monthly application allocation cap, two concurrent calls globally and a 60-second inactivity timeout. Each plan's cost counter uses that same ceiling; it does not create a separate GBP 100 pool per user. No overage is enabled. These admission allocations are not a guaranteed provider invoice cap. Estimate actual cost as `minutes × contracted agent rate + input tokens × input rate + cached tokens × cached rate + output tokens × output rate`, explicitly accounting for FX/tax/fees/subscription minimums. Task model/sandbox/MCP costs stay separate. Per-call allocation `C` also bounds admitted calls by `floor(B/C)` and remaining global allocation. Provider rates, the conservative per-call allocation and acceptable account spending controls still require verification.

## ElevenLabs and VPS configuration

Leave **both** variables absent to keep voice disabled; partial configuration fails startup:

- `ELEVENLABS_API_KEY`: server secret restricted to required agent/tool/workspace-settings reads and authenticated conversation access. Restrict administration and configure approved spending controls. Never place in `NEXT_PUBLIC_`, chat, prompts or logs.
- `ELEVENLABS_VOICE_CONFIG`: strict application policy JSON with every field below. The dashboard does not automatically supply this object.

| Field | Value source |
|---|---|
| `environment` | Explicit `global` or `eu`; EU uses its separately eligible workspace/key, never an automatic fallback |
| `agentId`, `agentVersionId` | Selected agent and reviewed immutable published version, after separate publication approval |
| `statusToolId`, `submitToolId` | IDs of the two client tools |
| `agentConfigSha256` | Reviewed digest from read-only audit below |
| `privacyVersion` | Approved consent-notice identifier |
| `maxCallSeconds`, `idleSeconds` | Approved ceilings; call ≤1800 seconds, idle ≤call |
| `maxConnections`, `maxTurns` | Approved global connection/per-call turn ceilings; maxima 1000/100 |
| `maxCallMicroGbp`, `globalMonthlyMicroGbp` | Approved per-call/global monthly allocations, positive integer millionths of GBP |
| `zeroRetentionVerified`, `downstreamZeroRetentionVerified` | True only after exact account/model/region/downstream coverage is evidenced |
| `providerSpendingLimitVerified` | True only after acceptable spending controls and cost assumptions are verified |

Owner decision 2026-11-01: the separate workspace training-opt-out requirement (`trainingOptOutVerified`) was removed from this policy at the owner's explicit request, with zero-retention coverage still required. The workspace's "Improve the models for everyone" setting was left as the owner found it; it is no longer gated by this config.

Prepare the current **unpublished** dashboard draft without publishing or Preview-calling it:

1. Name LotusBuild Voice; Voice mode **Realtime**; **Eleven Realtime v1 Max**; owner's licensed voice/language. Max supports ZRM in US/EU; Mini does not. Realtime manages ASR/LLM/TTS, so the old Custom LLM selector is not used. Set an AI-disclosing first message, for example: "Hi, I'm LotusBuild's AI assistant. What would you like to work on?"
2. Require authentication; no public/shareable access. Enable per-agent Zero Retention Mode, disable recordings and backup LLM cascading. Verify account eligibility and exact audio/transcript/conversation-log/all downstream coverage. No recording/analytics/transcript webhooks.
3. Output token limit 1024–4096; bounded duration; interruptible first message/turns; client events `audio`, `interruption`, `user_transcript`, `agent_response`, `agent_response_correction`, `agent_response_complete`. Optional VAD events improve idle detection. The backend handles `client_tool_call` protocol messages; adding it to the selectable event list is not an audit prerequisite. The [client-tool guide](https://elevenlabs.io/docs/eleven-agents/customization/tools/client-tools) requires attached tools and handlers, while the [event guide](https://elevenlabs.io/docs/eleven-agents/customization/events/client-events) explicitly requires enabling response-completion events. Actual native tool delivery still requires an approved live test; mocked dispatch is not provider verification.
4. Exactly two client tools: `lotus_task_status` and `lotus_submit_request`, expecting response, pre-tool speech **off**, interruption **allow**, empty object parameters/no properties or required arguments. Descriptions distinguish checked status from exact-current-utterance submission; neither approves/cancels.
5. Enable system-prompt override. Server supplies safety instructions/current context at connection initiation. No browser prompt/identity override. Leave provider KB/workflows/procedures/language overrides/hosted MCP/built-in actions absent. Hosted MCP is unavailable with ZRM; existing LotusBuild MCP stays in its runner.
6. Audit the published version read-only before preparing an activation policy. Put only `environment`, `agentId`, `agentVersionId`, `statusToolId`, `submitToolId`, `maxCallSeconds` in a non-secret JSON reference file. The duration here is the reviewed provider configuration ceiling, not approval of a plan allowance. No privacy/spending attestations or dummy digest are needed:

   `node --experimental-strip-types src/voice/audit.ts --reference-file <reference.json>`

   Supply the existing `ELEVENLABS_API_KEY` through the approved process environment/secret store. This utility performs only agent/tool/workspace-settings GETs and prints digest/match boolean. Without a pin, `matchesPinnedDigest` is false by design. It never requests signed access, opens a conversation, prints raw config or publishes anything. It has **not** been run against the owner's account. After separate privacy/cost approval, explicitly review and pin the digest in the full activation policy; never auto-accept drift. The original no-argument mode audits an existing complete `ELEVENLABS_VOICE_CONFIG` policy.

## Data and observability

ElevenLabs receives live audio, bounded recent project conversation/current state, server instructions and restricted tool results. Recent chat can contain confidential/personal project data; consent discloses this sharing. Accepted work uses the same downstream task providers as text. No raw audio persists in LotusBuild; bounded memory buffers are discarded at call end and never replayed.

Final dialogue is retained as project chat after per-call consent under existing access/export/privacy-request/deletion mechanisms. Project deletion recursively removes session messages; account erasure uses the existing reviewed privacy workflow. Until deletion notes remain project chat, not a promise of automatic timed erasure. End call stops sharing; withhold consent/use text to avoid another call. Provider zero retention and training policy are distinct. Deployment flags are operator attestations, not proof of eligibility/compliance.

No sensitive transcript/debug logs. New logs contain random call ID, bounded event/tool names, connection/turn/tool latency, close reason, duration/bytes and replay indicators; no tokens, keys, signed URLs, prompts, transcripts, audio or raw provider error bodies. Ledgers hold quantities/allocation claims, not conversation content. Reconcile budgets with provider billing separately.

If exact required retention coverage is unavailable, report alternatives for owner decision: eligible enterprise agreement/region, another suitable provider, or a separately approved revised policy. Never silently enable standard retention.

## Verification and activation gates

Native revision: backend typecheck/build and 139 targeted voice/task/approval/cancellation/recovery/history/storage/admission tests; frontend typecheck, 102 contracts and production build pass. Local real Fastify HTTP/WebSocket transport is tested with mocked provider/auth/datastore. The broad Windows run before three final regression cases had 800 tests, 691 passed, 108 failed, one skipped; the previously verified baseline also had 108 Windows failures. Linux CI must verify this revision; the Windows suite is not reported as green.

Mocks cover native tool submission, duplicates/concurrency/replay, exact speech, pending questions, approval/continuation refusal, API replacement, cancellation, auth/ownership/expiry denial, privacy/configuration rejection, outages, interruptions, bounded reconnect/no replay, call/idle limits and atomic allocations. Documented provider fixtures are not proof of account compatibility.

Rendering/synthetic AudioWorklet checks use desktop headless Chrome and a 390px mobile viewport, not physical microphones. Live ElevenLabs/account privacy, Redis multi-replica runtime, authenticated production browser flow, billing reconciliation, real iOS/Android mic/echo/background/network handoff and end-to-end latency remain unverified. Run only after relevant approval; do not label this production-verified before those gates pass.

## Official references verified 1 November 2026

- [Realtime models, pricing and ZRM compatibility](https://elevenlabs.io/docs/eleven-agents/customization/realtime-models)
- [WebSocket protocol and client tools](https://elevenlabs.io/docs/eleven-agents/api-reference/eleven-agents/websocket)
- [Single-use private access](https://elevenlabs.io/docs/api-reference/conversations/get-signed-url)
- [Authentication](https://elevenlabs.io/docs/eleven-agents/customization/authentication)
- [Zero Retention Mode](https://elevenlabs.io/docs/eleven-agents/customization/privacy/zrm)
- [Data residency and isolated API/WebSocket environments](https://elevenlabs.io/docs/overview/administration/data-residency)
- [Workspace settings and inherited callbacks](https://elevenlabs.io/docs/api-reference/workspace/get)
