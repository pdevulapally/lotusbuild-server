# Staging security verification

No staging project or endpoint has been supplied. Nothing in this checklist is a completed production check. Use an explicitly identified isolated staging project and synthetic accounts. Do not repoint existing production credentials to conduct destructive tests.

## Configuration and infrastructure

The API requires `HTTP_MAX_REQUESTS_PER_MINUTE`, `SSE_MAX_CONNECTIONS_PER_USER`, `SSE_BUFFER_MAX_BYTES`, and `FAMILY_INVITATION_TTL_SECONDS`. Both API and runner require `SESSION_EVENT_MAX_BYTES`. Select limits from capacity tests; these are required configuration, not built-in production policy defaults. Event size must accommodate expected events without defeating the per-connection buffer ceiling. Invitation TTL must be between 60 and 86400 seconds; event limit must be between 1024 and 1048576 bytes. Keep all existing required settings.

Deploy the deny-all client Firebase rules and indexes from the reviewed repository to the explicit staging project. Firebase Admin SDK permissions and signed URLs bypass client rules: verify least-privilege IAM separately. Exercise every compound query, including snapshot cleanup and account-wide active-session lookup, after indexes finish building.

Snapshot preflight now requires uniform bucket-level access, explicitly enforced public access prevention, and no `allUsers`/`allAuthenticatedUsers` bucket IAM binding. The runtime/preflight identity needs metadata and IAM-policy read permission for these checks. Verify object creation, metadata inspection, signing and exact-generation deletion permissions. Review versioning, soft delete, lifecycle, backups and restore procedures against the approved retention schedule.

Verify TLS, allowed origins, loopback-only API access behind the reverse proxy, Redis authentication/private networking and trusted proxy behavior. Connection limits are per API process; replicas need an aggregate edge capacity budget. Separate API and runner identities and secrets where possible, restrict service-account key files, and document rotation. Existing source changes do not establish a hardened live host or separate identities.

## Adversarial integration cases

| Test | Required observation |
| --- | --- |
| Two tenants guess project/session IDs | No cross-tenant read, mutation, event replay or snapshot URL |
| Revoke/disable Firebase token during SSE; stall recheck | Connection closes by authorization deadline and capacity is released |
| Oversized events, repeated reconnects, slow client | Bounded replay and buffers; no unbounded memory growth |
| Duplicate/concurrent Stripe webhook and checkout | One durable operation; incomplete webhook retried; subscription read fenced |
| Kill runner before/after provider dispatch | Unknown usage stays reserved; stale lease cannot mutate or refund successor work |
| Timed-out hostile validation keeps writing | Disposable VM terminated; primary files untouched; failed termination retains holds |
| Symlink/hardlink/special-file and Git-hook attacks | Linux file tests pass; protected paths and host files remain inaccessible |
| Signed upload wrong size/replay/late arrival | Storage rejects invalid request; retired object cannot regain content |
| Concurrent snapshot uploads and failed cleanup | Full candidate bytes reserved; old bytes charged until confirmed cleanup |
| Delete account with active build/unknown hold | Access disabled, build cancellation requested, erasure remains pending |
| Delete content with historic versions and restore backup | Accessible content generations removed; remaining provider copies documented; erasure reapplied on restore |
| Unauthenticated private E2B URL; explicit public opt-in and revoke | Private ingress denied; public enabled only by owner; revocation reports pending until VM stops |
| Child guesses ungranted project/another parent's session | Access denied; parent alone approves each billable build; retry charges once |

Use the provider's real SDK and template for E2B tests. Linux Python 3 is required for descriptor-based file handling. A disposable VM is not proof of blocked outbound network traffic; forked processes/network state and data exfiltration need explicit testing and provider controls. Do not promise complete containment of hostile code.

## Deployment and rollback

`deploy.sh` ships committed HEAD through a candidate build/preflight and Linux directory exchange, preserving `/home/preet/apps/lotusbuild-server`. Local uncommitted changes are not shipped. Its health target is currently the production API hostname: adapt it to the identified staging environment before rehearsal. The deployment helper requires Linux `renameat2`, a shared filesystem and the existing real-directory layout.

Rehearse healthy cutover, failed candidate preflight, failed service restart, failed health check and rollback. The shell trap cannot handle SIGKILL or host power loss. Record which release is active and retain an operator procedure to inspect both directories and restore the known-good release before restarting units. Old release directories contain copied secrets and need restricted access and deliberate cleanup after rollback needs expire. No atomic exchange, service restart or rollback has been executed by this remediation on the Windows host.

## Evidence needed to close

Record revision, environment/project IDs, provider/template versions, commands, timestamps, expected/observed results and redacted logs. Do not include secrets, tokens, signed URLs or real customer data in evidence. A successful local suite does not substitute for these infrastructure tests.
