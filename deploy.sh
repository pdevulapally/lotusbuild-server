#!/usr/bin/env bash
# Ships a committed candidate; preflight precedes an atomic directory exchange.
set -euo pipefail
HOST="${DEPLOY_HOST:-lotusbuild-vps}"
revision=$(git rev-parse --verify HEAD)
[[ "$revision" =~ ^[0-9a-f]{40,64}$ ]] || exit 1
candidate="/home/preet/apps/.lotusbuild-candidate-${revision}-$$"
npm run build
ssh "$HOST" "umask 077; mkdir '$candidate'"
git archive --format=tar HEAD | ssh "$HOST" "tar -x -C '$candidate'"
ssh "$HOST" bash -s -- "$candidate" <<'REMOTE'
set -euo pipefail
candidate=$1
active=/home/preet/apps/lotusbuild-server
[[ "$candidate" =~ ^/home/preet/apps/\.lotusbuild-candidate-[0-9a-f]{40,64}-[0-9]+$ ]] || exit 1
exec 9>/home/preet/apps/.lotusbuild-deploy.lock
flock -n 9 || { echo 'Another deployment is active.' >&2; exit 1; }
test -d "$active" && test ! -L "$active"
test -f "$active/.env"
install -m 600 "$active/.env" "$candidate/.env"
if test -f "$active/service-account.json"; then
  install -m 600 "$active/service-account.json" "$candidate/service-account.json"
fi
cd "$candidate"
npm ci --silent
npm run build
node --env-file=.env dist/preflight.js
python3 deploy/exchange-directories.py --check "$active" "$candidate"
switched=0
rollback() {
  code=$?
  trap - EXIT
  if [[ "$code" != 0 && "$switched" == 1 ]]; then
    python3 "$active/deploy/exchange-directories.py" "$active" "$candidate"
    sudo -n systemctl restart lotusbuild-api lotusbuild-runner
    echo 'Candidate failed; previous directory restored. Verify both units and health.' >&2
  fi
  exit "$code"
}
trap rollback EXIT
python3 deploy/exchange-directories.py "$active" "$candidate"
switched=1
cd "$active"
sudo -n systemctl restart lotusbuild-api lotusbuild-runner
healthy=0
for attempt in {1..10}; do
  if systemctl is-active --quiet lotusbuild-api && systemctl is-active --quiet lotusbuild-runner && curl -fsS --max-time 5 -o /dev/null https://api.lotusbuild.co.uk/health; then healthy=1; break; fi
  sleep 2
done
test "$healthy" == 1
trap - EXIT
echo "Deployment healthy. Previous release retained at $candidate"
REMOTE
