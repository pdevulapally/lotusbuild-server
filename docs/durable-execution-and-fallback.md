# Durable execution and explicit fallback - local implementation

Date: 2026-10-31. Backend inspected at HEAD 2098160d2557ca258bf2aebf3810b170512d5d21; frontend is the separate Lotus-Build repository. Prepared for review by pull request at the owner's request. No production/provider/plan activation or deployments.

## Execution and reconnect contract

The existing Firestore session scheduler, transactional project guard, leases, resource reservations and snapshot recovery remain authoritative. Closing an HTTP stream removes an observer only. Stable required Idempotency-Key receipts are committed with project/session creation, messages, user-input answers, cancellation and continuation decisions. A retry reconciles the original acceptance and returns the current owned state; it does not create another build. Receipt reuse with a different body conflicts. Cancellation invalidates old queued instructions.

Firestore session_events provide bounded ordered progress, results and expiry; Redis pubsub is a delivery hint. SSE catches up on notifications and heartbeats, deduplicates IDs, signals trimmed history with stream.reset, and reconciles authoritative session.state. Reconnect and replay recheck authentication and ownership. Token expiry and revoked access terminate access. The browser retains pending command identities across tabs in owner-scoped local storage; it never treats local submission as backend acceptance. Unsent commands cannot move between devices; accepted work can be retrieved on another authenticated device.

Questions/approvals are durable, version-scoped input requests. No answer means no permission. The worker stops the tool batch immediately, including when the database acknowledgement is uncertain. Explicit cancellation is durable and checked by the worker; Redis cancellation notices are hints. Unknown external outcomes are reported rather than automatically retried.

Worker recovery is separate from client reconnect. Leases fence database mutations and stale progress. An interrupted generation/action is conservatively not replayed. Saved workspace recovery, resource cleanup and uncertain reservations are preserved. Exactly-once execution of arbitrary external services is not promised: third-party actions without idempotency/fencing may remain uncertain after a crash.

## Fallback and limits

Fallback is absent unless explicitly configured. No model, pricing, live allowance or eligible plan was invented. Owner consent names the proposed model/effort. A continuation atomically checks the checkpoint version, project version, current ownership, entitlements and shared limits. It reuses the original admitted build. Separate generic metering keys handle fallback primary and specialist input/output holds, without resetting premium counters or enabling overage.

The existing session document carries the fallback scheduling timestamp; there is no second ledger or queue service. A transactional dispatch counter admits waiting fallback work after the configured number of premium dispatches. Turns yield to the scheduler instead of hot-chaining when fallback is enabled. Temporary shared/provider capacity remains queued with a configured retry delay. Counter exhaustion pauses with reset information where a reset exists. Queue positions and completion estimates are not invented.

Safe checkpoints are captured only before generation admission, after completed tool results, without unresolved reviews, tools or uncertain holds. They include portable conversation/context, workspace version, original cumulative step/consultation limits and tool/system fingerprints. Signed thinking/opaque provider state, unconfirmed consequential actions, incompatible models or oversized context cannot safely resume. Saved files/transcripts are distinguished from a resumable checkpoint. A new sandbox restores files, not OS/process state or old preview URLs. Resumed desktop actions require a fresh screenshot.

## Approved screenshot retention

The owner approved up to seven days on 2026-10-31. Only bounded embedded images in a private continuation payload are persisted, not progress events, public state or logs. The original deadline is preserved across retries and further pauses. Deadline access checks reject reuse immediately. Completion and explicit cancellation delete the active payload; existing recursive project/account erasure includes it. Background worker sweeps delete expired payloads and unschedule paused tasks; active workers stop using expired context and retain cleanup authority.

Deploy/firestore-session-events.indexes.json is a mergeable index/TTL snippet, not a deployment command. Merge with the deployment's existing Firestore configuration, do not replace other indexes. The runner checks the collection-group expiry queries before claiming work. Apply the session_events.expiresAt index and continuations.imageExpiresAt index/TTL before rollout. No cloud configuration has been changed.

Physical deletion depends on datastore availability and the worker sweep. Firestore TTL is an asynchronous backstop, not an exact deletion deadline. Monitor deletion lag and failures; backups/exports require their own approved retention controls. Do not claim strict physical erasure at exactly seven days from this code alone. See [Firestore TTL](https://firebase.google.com/docs/firestore/ttl) and [index/TTL configuration](https://firebase.google.com/docs/reference/firestore/indexes).

## Activation decisions still required

An operator must approve the exact Anthropic model ID, effort, eligible plan keys, separate input/output meter definitions and per-tier included/hard limits/reset periods with overage disabled; configured max output tokens/checkpoint bytes, premium dispatch weight and capacity retry interval. Current configuration validation, installed provider model metadata, token counting, context size and computer-tool compatibility are checked; live provider compatibility is unverified here. Safe continuation also requires the current plan's git.persistence capability and shared resource headroom. Never overwrite live plans with seed data.

## Proxy and execution limits

Caddy's existing SSE content-type handling flushes output; persistence/replay supplies reliability, not one permanent HTTP connection. No upstream POST retry was added. See [Caddy reverse proxy streaming](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

Server-hosted execution continues after browser closure within permissions/limits. A local execution computer cannot run while asleep/powered off; external operations may pause when its network is unavailable. Not every action works offline.

## Verification and limits

Local backend regression run excluding the pre-existing untracked web-search-row.test.ts: 653 tests, 651 passed, two skipped. Additional fresh-desktop guard test: 117 agent tests passed. Filtered TypeScript check passed, excluding only src/seed/enable-web-search.ts and test/web-search-row.test.ts. Standard typecheck/build remain blocked by those pre-existing files referring to absent SandboxProvider.webSearch; they were preserved unchanged.

Tests include real HTTP disconnect/reconnect, missing Redis hints, trimmed event replay, stale-worker fencing, lost submission responses/API replacement, stable retry receipts, pending approvals, cancellation races, quota rollover, shared limits, fair scheduling, worker replacement at a safe fallback checkpoint and refusing unknown post-dispatch replay. Firestore/Redis/provider dependencies in these tests are local adapters, not live-service evidence. The worker integration uses real repositories, metering and orchestration with synthetic provider responses.

Frontend: all 87 tests passed with .env.local loaded, TypeScript passed, and the production Next.js build passed. Visual browser/tab/cross-device checks could not be completed: the browser automation host was unavailable and native Chrome reported active user input, so interaction stopped. Production Caddy, live Firestore indexes/TTL, actual provider latency/compatibility, systemd restarts and real multi-device behaviour remain unverified. A production or staging rollout must perform those checks with explicit authorization.

## Main changed areas

Backend: sessions/{commands,journal,events,repository,routes,fallback}; runner/{agent,loop,call-admission,continuation,computer,index}; entitlements/{fallback,schema,store}; generic metering; project/privacy deletion; server/CORS/entrypoints; deploy Caddy comments and Firestore index snippet; focused repository, HTTP, worker and agent tests.

Frontend: backend client, durable pending storage, message/continuation commands, SSE consumer/hook, computer page pending/approval/continuation controls, new continuation status component and contract tests. Existing design tokens and surrounding local changes were preserved. Both repositories contain unrelated pre-existing changes; unrelated changes remain in the original checkouts and are excluded from this PR snapshot.

PR snapshot verification: the unrelated untracked web-search files are absent. Standard npm run typecheck and npm run build passed; npm test passed 670 tests with two skips (672 total). This branch is based on the inspected implementation checkout; newer origin/master changes require integration before merge.
