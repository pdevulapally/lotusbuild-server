# Goal-driven agent refactor - local review

## Findings

The existing system already used a model-selected tool loop and optional, configured specialists. There was no justification for replacing the scheduler, metering, tool registry, worker or specialist infrastructure. The constraining parts were natural-language end_turn being treated as completion, provider truncation/pause being terminal, lack of structured working context, no runtime repetition guard, and validation being available only through specialist invocation. Instructions also prescribed planning before execution.

## Changes

- One shared model loop remains. The primary explicitly finishes through finish_task with completed, answered or blocked; a bare summary/promise no longer ends its goal. Specialists retain their bounded review protocol. Provider truncation/pause continues within the original budget; refusal stops as a blocker.
- update_task maintains a versioned goal context with constraints, revisable plan, observations, decisions, unresolved issues and next actions. Plans and notes are explicitly model-authored claims, distinct from runtime-owned evidence. The original user goal and runtime metadata cannot be rewritten through this tool.
- Runtime evidence stores actual tool identity, result status, digest/excerpt and observed execution revision. Completed work needs successful direct checkable evidence at the current revision; fabricated references, writes alone, stale pre-edit checks, open review blockers and pending plan items are rejected. answered cannot bypass completion after actions. The model still chooses relevant checks: a successful command is not proof of full semantic correctness or test coverage.
- Three consecutive identical failures or four identical non-action observations stop unproductive repetition; failed goal-control tools count too. Screenshots are excluded from text-only successful-repeat detection because equal descriptions do not prove equal images. Loop counters survive safe continuation. Evidence has a bounded 128-record budget and notes a 100,000-byte protocol limit. Existing step/token/resource ceilings remain enforced.
- Context compaction starts after 48 messages, retaining recent complete exchanges, original user instructions/steering, structured notes and evidence. Exact consequential action inputs and paired results are retained to avoid losing what already ran. Opaque provider state is not silently summarized. Some histories cannot shrink sufficiently; provider/context/resource limits may still require stopping honestly.
- Context is saved privately on the existing session under its transactional worker lease after completed batches. Older context is supplied as non-authoritative prior notes for later requests. Safe fallback checkpoints include the structured context and preserve the original cumulative budgets. Interrupted uncertain actions still use conservative recovery rather than replay.
- The primary can choose the existing run_validation implementation directly when an isolated validation sandbox is available. It uses the same provider profiles, sandbox acquisition, fresh entitlements, metering, cancellation and disposal path. There is no mandatory specialist handoff or automatic sequence of roles.
- The worker reports blocked, no-progress and resource-limited outcomes as unverified instead of treating idle or a streamed summary as proof of success. Existing authorization, isolation, approvals/questions, cancellation, safe screenshots and reservation accounting remain in place.

## Files for this refactor

src/runner/task-context.ts (new); src/runner/agent.ts; src/runner/continuation.ts; src/runner/loop.ts; src/sessions/repository.ts; test/task-context.test.ts (new); test/agent-specialists.test.ts; test/fallback-session.test.ts; test/call-admission.test.ts (billing fixture completion contract); scripts/latency-audit.ts (synthetic fixture updated to the new completion protocol only). Existing durability/fallback/performance changes and unrelated dirty files were preserved. No frontend feature changes were needed.

## Demonstrations

The orchestration tests use scripted model responses, not a live model or provider-quality evaluation. They demonstrate the implemented runtime and protocol:

1. Reproduce an actual local arithmetic assertion failure, inspect the real file, plan after observing the failure, edit the expression, rerun Node successfully and cite the actual passing tool result. Files and subprocess execution are real, in a disposable local test directory.
2. Plan first, encounter an invalid path, refuse to stop at a prose promise, inspect an allowed path, revise the plan and verify before completion, without specialists.
3. Inspect first, discover missing account configuration and explicitly stop blocked without claiming deployment.
4. Reject invented evidence, then permit further investigation and corrected evidence-backed completion.
5. Continue provider-truncated output; stop a provider refusal; stop identical failures/repeated reads; report step-limit exhaustion honestly.
6. Choose isolated validation directly without delegation. Existing optional specialist concurrency, review blocker ownership, token settlement and cancellation suites remain relevant.
7. Reject stale pre-edit evidence, writes-only evidence, answer-only bypasses and attempts to overwrite goal/evidence/permissions. Preserve original instructions and exact actions during compaction, carry loop/evidence state through a safe checkpoint, and fence persisted context against stale leases and other users.

Legacy orchestration fixtures now translate their explicit final say() shorthand into finish_task calls. New autonomy cases use raw scripted responses to test premature prose and invalid completion directly; production has no legacy bypass.

## Verification and limits

Final broad backend run: 672 tests, 670 passed, zero failures, two skipped. Excludes only the known pre-existing untracked test/web-search-row.test.ts. The 25 billing admission tests also passed after their fixture was updated to emit the explicit completion contract. The full suite was rerun after that correction. Filtered TypeScript passed, including the offline diagnostic script, excluding only pre-existing src/seed/enable-web-search.ts and test/web-search-row.test.ts. Standard backend checks remain blocked by those unrelated files referring to absent SandboxProvider.webSearch. No claim is made that they were fixed.

No live model, live sandbox/provider, production migration or browser evaluation was run for this refactor. The exact usefulness of model-selected plans/checks still needs live evaluation on an approved test target. The system enforces evidence provenance and observable completion boundaries, not mathematical proof that a selected check covers every user requirement or that unobserved external changes did not occur.

New durable context saves add transaction work; no performance improvement is claimed. The earlier performance audit remains separate and no proposed performance fixes were applied. Existing older checkpoints with different tool/system fingerprints fail explicitly rather than being silently replayed under this changed tool contract.

Implementation was originally kept local. The owner subsequently requested pull requests; this curated snapshot is prepared on a review branch. No deployment, production settings change or provider activation.

Final whitespace check: git diff --check passed. The local real-file repair test used Node to execute the same assertion before and after the exact edit; the first subprocess exited with an assertion error and the second passed. No provider calls were made.

PR snapshot: standard typecheck/build pass with no exclusions because unrelated untracked web-search files are not included. npm test: 670 passed, two skipped. The PR is a draft pending integration with newer upstream changes.
