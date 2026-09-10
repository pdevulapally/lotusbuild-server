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

## AI instruction and network hardening — 10 September 2026

One instruction/data policy now covers primary and specialist agents. Project metadata no longer enters system instructions. The primary receives JSON-encoded task metadata; specialists receive only their review task and suggested paths. Existing tool grants enforce specialist permissions independently of model behaviour. This reduces injection exposure; it does not make a model jailbreak-proof.

Local verification for this change: typecheck and production build passed; the full suite reported 381 tests, 379 passed, 2 platform-dependent skips, zero failures. The 13 new cases cover prompt boundaries, adversarial tool use, plan policy selection, malformed policies and provider network handoff/failure. No live model or provider was contacted by these tests.

Every existing `plans/{key}` document must explicitly contain `sandboxNetwork` before deployment:

| Plan | Required field value |
| --- | --- |
| Free | `{"mode":"unrestricted"}` |
| Pro | `{"mode":"unrestricted"}` |
| Business | `{"mode":"restricted","allowedDomains":[]}` with approved exact DNS names populated before enabling required external services |

The Business seed deliberately denies outbound internet until approved domains are configured. This blocks package downloads and sandbox snapshot transfers unless their actual destination hosts are approved. No domains are inferred or silently added. Names must be unique, lowercase and exact; URLs, IP addresses, wildcards and malformed entries are rejected. This checkout has no separate Teams plan or organisation-admin policy editor; this change uses operator-owned plan configuration.

Patch only this field in live plans, then run the existing read-only preflight. Missing policy fails configuration loading. Do not rerun the full seed over live plans, as it overwrites unrelated settings. No production configuration was changed in this work.

E2B receives network policy at VM creation, independently of public-preview ingress. Validation applies the selected policy to the source before forking and the child before use; failed child policy application triggers termination. Verify the deployed provider preserves containment during fork startup, including resumed background processes. Policy changes apply on sandbox acquisition/validation acquisition, not as instantaneous billing-webhook revocation of existing VMs. Stop and recreate active sessions when immediate changes are required.

Free/Pro unrestricted access is the operator's requested product choice and retains outbound exfiltration risk if an injection succeeds. Domain filtering controls destinations, not content: an approved shared host may accept uploads or serve hostile content. The primary retains shell access inside its VM; file-tool confinement is not an OS jail for arbitrary commands. Verify template isolation, credentials, real egress including DNS/IPv6/redirects, and live-model adversarial cases before asserting production containment. Offline tests verify prompt placement, tool denial, plan parsing and SDK requests, not those provider/model guarantees.

### UK/EU legal boundary

These changes support risk-appropriate security and data protection by design; they are not compliance certification. EU GDPR Articles 5, 25 and 32 require assessment of actual processing and appropriate measures. ICO AI guidance likewise addresses security and minimisation and is under review following the Data (Use and Access) Act. Neither source mandates this subscription-tier network split. [EU GDPR](https://eur-lex.europa.eu/eli/reg/2016/679/2016-05-04), [ICO AI security and minimisation](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/artificial-intelligence/guidance-on-ai-and-data-protection/how-should-we-assess-security-and-data-minimisation-in-ai/).

Complete the existing privacy assessments below: actual controller/processor roles, lawful bases, retention, vendor contracts/locations/transfers and any required DPIA. An approved destination does not establish a lawful international transfer. Assess EU AI Act Article 50 transparency against the product, roles and applicable dates; a backend instruction to identify as AI does not prove UI disclosure or output-marking compliance. The Commission's current guidance addresses obligations applying from 2 August 2026 and applicable transitional provisions. [Commission Article 50 guidance](https://digital-strategy.ec.europa.eu/en/policies/guidelines-ai-transparency-obligations).

## CI/CD review — 10 September 2026

This review covers `.github/workflows/ci.yml`, `deploy.sh` and the checked-in service definitions. The two high-risk build/credential findings have been fixed in the working tree. These changes have not been deployed; container packaging remains separate from SSH/systemd deployment.

| Severity | Finding | Correction required |
| --- | --- | --- |
| High — fixed in code | Dependency lifecycle code could remain in the deployment runner until its SSH key arrived. | Build/test/package in the check job without production secrets. A fresh hosted deploy runner downloads that same run's immutable artifact by ID and runs no npm commands, build tools, tests or application imports. |
| High — fixed in code | VPS dependency installation and compilation could read the live production credentials through the deployment OS identity. | Both operations have been removed from `deploy.sh`. The VPS checks the checksum, revision, archive boundaries and runtime compatibility, then loads credentials only for runtime preflight and service startup. There is no on-server build fallback. |
| Medium — fixed in code | Inherited token permissions, persisted checkout credentials and movable action references. | Added `contents: read`, disabled persisted checkout credentials and pinned all four actions to commits verified against their official GitHub repositories. |
| Medium | The secret-content scan prints matching lines into CI logs, excludes all workflow files and treats a failed scan like no match. | Use redacted results, cover workflow content, distinguish scanner errors from clean results, and use a maintained scanner with reviewable updates. Existing signatures are not comprehensive secret detection. |

Positive controls: deployment is limited to pushes on master, depends on checks, uses a production environment, serialises deployment, pins the SSH host key, and performs candidate preflight plus health/rollback handling. Environment review requirements, branch protection, organisation action policies, actual host identity separation and deployed service-unit hardening cannot be established from these files alone.

### Release promotion and remaining verification

The check job installs from the lockfile with lifecycle scripts disabled, runs the existing typecheck/build/tests and the release validator tests, installs production dependencies into a fresh directory, and smoke-imports the direct dependencies without application startup. Packaging and validation run on pull requests too; only a successful master push uploads a deployment artifact. The payload allowlist contains `dist`, `node_modules`, package manifests, a runtime/revision manifest and the existing atomic exchange helper. It excludes source, tests, workflows and runtime credentials.

The deploy job uses the artifact ID and SHA-256 from its own check job; it never discovers an artifact by a mutable latest name or another workflow. The trusted checkout supplies the unpacker, rather than executing an unpacker from the artifact. Validation rejects checksum/revision mismatches, links, traversal, unexpected roots, duplicate entries and incompatible runtime metadata before writing payload files. Existing candidate content is protected. The server must have the same Linux architecture, Node major and Node ABI as the builder, and a glibc version at least as new. A mismatch stops promotion before credential copying or cutover. Other OS/library compatibility still needs a Linux staging rehearsal.

Manual invocation now requires the CI archive, its expected checksum from the successful check job, and the matching commit: `bash deploy.sh RELEASE_TAR SHA256 COMMIT_SHA`. Run it from the trusted checkout of that commit with the existing `DEPLOY_HOST` configuration. A bare invocation fails rather than building locally. Preserve the existing production-environment review gate when retrieving or promoting releases.

Build execution is now outside the production credential boundary. The deploy and runtime identities on the host have not been reconfigured. Runtime dependencies necessarily execute during preflight/startup and may read runtime credentials; artifact checksums and job separation do not prove dependency code benign or protect against a compromised approved source commit. Review and dependency provenance remain necessary. Failed candidates and previous releases retain the existing manual cleanup policy.

Local verification: all 13 release/credential-boundary tests, typecheck, source build and Bash syntax checks passed. The full application suite passed 379 tests with 2 platform skips and no failures. A fresh locked production install with lifecycle scripts disabled succeeded, and all 10 direct dependencies imported successfully; this smoke check ran on local Windows/Node 24, while CI uses Linux/Node 22. GitHub Actions execution, Linux artifact deployment, Docker execution and live cutover/rollback remain unverified. A read-only SSH query for Node/CPU/glibc could not authenticate, so production runtime compatibility is unknown and must be checked before promotion. No production changes were made.

The new [container build](containers.md) uses a pinned Node image, lockfile installs without dependency lifecycle scripts, an allowlisted context and a non-root production runtime. It is ready for a Docker-capable environment to build and test; it has not been built here and is not wired into the production workflow. Reuse this image for artifact promotion when undertaking the deployment migration. [GitHub workflow security guidance](https://docs.github.com/en/actions/reference/security/secure-use), [Docker build guidance](https://docs.docker.com/build/building/best-practices/).

## Handoff documents and launch blockers

- [Staging checks](staging-security-checklist.md): required configuration, IAM/rules/indexes, provider tests and deployment rehearsal.
- [Family API integration](family-access.md): approval flow, permissions, pagination and public-preview behavior.
- [Privacy operations](privacy/operations.md), [notice draft](privacy/notice-draft.md), [retention proposal](privacy/retention-draft.md), [customer DPA draft](privacy/customer-dpa-draft.md): internal, unapproved documents.

The concrete outstanding inputs are an identified staging environment; approved retention periods; verified company disclosures before publication; vendor/transfer/backup evidence; and an age/parent-assurance and frontend onboarding process. Public-sharing and children-related legal scope assessments also remain open. No customers were reported, so this work does not establish an actual customer-data breach. It also cannot support a statement that the service complies with every UK/EU law.
