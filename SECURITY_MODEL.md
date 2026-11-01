# lotusbuild-server security model

Repository: `pdevulapally/lotusbuild-server` (Fastify 5 / TypeScript API + AI runner). Infrastructure lives in the same repo (`deploy/`, `Dockerfile`, `.github/workflows/ci.yml`, `firestore.rules`, `storage.rules`); there is no separate infrastructure repository. Prior hardening notes are in `docs/security-remediation.md` and `docs/staging-security-checklist.md`.

## System overview and trust boundaries

- **Edge**: Caddy (`deploy/Caddyfile`) terminates TLS for `api.lotusbuild.co.uk` and proxies to the API on `127.0.0.1:4100`; it overwrites `X-Forwarded-For`, and Fastify uses `trustProxy: 'loopback'`.
- **API process** (`lotusbuild-api.service`) and **runner process** (`lotusbuild-runner.service`) run on one VPS as the same OS user `preet`, reading the same `.env` (all server secrets). Redis is local.
- **Firebase**: Auth (ID tokens), Firestore and Storage. Client rules are deny-all; all data access goes through the backend with explicit ownership checks.
- **E2B microVMs**: the AI agent runs arbitrary shell commands, file writes and previews inside a per-session VM (plus disposable validation forks). Free/Pro sandboxes have unrestricted egress; Business is restricted to approved domains. Optional public preview ingress and a noVNC desktop stream.
- **Model providers**: Anthropic (primary) and OpenRouter (fallback) via `src/models/provider.ts`.
- **Third parties**: Stripe (checkout, portal, webhook), Brevo (email codes), GitHub App (installation tokens), connection providers (Netlify, Vercel, Slack, AWS, MCP — dormant until a KEK is configured).

Trust boundaries: internet → Caddy/API; authenticated user → other users' data; agent/sandbox content (prompt-injectable: project files, web content, tool output) → runner, server secrets and other tenants; API/runner → third parties; CI → production VPS.

## Components

| Component | Code it covers |
| --- | --- |
| **API** | `src/server.ts`, `src/http/`, `src/auth/`, `src/users/`, `src/email/`, `src/attachments/`, `src/skills/`, `src/privacy/`, `src/config/` |
| **Runner** | `src/runner/`, `src/sessions/`, `src/models/`, `src/diagnostics/` |
| **Sandboxes & Desktop** | `src/sandboxes/`, `src/desktop/` |
| **Projects & Sharing** | `src/projects/`, `src/storage/` |
| **Billing & Metering** | `src/billing/`, `src/metering/`, `src/entitlements/` |
| **Family** | `src/family/` |
| **Connections & GitHub** | `src/connections/`, `src/github/` |
| **Infrastructure** | `deploy/`, `deploy.sh`, `Dockerfile`, `.github/workflows/`, `firestore.rules`, `storage.rules`, `src/preflight.ts`, `src/release.ts`, `src/redis/`, `src/seed/`, `src/firebase.ts`, `src/index.ts`, `scripts/` |

## Entry points and who can reach them

- **Anonymous**: `GET /health`, `GET /plans`, `POST /webhooks/stripe` (Stripe signature over raw body), `GET /shared/projects/:id[/files[/content]]` (link token or public visibility; uniform 404), `GET /connections/:connector/callback` (OAuth state + PKCE), desktop WebSocket `GET /sessions/:id/desktop?ticket=` (single-use ticket + origin allowlist).
- **Signed-in (Firebase ID token)**: `/me*`, sessions (create, messages, SSE events, usage, desktop ticket), projects (files, archive, changes, visibility, share, public-preview), attachments, skills, billing checkout/portal, privacy requests, connections, family. Writes need a verified email (`requireVerifiedEmail`).
- **Family roles**: parent-owned accounts linked to child accounts; parents approve child builds and project grants (`src/family/`).
- **Agent in sandbox**: tool calls (`run_command`, `write_file`, `edit_file`, `read_file`, `list_files`, `search_files`, `start_preview`, `run_validation`, computer use) executed by the runner; tool output and project content return to the model.
- **CI**: push to `master` → artifact → `deploy.sh` over SSH, gated by the `production` environment.

## Assets and sensitivity (all user-confirmed as critical)

1. **Server secrets**: Anthropic/OpenRouter/E2B/Stripe/Brevo keys, Firebase service account, GitHub App private key, `CONNECTION_KEK_V<n>` — highest; compromise affects every tenant.
2. **Sealed connection credentials** (`connection_credentials/*`, AES-256-GCM with KEK-wrapped DEKs) — deploy/publish access to users' external accounts.
3. **Users' project code and session history** (Firestore, Storage snapshots, Redis events, attachments).
4. **Children's data in family accounts** — UK/EU minors; elevated regulatory sensitivity.
5. **Billing integrity and quotas**: Stripe subscription state, metering counters/holds, plan entitlements — abuse means free compute/model spend.

## Attacker profiles (all in scope per the user)

- **Anonymous internet attacker**: probes public routes, webhook, shared-project and OAuth callback endpoints, desktop WebSocket, rate limits.
- **Malicious signed-in user / tenant**: IDOR across projects, sessions, attachments, connections, family links; quota and billing bypass; abusing sharing/visibility; racing idempotency and leases.
- **Prompt-injected agent**: hostile content in project files, web pages or tool output steers the agent to exfiltrate data, escape the sandbox/file-tool confinement, reach runner secrets, or act on other tenants' resources.
- (Implicit) supply chain / CI: compromised dependency or workflow reaching production credentials.

## Existing controls

- Firebase ID-token verification with strict bearer parsing (`src/auth/plugin.ts`); verified-email gate on writes; owner checks (`sessions.readOwned`, project repository).
- Global IP + per-uid rate limits backed by Redis, fail-closed (`skipOnError: false`); body limit 1 MB; helmet; CORS exact-origin allowlist without credentials.
- Deny-all Firestore/Storage client rules.
- Session lease tokens with expiry fencing; idempotency keys; durable metering holds and reconciliation.
- Sandbox network policy per plan; validation forks; bounded tool output; descriptor-relative file access and Git-hook defenses.
- Single-use desktop tickets, origin check on WebSocket; ticket redacted from request logs.
- Stripe webhook signature verification with durable claims.
- Connections: envelope encryption, explicit project grants, lease-token operation ledger, action-bound single-use approvals, OAuth state bound to user/connector/callback with PKCE.
- CI: least-privilege token, pinned actions, build outside production credential boundary, artifact checksum/revision validation, production environment approval.

## Out of scope / accepted risk

The user stated nothing is out of scope: every finding is reported at its normal severity. Documented product choices (Free/Pro unrestricted sandbox egress, agent shell inside its own VM) and the known open item O02 (shared API/runner OS identity) remain in scope.

## Open questions

- Is any staging environment available for validating findings at runtime?
- Are the GitHub App and connection providers live in production, or dormant (affects reachability, not priority)?
