# Security remediation — 5 September 2026

Deployment update: the owner subsequently requested production deployment. The release is now deployed; see [production release evidence](production-release-2026-09-05.md). Earlier non-deployment statements below describe the original remediation handoff. The remaining legal, frontend and unexercised integration limitations still apply.

Status: repository remediation and local verification completed; external staging evidence remains outstanding. This is not a launch clearance or a statement that every vulnerability has been eliminated.

## Agreed order

1. Recovery/isolation: lease token and expiry fencing; disposable validation VMs; durable model and sandbox holds; observed usage journal; descriptor-relative project file access. Local regression tests pass; Linux/E2B integration still requires staging evidence. Unknown provider usage deliberately blocks recovery until reconciliation.
2. Storage/deletion: reserve full new archive capacity before signing; signed exact length and create-only generation; trusted metadata on publication; durable cleanup records; keep old bytes charged until cleanup; project deletion tombstones and Redis event erasure. Account-wide erasure and historic object-generation cleanup are implemented with operator decisions and unresolved-usage gates. Provider backups and soft-deleted copies require separate confirmation.
3. Regression verification: 359 tests total, 357 passing, 2 skipped, 0 failing using `npm test -- --test-concurrency=2`; production build and typecheck passed. Skips concern Linux filesystem tests on this Windows host. `npm audit --omit=dev` reported zero known vulnerabilities. An earlier unrestricted-concurrency run hit a command timeout in the search-marker regression; the isolated test and complete reduced-concurrency rerun passed. Deployment Bash/Python syntax checks and both operator CLI help paths passed; no provider operation was performed by those help checks.
4. Infrastructure: deny-all client Firebase rules and required storage indexes prepared, not deployed. Candidate preflight and atomic exchange deployment source prepared, not exercised on Linux or staging. IAM, provider ingress, backups, credentials and rollback still require live evidence.
5. Privacy: internal notice, retention and customer DPA drafts, request intake, operator erasure workflow and an operational runbook are prepared. Parent-owned linked access is implemented with parent approval, project grants and approval of each child build. Frontend integration, age/parent assurance, vendor evidence and policy approval remain open. No customer launch approved.

## Confirmed owner decisions

- SR IT support services is a limited company; contact info@sritsupportservices.co.uk. Postal address was deliberately withheld; do not invent or publish incomplete operator details.
- No LotusBuild customers yet. Intended UK/EU customers include businesses, users aged 16+, and younger users with parental supervision. Public project sharing is intended.
- Disposable validation sandboxes are allowed; one primary workspace remains authoritative.
- Under-16 access uses parent-owned accounts with linked access. Email verification and declarations are not represented as proof of age or parental responsibility.
- Reserve Anthropic's token-count estimate and record observed overruns. This is not an absolute spending ceiling.
- Retention periods remain a proposal awaiting approval. Do not automatically delete inactive accounts or backups based on an unapproved draft.

## Pending external information

The staging Firebase project and endpoint have been requested. No staging environment has been identified or tested in this work. Retention approval was requested separately. No production mutation, deployment, commit, push or credential rotation has been performed.

## Accounting and storage operational notes

Snapshot upload reservations are separate from runner reservations. `snapshotUploads` journals admission before any signed upload URL is issued. Its statuses are CANDIDATE, CURRENT, OBSOLETE, CLEANING and DELETED. Cleanup converts the object to a zero-byte generation, preserving a create-only precondition barrier against delayed/replayed uploads; do not install a lifecycle rule that removes these markers without proving all outstanding requests are no longer valid. Retired job records remove owner, project, object and lease references. Storage versioning, soft delete and backups remain separate provider retention obligations.

Deploy the new indexes before enabling the cleanup worker. A failed cleanup retains both its job and the appropriate quota charge. Do not manually clear reservations to restore allowance.

`src/metering/reconcile.ts` is an operator-only evidence-based tool. Its default is read-only; `--apply --runners-stopped` is required to settle a provider-confirmed counter quantity. Zero is acceptable only when provider evidence proves zero usage. A missing response is not such evidence. Ambiguous sandbox creation/termination must be checked at the provider; this command does not establish VM termination.

## Required configuration additions

The API now requires `HTTP_MAX_REQUESTS_PER_MINUTE`, `SSE_MAX_CONNECTIONS_PER_USER`, `SSE_BUFFER_MAX_BYTES` and `FAMILY_INVITATION_TTL_SECONDS`. Both API and runner require `SESSION_EVENT_MAX_BYTES`. Values must be selected and capacity-tested for the deployment. The local ignored example is not a deployment artifact. Existing SSE global and per-user connection ceilings are per API process; aggregate capacity must account for replica count. The edge should accept forwarded client addresses only from the configured loopback proxy.

## Audit finding disposition

These rows map the original audit IDs to code changes, not to production certification.

| Finding | Repository disposition | Remaining evidence or limitation |
| --- | --- | --- |
| S01, S10, S20 | Git hook/fsmonitor defenses, protected Git internals, descriptor-relative file handling and bounded parsing | Linux filesystem tests and actual E2B template validation; VM-level compromise is outside a pathname check |
| S02 | Disposable validation VMs; failure blocks successful validation; termination accounting retained | Provider termination/fork behavior and outbound network controls |
| S03, S18, S19 | Pre-dispatch usage holds, observed-usage journal, evidence-based reconciliation, durable sandbox records, original-window refunds | Estimated input reservation can overrun; provider ambiguity requires evidence, never zero assumptions |
| S04, S11, O03 | Fresh capability checks and token/expiry lease fencing before mutations | Distributed crash/recovery rehearsal |
| S05, S08, S09 | Durable webhook claims, serialized authoritative subscription reads, idempotent checkout operations | Stripe staging replay and concurrent checkout tests against actual provider |
| S06, S14, S15 | Retryable deletion, pre-upload full-capacity reservation, generation barriers, quota-reducing cleanup and account erasure workflow | GCS/backup/vendor verification and approved retention |
| S07, S12, S17 | Bounded file/provider output, event byte limits, one-event replay, per-account SSE limits, authorization deadline and global IP limiter | Edge/replica capacity tests; no total infrastructure spending guarantee |
| S13 | Bounded transactional queue admission and deletion/lease checks | Firestore indexes and staging contention tests |
| D01 | Lockfile/overrides updated; refreshed production dependency audit reports zero known advisories | Advisory databases cannot establish absence of unknown vulnerabilities |
| O01 | Candidate preflight and atomic directory exchange deployment source | Linux cutover/rollback untested; crash recovery and production health target need staging rehearsal |
| O02 | Still open: shared API/runner OS identity and environment | Operator must verify and implement identity/secret separation and host hardening |
| O04 | Private provider ingress by default; owner-only public opt-in; cancellation on revocation | Private browser preview integration, outbound traffic and actual ingress/termination behavior |
| O05, L01 | Generic internal errors and fail-closed disjoint allowlists | Local regression coverage |

## Handoff documents and launch blockers

- [Staging checks](staging-security-checklist.md): required configuration, IAM/rules/indexes, provider tests and deployment rehearsal.
- [Family API integration](family-access.md): approval flow, permissions, pagination and public-preview behavior.
- [Privacy operations](privacy/operations.md), [notice draft](privacy/notice-draft.md), [retention proposal](privacy/retention-draft.md), [customer DPA draft](privacy/customer-dpa-draft.md): internal, unapproved documents.

The concrete outstanding inputs are an identified staging environment; approved retention periods; verified company disclosures before publication; vendor/transfer/backup evidence; and an age/parent-assurance and frontend onboarding process. Public-sharing and children-related legal scope assessments also remain open. No customers were reported, so this work does not establish an actual customer-data breach. It also cannot support a statement that the service complies with every UK/EU law.
