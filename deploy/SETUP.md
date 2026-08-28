# One-time server setup

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
echo 'preet ALL=(root) NOPASSWD: /usr/bin/systemctl restart lotusbuild-api lotusbuild-runner, /usr/bin/systemctl restart lotusbuild-api, /usr/bin/systemctl restart lotusbuild-runner' \
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
