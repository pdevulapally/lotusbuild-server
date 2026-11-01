# Provider confirmation needed before public activation

Draft for the owner to send to ElevenLabs. No message has been sent.

Our active workspace is on Starter. Its published private ElevenAgents agent uses Eleven Realtime v1 Max in the global/US API environment, with Zero Retention Mode enabled, call recording disabled and backup models disabled. The authenticated agent API returns those settings. We have not started a call or sent any customer audio/conversation content.

Your per-agent ZRM guide describes enabling the setting and Max support in US/EU, while the general ZRM policy describes eligibility as selected Enterprise accounts. Please confirm:

1. Is this Starter workspace actually eligible for ZRM for native Max API/WebSocket conversations, and will the enabled setting be honored rather than merely stored?
2. What exactly is retained for input/output audio, transcripts, conversation history/logs, moderation/debug logs, reasoning and other content-bearing metadata? Include exceptions and deletion periods.
3. Does the same retention policy cover all downstream model/subprocessors used by native Max with backup models disabled? Please distinguish no training from no retention.
4. Does account Data use opt-out cover all audio and text passed through this configuration? Are any additional settings or contract terms necessary?
5. What input, cached-input, output and other token rates apply to native Max on this account, alongside the agent-minute rate? What enforceable provider spending limits cover both agent minutes and model charges, and is disabling usage-based billing sufficient to prevent additional charges on this subscription?

If Starter is ineligible, please identify an eligible option and the exact applicable retention terms. We have not authorized an account upgrade or changed the policy to standard retention.

References reviewed 2026-11-01:

- https://elevenlabs.io/docs/eleven-agents/customization/privacy/zrm
- https://elevenlabs.io/docs/eleven-api/resources/zero-retention-mode
- https://elevenlabs.io/docs/help-center/legal/is-my-data-used-to-improve-eleven-labs-ai-models
- https://elevenlabs.io/docs/eleven-agents/customization/realtime-models
