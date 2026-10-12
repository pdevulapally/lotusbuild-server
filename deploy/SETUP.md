# One-time server setup

Runner shutdown policy: explicitly set `RUNNER_DRAIN_TIMEOUT_SECONDS=90` in the
runner environment before rolling out this version. It is required, with no
default, and must be between 1 and 90 seconds. The repository runner unit sets
`TimeoutStopSec=120s`, `KillSignal=SIGTERM`, and `KillMode=control-group`, leaving
at least the required 30-second margin. Verify the deployed unit and any systemd
overrides separately; these files do not prove the live settings.

SIGTERM cancels active execution immediately. The application deadline covers
commands, partial saves, resource/accounting cleanup and connection closure; it
does not change model, command, lease or sandbox lifetime timeouts. If draining
exceeds the deadline the process exits with failure and leaves durable session,
resource and reservation evidence for recovery rather than claiming settlement.

Preserving a sandbox ID alone does not preserve workspace durability. The session's
`workspaceRecovery` becomes `REQUIRED` before a primary mutating tool is admitted
on a persistent project. It blocks replacement, detachment, finalization and ordinary
destructive recovery. A successor reconnects and quiesces the existing VM, then uses
the canonical snapshot path under its own lease. Snapshot publication and `COMPLETED`
commit atomically; only then may normal termination and accounting reconciliation run.
No field means ordinary resource recovery; a fresh attachment clears completed state.

An unsuccessful salvage stays `REQUIRED` with its resource/reservation evidence for
the existing lease-expiry recovery schedule, bounded by the existing provider lifetime.
There is no internal retry loop or automatic restoration of an older snapshot.
Provider-confirmed absence, an invalid attachment, or revoked persistence becomes
`UNRECOVERABLE` with a safe reason. Unknown final usage remains unresolved rather than
being guessed. Account erasure prevents publication; project deletion/missing-project
classification leaves disposal to the existing deletion/erasure workflow. Transient
provider or filesystem failures remain pending because they do not prove permanent loss.
Malformed recovery metadata fails closed. Real provider reconnect, quiescence and
lifetime behavior must be verified separately before rollout.

For an `UNRECOVERABLE` workspace, durable stop/absence evidence for every recorded
sandbox permits execution to end even if accounting reconciliation fails. The runner
atomically marks the session `FAILED`, removes its execution attachment and lease/
scheduling fields, and releases the project's `activeSessionId`. The recovery marker,
`reservationIds`, `specialistReservationIds`, and reservation documents remain as
accounting evidence. An `OPEN` reservation still holds its allowance; no unknown
runtime or stop timestamp is invented. The lost session cannot accept append, queue
or steering requests. A separately requested new session is subject to normal quota.

Terminal sessions are not reclaimed for accounting. Inspect retained
`users/{uid}/reservations` records and use the existing `src/metering/reconcile.ts`
operator command for counter usage only when authoritative provider evidence is
available; its existing `--apply --runners-stopped` requirements still apply.
There is no automatic terminal-reservation sweep. Failed reconciliation of confirmed-
free concurrency remains visible in those records and requires retrying the existing
metering reconciliation operation. Account erasure distinguishes this from active
execution and continues to block on `account/reconciliation-required` while holds
remain open. These rules do not authorize deleting or guessing accounting evidence.

Run once on the VPS. After this, deploying is just `./deploy.sh` from the repo root.

Facts this assumes, all verified on 2026-08-28:

- `api.lotusbuild.co.uk` resolves to `194.164.94.249` (the box).
- Ports 80 and 443 are free and reachable — connections are *refused*, not filtered,
  so no provider firewall is in the way and ACME will complete.
- Redis 8.0.5 is listening on `127.0.0.1:6379` with no auth.
- Node is v22.23.2, which satisfies `engines` and has native `--env-file`.
- `~/apps/lotusbuild-server` already holds the built tree (`npm ci` + `npm run build` done).

## 1. Secrets (you run this from the repo root on Windows, not on the server)

This is the only step that moves credentials. It rewrites two values for the server
and strips CRLF — without `tr -d '\r'` every value ends up with a trailing `\r`
inside it, because the local `.env` is Windows line-ended.

```bash
sed -E \
  -e 's#^PUBLIC_API_URL=.*#PUBLIC_API_URL=https://api.lotusbuild.co.uk#' \
  -e 's#^FIREBASE_SERVICE_ACCOUNT_FILE=.*#FIREBASE_SERVICE_ACCOUNT_FILE=/home/preet/apps/lotusbuild-server/service-account.json#' \
  .env | tr -d '\r' | ssh lotusbuild-vps 'umask 077; cat > ~/apps/lotusbuild-server/.env'

scp lotusbuild-1d63d-firebase-adminsdk-fbsvc-ebaad636d2.json \
  lotusbuild-vps:~/apps/lotusbuild-server/service-account.json

ssh lotusbuild-vps 'chmod 600 ~/apps/lotusbuild-server/.env ~/apps/lotusbuild-server/service-account.json && ls -l ~/apps/lotusbuild-server/.env ~/apps/lotusbuild-server/service-account.json'
```

Email/password sign-ups also require these values in the server `.env`:

```dotenv
RESEND_API_KEY=<Resend API key>
EMAIL_VERIFICATION_FROM=LotusBuild <verify@mail.lotusbuild.co.uk>
EMAIL_VERIFICATION_CODE_SECRET=<at least 32 random bytes, unique to this environment>
EMAIL_VERIFICATION_CODE_TTL_SECONDS=600
EMAIL_VERIFICATION_RESEND_SECONDS=60
EMAIL_VERIFICATION_MAX_ATTEMPTS=5
```

Keep the API key and code secret in the deployment secret store, not in Git. Before
enabling sign-ups, verify `mail.lotusbuild.co.uk` in Resend using the DNS records
shown in its dashboard and send a real code to an address outside the LotusBuild
domain. Google accounts that Firebase already marks verified do not use this flow.

## 2. Ship the unit files and Caddyfile (no root yet)

```bash
scp deploy/Caddyfile deploy/lotusbuild-api.service deploy/lotusbuild-runner.service \
  lotusbuild-vps:~/
```

## 3. Root block (on the server — `ssh lotusbuild-vps`, then paste)

```bash
sudo apt-get update
sudo apt-get install -y caddy

sudo install -m 644 ~/Caddyfile /etc/caddy/Caddyfile
sudo install -m 644 ~/lotusbuild-api.service ~/lotusbuild-runner.service /etc/systemd/system/
rm ~/Caddyfile ~/lotusbuild-api.service ~/lotusbuild-runner.service

# Let the deploy script restart these two units without a password. Scoped to
# exactly these commands, so it is not a general sudo grant.
echo 'preet ALL=(root) NOPASSWD: /usr/bin/systemctl stop lotusbuild-api lotusbuild-runner, /usr/bin/systemctl start lotusbuild-api lotusbuild-runner, /usr/bin/systemctl restart lotusbuild-api lotusbuild-runner, /usr/bin/systemctl restart lotusbuild-api, /usr/bin/systemctl restart lotusbuild-runner' \
  | sudo tee /etc/sudoers.d/lotusbuild-deploy >/dev/null
sudo chmod 440 /etc/sudoers.d/lotusbuild-deploy
sudo visudo -c

sudo systemctl daemon-reload
sudo systemctl enable --now lotusbuild-api lotusbuild-runner
sudo systemctl restart caddy

sleep 5
systemctl is-active lotusbuild-api lotusbuild-runner caddy
```

## 4. Verify

```bash
curl -i https://api.lotusbuild.co.uk/health     # expect 200 {"status":"ok"}
journalctl -u lotusbuild-api -n 30 --no-pager
journalctl -u lotusbuild-runner -n 30 --no-pager
journalctl -u caddy -n 20 --no-pager           # certificate issuance
```

If the certificate does not appear, it is almost always port 80 — Caddy needs it
reachable for the ACME HTTP-01 challenge.

## Still pointing at localhost

These four came straight from the dev `.env` and are wrong for production, but the
real frontend origin was never established, so they were carried over rather than
guessed:

```
CORS_ALLOWED_ORIGINS=http://localhost:3000
STRIPE_CHECKOUT_SUCCESS_URL=http://localhost:3000/billing/done
STRIPE_CHECKOUT_CANCEL_URL=http://localhost:3000/billing/cancelled
STRIPE_PORTAL_RETURN_URL=http://localhost:3000/settings/billing
```

Until `CORS_ALLOWED_ORIGINS` names the deployed frontend, a browser on that origin
cannot call the API. Edit `~/apps/lotusbuild-server/.env` and
`sudo systemctl restart lotusbuild-api`.

The Stripe webhook also needs its endpoint set to
`https://api.lotusbuild.co.uk/<webhook path>` in the Stripe dashboard, with
`STRIPE_WEBHOOK_SECRET` updated to that endpoint's signing secret.


### Recovery-compatible releases and rollback

`package.json` declares the authoritative `runnerRecoveryProtocol`. Packaging
copies it into the existing `release.json`; unpack validation and production
preflight require the exact supported protocol. New durable `workspaceRecovery`
records carry `protocol`. Known unversioned recovery records remain supported;
unknown versions, states and fields fail closed before session claim writes.
Protocol changes require a deliberate compatibility rollout; numeric ordering
alone never makes an artifact compatible.

Use the current protocol-aware deployment tools for all promotions and rollback
operations. Do not run legacy deployment scripts or manually restart a legacy
artifact. Both API and runner share the artifact and consume recovery state.
The deployment lock covers candidate preflight, compatibility checks, stopping
both units, exchange, startup and automatic failure rollback. Before each
exchange both units must report `ActiveState=inactive` and `MainPID=0`.
The deployment now needs the exact paired `systemctl stop` and `systemctl start`
sudoers permissions shown above; provision these before rollout.

For the first protocol-aware release B, a legacy active release A may be replaced,
but A is never a valid automatic rollback target. In particular committed baseline
`d6527de9bac569bb01a6a07df874d85085c095a2` ignores `workspaceRecovery` and is incompatible.
If B fails startup or health checks, deployment reports
`rollback/recovery-protocol-incompatible`, keeps B at the active path, and exits
unsuccessfully. Availability may require repair or a compatible forward release;
there is no safe legacy rollback. Do not clear recovery records or delete
preserved sandboxes to make rollback possible. Establish a tested, committed
protocol-aware baseline before expecting a compatible previous artifact.

On a subsequent B-to-C deployment with the same protocol, failed C may roll back
to B, even with a different Git SHA. The gate runs before rollback exchange or
startup; writers stop and B passes preflight before restoration. Each deployment
retains its immediate prior artifact under its candidate directory, not a shared
`previous` pointer. Missing, malformed or future target metadata blocks rollback.
If stop or rollback preflight fails, no exchange/start follows; services may stay
stopped and the active compatible artifact remains available for repair.
There is no separate manual rollback command: any operator-directed restoration
must use protocol-aware tools, the deployment lock, the same gate, stopped writers
and target preflight, never an unchecked directory exchange or old release script.

Before rollout, separately verify the deployed units and any overrides. Artifacts
still do not install systemd units. Install/update the repository runner unit with
`TimeoutStopSec=120s`, `KillSignal=SIGTERM`, `KillMode=control-group`; configure the
required `RUNNER_DRAIN_TIMEOUT_SECONDS=90` (30-second safety margin). Verify API
stop semantics also cover all its processes. Quiesce any additional API/runner
instances outside these two managed units before activating the new protocol;
this single-host deployment cannot stop an external fleet or constrain manual
administrator actions. No live unit, override or production state was verified
by the repository tests.
