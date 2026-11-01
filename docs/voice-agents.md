# ElevenLabs voice for the existing LotusBuild agent

Status: local implementation, disabled by default. No provider account, keys, agent, paid evaluation, registry migration or production deployment was created. Configuration and policy approval are separate activation steps.

## Architecture and boundaries

Voice is another input/output surface for an existing owned session. It does not create a voice task, model loop, tool registry, approval store or MCP client. Realtime Scribe transcribes audio; committed text goes through the existing authenticated `/sessions/:id/messages` route and its durable mutation receipt. While work is running it uses the existing safe-point steering mechanism. Several accepted clarifications are now preserved together within its existing length/attachment bounds, rather than overwriting earlier accepted instructions. Text and voice share project guards, task context, queued work, model entitlements, approvals, resource reservations and cancellation.

The API relays audio using server-only ElevenLabs authentication. Browsers receive no ElevenLabs key, signed URL, agent credentials or long-lived provider access. Firebase authentication is sent in the first WebSocket frame, never the URL, and rechecked with revocation checking during the call. Ownership and plan permissions are checked before microphone permission and again on socket admission. The relay accepts only PCM, stop-speech, end-call, and requests to read server-selected status/completed messages. It cannot execute a provider tool, accept an approval, change grants or cancel a task. No provider tool webhook is registered; unsolicited callbacks have no voice command endpoint. This design therefore has no incoming provider webhook signature or replay-authentication contract to invent.

The existing runner remains autonomous after the audio connection ends. Spoken acknowledgments are requested after HTTP acceptance, and progress uses factual runtime event labels. A tool call is never described as successful from its name, input, or model claims. Completed assistant responses are read from owned durable chat after the turn becomes idle; their accuracy follows the same evidence and completion rules as text. Raw tool output and code blocks are not read aloud. No independent voice model generates success claims.

## Current documentation checked on 1 November 2026

- [Realtime transcription API](https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime): authenticated server WebSocket, `scribe_v2_realtime`, mono PCM16, VAD commits, partial/final transcripts, errors and privacy warnings.
- [Commit strategies](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/transcripts-and-commit-strategies): microphone VAD and bounded audio chunks. The documented initial audio buffer means the advertised model latency is not an end-to-end conversational latency guarantee.
- [Streamed speech API](https://elevenlabs.io/docs/api-reference/text-to-speech/stream): HTTP streaming, configured voice/model and PCM output. The existing `ws` package and native fetch implement these small documented protocols; no extra provider SDK or provider LLM is needed.
- [Authentication for ElevenAgents](https://elevenlabs.io/docs/eleven-agents/customization/authentication): private browser agents can use short-lived signed access. This implementation uses server-relayed audio APIs instead of creating a separate ElevenAgents conversation.
- [Zero retention](https://elevenlabs.io/docs/eleven-api/resources/zero-retention-mode): eligibility and covered endpoint payloads; account verification remains required.
- [Training/data use](https://elevenlabs.io/docs/help-center/legal/is-my-data-used-to-improve-eleven-labs-ai-models): training policy is a separate question.

## Controls, recovery and approvals

- Stop speech aborts synthesis and immediately stops local buffered playback. Generation fencing rejects stale audio. It does not stop tools or task execution.
- Mute disables the microphone track; silence frames keep transport alive until the idle/time limit. No spoken audio is captured from a disabled track.
- End call closes capture, playback, upstream synthesis/transcription, event subscription, timers and the concurrency lease. It does not cancel accepted work. Browser hiding/page exit also ends capture.
- Cancel task uses the existing authenticated UI command and mutation identity. Already dispatched external effects can have uncertain outcomes; ending audio never replays them.
- Consequential approvals remain on screen, bound to the existing pending request and approval controls. Spoken recognition is not identity or consent to an external operation. A pending approval cannot be answered by the voice transcript path.
- Unexpected audio disconnects get at most three bounded reconnect attempts, fresh authentication and a canonical task refresh. No captured audio or historical utterance is replayed. Partial words during a gap are discarded and the UI says to repeat them. Expiry, privacy rejection, usage limits and normal timeouts require an explicit new call.
- HTTP acceptance uncertainty retains the original text-command identity, prompt and steering flag across reloads. It stops automatic voice submission; subsequent unsent words remain visible for review. Call ending does not cancel an HTTP request already sent.

## Metering, limits and cost cap

Activation must add explicit capabilities to the existing registry/plan system: `voice.enabled` (boolean), `voice.concurrent` (finite number, maximum 10), and `voice.call.seconds` (finite number). No values have been written. User call time is the lower of the plan allowance and deployment ceiling. Missing fields fail explicitly.

Add existing-style monthly COUNTER meters `voice.seconds` and `voice.characters` and a hard limit for each eligible plan, with overage disabled. No free or paid tier receives an inferred allowance. Voice uses `MeteringService.consumeIn` in the same Firestore transaction as the platform spend claim. Missing meters or permissive overage settings refuse dispatch.

Seconds are admitted in bounded, prepaid windows of up to 10 seconds, including silence; characters are consumed before a synthesis request. Unused or uncertain dispatch allowance is conservatively consumed, not refunded or charged to Stripe. The UI must not present these counters as an exact ElevenLabs invoice. The global monthly GBP estimate cap is durable and atomic across users/processes. It uses configured conservative unit rates, rounded up per dispatch. Claims fence duplicate paid dispatches. A crash cannot leave an indefinitely open billing reservation. This cap bounds estimates for voice calls made through this backend; it cannot bound unrelated use of the same provider account or unapproved/changed provider prices. Configure the provider's own hard spending controls too.

Redis server-time leases atomically limit concurrent calls across API instances. Leases expire after 20 seconds, renew every 5 seconds, and local audio authority expires after 10 seconds without renewal. Slow consumers, oversized audio, faster-than-realtime upload, input beyond prepaid seconds, control-message floods and excessive synthesis are refused. Calls have absolute lifetime, idle, authentication and synthesis timeouts. API shutdown closes them. No recording continues indefinitely after a browser disappears.

## Required provider/deployment configuration

Keep both variables absent to keep voice disabled:

- `ELEVENLABS_API_KEY`: server secret with only the required STT/TTS permissions and approved spending controls. Do not add it to public environment variables, a prompt, chat or logs.
- `ELEVENLABS_VOICE_CONFIG`: one strict JSON object containing every field below; unknown fields fail validation.

| Field | Required value/meaning |
|---|---|
| `voiceId` | Owner-selected, licensed voice ID verified in the provider account |
| `ttsModel` | Account-available low-latency speech model, verified against its model catalogue |
| `maxCallSeconds` | Approved deployment ceiling, at most 1800 seconds |
| `idleSeconds` | Approved inactivity timeout, no higher than call ceiling |
| `maxConnections` | Approved global concurrency ceiling, at most 1000 |
| `maxSpeechCharacters` | Approved per-call synthesis ceiling, at most 20000 |
| `globalMonthlyMicroGbp` | Approved global monthly voice estimate cap, integer millionths of GBP |
| `sttMicroGbpPerMinute` | Approved conservative contracted cost rate, including applicable minimums/FX/fees |
| `ttsMicroGbpPerThousandCharacters` | Same, per thousand speech characters |
| `privacyVersion` | Version of the owner-approved consent notice, letters/digits/underscore/hyphen |
| `zeroRetentionVerified` | `true` only after exact ElevenLabs endpoint/account coverage is verified |
| `downstreamZeroRetentionVerified` | `true` only after all reachable task model providers/fallback lanes have verified acceptable zero-retention coverage |
| `trainingOptOutVerified` | `true` only after separately verifying the required account data-use setting |

These booleans are operator attestations, not provider introspection or proof of compliance. No attestation has been made here. Verify all live plan/model/fallback combinations before setting them, and re-review them when that configuration changes. The currently implemented provider origins are the global ElevenLabs API; an EU-only residency requirement needs a separately verified endpoint/configuration change before activation. No ElevenLabs agent ID, OAuth app, webhook secret, cloned voice, or ElevenLabs-hosted MCP connection is required.

## Privacy: data, retention and deletion

ElevenLabs receives live microphone PCM and the text selected for speech. It returns transcripts and audio. Both paths request `enable_logging=false`. Its published coverage lists STT audio input/text output and TTS text input/audio output as eligible for zero retention for eligible enterprise accounts. Request analytics can remain without content. The API documents that STT can warn that zero retention was ignored; the relay closes on any warning. A query flag alone does not prove eligibility or prevent data already sent from having been processed.

This implementation creates no ElevenAgents conversation log and adds no ElevenLabs downstream LLM. However, committed messages still reach LotusBuild's existing Anthropic/OpenRouter task providers, and tools/MCP may reach approved external systems. Their retention and any continuing task/checkpoint retention are separate from ElevenLabs ZRM. Existing provider credentials, model-provider contracts, account eligibility, moderation/log exceptions, residency and deletion coverage have **not** been verified in the owner's accounts. Training exclusion is not zero retention. The published ElevenAgents ZRM documentation also states MCP is currently unavailable there; using LotusBuild's existing MCP execution avoids assuming that ElevenAgents feature combination is supported.

LotusBuild stores no audio file, partial-transcript log or extra voice transcript. Final sent text uses normal project chat storage, durable command receipts and approved existing task/checkpoint policy. Visible unsent words stay in component memory; uncertain sent commands use the existing pending-command browser storage. End call stops future audio transfer. Uncheck consent to withhold the next call; deleting a project and the existing account privacy-request controls apply to saved chat. Account erasure uses the existing operator-reviewed workflow. New platform spend records contain quantities and random dispatch digests, not uid, audio or text. Content-free call IDs, close reasons, duration/byte/character counts, transcript sequence numbers, connection latency and first-audio/turn latency are logged; no token, provider response body, transcript or audio is logged.

If exact required zero-retention coverage is unavailable, keep voice disabled. Options for a separate owner decision are an eligible enterprise agreement/region, a different audio provider with suitable coverage, or a revised explicit retention policy. Standard retention is not silently substituted.

## Proposed allowances for owner review only

None of these values is seeded, enabled or an existing plan promise. Using the [public API page](https://elevenlabs.io/pricing/api?price.section=speech_to_text) viewed on 1 November 2026, an illustrative rate is USD 0.39/hour for realtime STT and USD 0.04/1000 characters for Flash/Turbo speech. An enterprise zero-retention quote may differ. GBP rates must be approved from the actual contract and conservative FX/fee assumptions, not copied from this illustration.

| Existing LotusBuild plan | Proposed monthly audio input | Proposed monthly speech text | Proposed max call | Proposed concurrent calls | Illustrative audio-only variable cost at both full allowances |
|---|---:|---:|---:|---:|---:|
| Free | 5 minutes / 300 seconds | 1000 characters | 5 minutes | 1 | USD 0.0725 |
| Pro | 120 minutes / 7200 seconds | 20000 characters | 15 minutes | 1 | USD 1.58 |
| Business | 360 minutes / 21600 seconds | 60000 characters | 30 minutes | 2 | USD 4.74 |

Formula: `(seconds / 3600 × STT hourly rate) + (characters / 1000 × TTS rate)`. This excludes enterprise subscription minimums, VAT, FX, network/storage/API overhead, existing task model tokens, sandbox time and retries charged by providers. Existing task meters still apply and may stop work before an audio allowance is exhausted. These are separate input and output caps, not a promise of uninterrupted conversation minutes. The owner must approve or replace every proposal and select a global budget before activation.

## Verification and remaining activation gates

Verified locally: backend typecheck/build; 72 targeted voice + existing session-control tests; real local HTTP/WebSocket transport with a mocked provider; frontend typecheck, contract suite and Next production build; static state previews at desktop and 390px without horizontal overflow; headless Chrome AudioWorklet capture from a synthetic WebAudio stream (6400-byte PCM chunks), mute/track cleanup, denied permission and backend authorization before microphone request. No physical microphone or provider was used.

Mocked tests cover voice-to-existing-command submission, duplicate transcript delivery, stable retry identity and steering, authentication/ownership/expiry, privacy warnings, provider disconnects, bounded reconnects with task refresh, approval refusal, stopping speech versus ending/cancelling work, call/idle limits, uncertain synthesis, and transactional shared cost/per-user caps. The Firestore transaction adapter and provider sockets are fakes. The distributed Redis Lua admission script has not been run against a real Redis in this local Windows run.

The unchanged backend baseline has 780 tests: 671 pass, 108 fail, 1 skipped in this Windows environment. The final feature run has 794 tests: 685 pass, the same 108 failing test names, and 1 skipped; failures include missing POSIX commands and existing runner fixtures. Do not describe the entire backend suite as green. Linux CI remains necessary.

Before activation: approve allowances/rates/global cap/data policy; verify exact ZRM and downstream coverage with account evidence; configure least-privilege key and licensed voice/model; apply approved registry/plan values; run Linux CI, real Redis multi-instance/expiry tests, a bounded paid ElevenLabs end-to-end evaluation after approval, and real iOS Safari/Android microphone tests (interruption, permission revocation, backgrounding, network handoff, speaker echo/headphones). End-to-end latency, voice quality, provider billing reconciliation, live zero-retention enforcement and real-device behavior remain unverified. Merge/deployment is a separate approved step.
