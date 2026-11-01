# Proposed voice launch policy

Status: the numerical launch limits below were explicitly approved by the owner on 2026-11-01. Registry definitions and all three plan allowances were applied atomically on the VPS and verified by a second dry run returning no changes. The API voice environment has not been activated. Provider privacy/cost attestations and purchases are not covered by the numerical approval. Every authenticated user on Free, Pro and Business should have access, subject to existing ownership/project grants and approvals. No anonymous voice access.

| LotusBuild plan | Monthly voice time per user | Maximum call | Concurrent calls per user |
| --- | --- | --- | --- |
| Free | 5 minutes | 5 minutes | 1 |
| Pro | 60 minutes | 10 minutes | 1 |
| Business | 180 minutes | 10 minutes | 1 |

Proposed initial deployment controls: two concurrent calls globally; 60 seconds of inactivity; 40 user turns per call; no automatic overage. A full capacity slot ends only audio, never an independent task. Calls also stop at their remaining plan allowance. Provider-side bursting should be disabled before launch so unrelated clients cannot silently consume burst pricing. No provider subscription upgrade is approved by this proposal.

Approved global monthly application allocation cap: GBP 100. This is an application admission allocation, not a guaranteed provider invoice cap. A matching acceptable provider-account spending boundary and an evidenced conservative per-call allocation are still required. The current implementation allocates the complete per-call amount at connection time, including reconnects, and retains uncertain allocations; minutes alone therefore do not promise an unlimited number of short calls. Each user's cost counter has the same GBP 100 ceiling: this creates no additional pool per user because every allocation is also charged atomically against the shared GBP 100 global ceiling. No smaller per-plan monetary allowance is invented.

Published public ElevenAgents hosting rates checked 2026-11-01: USD 0.08 per additional call minute, USD 0.16 when bursting; Realtime model input/cached-input/output tokens are charged separately. Gross hosting-only usage at the proposed monthly time limits would be USD 0.40 / 4.80 / 14.40 per fully consuming user before included subscription minutes, model tokens, tax and FX. These are not total-cost estimates or customer charges. Hosting subscription minutes are shared across the workspace, not granted separately to each LotusBuild user.

Sources: https://elevenlabs.io/pricing/agents and https://elevenlabs.io/docs/eleven-agents/customization/realtime-models . Private account/contract rates remain unverified. Do not substitute TTS rates for native realtime token charges.

## Technical configuration already reported by the owner

- Global environment, native Eleven Realtime v1 Max.
- Agent: agent_7301m6bnd36fe43rbrvah0dcmkkx.
- Reviewed published version: agtvrsn_6401m6bywrshe4fv4f5g54nv6876.
- Status client tool: tool_0001m6bttj8kf2mbepbryafg3zyg.
- Submit client tool: tool_9601m6btxes5f8p8qs3v16ghnkz3.

Server-side GETs using the privately entered existing key now authenticate successfully. Agent, both tools and workspace settings return HTTP 200. The reviewed immutable version passes the configuration validator after accepting the provider's exact hydrated copies of the attached client tools and its null no-argument parameter schemas. These API response shapes were verified live; unknown/modified/duplicate tools and nonempty schemas are still rejected. No provider configuration was modified.

Reviewed configuration fingerprint: `52978f42eac7eb75595faf5263d4d263e584efa98a6cbf708f5e8dc8324ef7b5`. This is not a credential. It covers the pinned agent configuration, both fetched tool definitions and inherited workspace settings. Regenerate and review it if any covered setting changes.

The account subscription read reports Starter, active, USD, `max_credit_limit_extension: 0`, and `can_extend_character_limit: false`. This confirms disabled usage-based overage at the time of the read, not a general provider invoice guarantee. The model-list endpoint did not include the native Realtime models, so it did not supply authoritative Max token rates for the per-call allocation.

Privacy remains unverified beyond the concrete configuration: the agent reports authentication enabled, ZRM enabled, recording disabled, Max selected and backup models disabled. The general official ZRM policy describes eligibility as selected Enterprise accounts, whereas the per-agent instructions describe the available toggle and Max support. The active subscription is Starter. Do not claim that successful GETs or the true toggle alone establish account eligibility, exact conversation-log/downstream retention coverage, or training opt-out. No privacy verification flags have been asserted.

Required evidence: provider confirmation that this Starter workspace's native Max API sessions are eligible and honor ZRM for audio, transcripts, conversation logs and any downstream processing, or an explicitly approved eligible agreement/revised retention policy. Separately verify account Data use training opt-out; the provider's official help page directs the owner to profile > Terms and privacy > Data use > disable Improve the models for everyone > Update your choice. Neither existing training settings nor applicable Max token prices were visible in the documented reads used here.

## Deployment preparation verified locally

The existing lotusbuild-vps SSH connection works. A read-only presence check on the API process environment file found neither ELEVENLABS_API_KEY nor ELEVENLABS_VOICE_CONFIG configured. No environment value, credential or provider config was printed or modified. The API key must be entered by the owner through a private server secret channel, never chat. Configure both application variables together after preparing the reviewed complete policy; a partial pair fails startup.

Frontend PR 36 is merged. Backend PR 45 is open and its CI passed; merging into the deployment branch can trigger production deployment and has not been performed as part of preparing this proposal. The registry and all three plan documents also need the approved capabilities and monthly counters; setting environment variables alone does not grant access. Existing plan and registry fields must be preserved.

The approved registry/plan change is implemented in `src/seed/enable-voice.ts`. It is dry-run by default; `--apply` validates registry and all three plans and updates only voice-bearing arrays in one Firestore transaction. Missing/unapproved plans, duplicate voice rows and conflicting existing voice definitions are refused. Run from the deployed release with `node --env-file=.env dist/seed/enable-voice.js` (dry run) or append `--apply` for the approved write. This utility does not configure ElevenLabs, insert privacy attestations, change plan prices or enable paid overage. The approved write was run using the compiled utility in the private maintenance directory, with import paths pointing to the existing deployed configuration/schema modules; the deployed application directory and services were not changed.

The private owner-run key entry helper is `/home/preet/.config/lotusbuild/enter-voice-key.sh`, invoked with an interactive SSH TTY. The owner has saved the existing key without echo into `/home/preet/.config/lotusbuild/elevenlabs-api-key` under restrictive permissions. The helper refuses to overwrite an existing file and makes no provider requests or service changes. The key was used only within the VPS process for fixed-host authenticated GETs and has not been printed, copied into chat or included in repository files.

Before activation, complete the provider-account cost/retention evidence and complete environment configuration. The manual helper is not required: the deployment operator can generate the configuration fingerprint server-side once the existing key is securely available. No calls or paid live verification have been started.
