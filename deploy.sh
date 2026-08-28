#!/usr/bin/env bash
# Deploys the API and the runner to the VPS over ssh.
# One-time server setup (Caddy, systemd, .env) is in deploy/SETUP.md.
#
# Secrets are never shipped from here. ~/apps/lotusbuild-server/.env and the
# Firebase service-account JSON exist on the server only; `git archive` sends
# only the committed tree, so an untracked .env cannot leak into a deploy.
set -euo pipefail

HOST="${DEPLOY_HOST:-lotusbuild-vps}"
DIR="apps/lotusbuild-server"

echo "==> build locally (fail before touching the server)"
npm run build

echo "==> ship committed tree to $HOST"
git archive --format=tar HEAD | ssh "$HOST" "mkdir -p ~/$DIR && tar x -C ~/$DIR"

echo "==> install and build on $HOST"
ssh "$HOST" "cd ~/$DIR && npm ci --silent && npm run build"

echo "==> restart"
ssh "$HOST" 'bash -s' <<'REMOTE'
set -euo pipefail
test -f ~/apps/lotusbuild-server/.env || { echo "FATAL: .env missing on server" >&2; exit 1; }

# Passwordless for these two units only, via the sudoers drop-in from SETUP.md.
sudo -n systemctl restart lotusbuild-api lotusbuild-runner
sleep 3

for u in lotusbuild-api lotusbuild-runner; do
  systemctl is-active --quiet "$u" || {
    echo "FATAL: $u is not active" >&2
    journalctl -u "$u" -n 40 --no-pager >&2
    exit 1
  }
done
echo "both units active"
REMOTE

echo "==> smoke test"
curl -fsS --max-time 15 -o /dev/null -w "https://api.lotusbuild.co.uk/health -> %{http_code}\n" \
  https://api.lotusbuild.co.uk/health
echo "==> deployed"
