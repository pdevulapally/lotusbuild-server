#!/usr/bin/env bash
# Promotes a CI-built release; never install dependencies or compile with secrets.
set -euo pipefail
HOST="${DEPLOY_HOST:-lotusbuild-vps}"
[[ $# == 3 ]] || { echo 'Usage: deploy.sh RELEASE_TAR SHA256 COMMIT_SHA' >&2; exit 1; }
artifact=$1
digest=$2
revision=$3
test -f "$artifact"
[[ "$digest" =~ ^[0-9a-f]{64}$ ]] || exit 1
[[ "$revision" =~ ^[0-9a-f]{40,64}$ ]] || exit 1
# Reject wrong/corrupt input before contacting the server. No artifact code runs.
actual=$(sha256sum "$artifact" | cut -d ' ' -f 1)
[[ "$actual" == "$digest" ]] || { echo 'Release checksum mismatch.' >&2; exit 1; }
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
[[ "$(git -C "$script_dir" rev-parse --verify HEAD)" == "$revision" ]] || { echo 'Deploy checkout revision mismatch.' >&2; exit 1; }
protocol=$(python3 "$script_dir/deploy/unpack-release.py" --protocol)
candidate="/home/preet/apps/.lotusbuild-candidate-${revision}-$$"
ssh "$HOST" "umask 077; mkdir '$candidate'"
ssh "$HOST" "umask 077; cat > '$candidate/release.tar.gz'" < "$artifact"
# Execute the validator from this trusted checkout, never from the artifact.
ssh "$HOST" python3 - "$candidate/release.tar.gz" "$digest" "$revision" "$candidate" "$protocol" < "$script_dir/deploy/unpack-release.py"
ssh "$HOST" bash -s -- "$candidate" <<'REMOTE'
set -euo pipefail
candidate=$1
active=/home/preet/apps/lotusbuild-server
[[ "$candidate" =~ ^/home/preet/apps/\.lotusbuild-candidate-[0-9a-f]{40,64}-[0-9]+$ ]] || exit 1
exec 9>/home/preet/apps/.lotusbuild-deploy.lock
flock -n 9 || { echo 'Another deployment is active.' >&2; exit 1; }
test -d "$active" && test ! -L "$active"
test -f "$candidate/dist/index.js"
test -f "$candidate/dist/runner/index.js"
test -f "$candidate/dist/preflight.js"
rm -- "$candidate/release.tar.gz"
test -f "$active/.env"
install -m 600 "$active/.env" "$candidate/.env"
if test -f "$active/service-account.json"; then
  install -m 600 "$active/service-account.json" "$candidate/service-account.json"
fi
cd "$candidate"
node --env-file=.env dist/preflight.js
python3 deploy/exchange-directories.py --check "$active" "$candidate"
switched=0
stop_services() {
  sudo -n systemctl stop lotusbuild-api lotusbuild-runner
  for unit in lotusbuild-api lotusbuild-runner; do
    [[ "$(systemctl show --property=ActiveState --value "$unit")" == inactive ]] || return 1
    [[ "$(systemctl show --property=MainPID --value "$unit")" == 0 ]] || return 1
  done
}
rollback() {
  code=$?
  trap - EXIT
  if [[ "$code" != 0 && "$switched" == 1 ]]; then
    if ! python3 "$active/deploy/exchange-directories.py" --check --rollback "$active" "$candidate"; then
      echo 'rollback/recovery-protocol-incompatible: rollback refused; compatible release retained at the active path.' >&2
      exit "$code"
    fi
    # Stop all writers before validating and exchanging back. No legacy worker
    # may overlap a newly started writer, even during automatic failure recovery.
    stop_services
    (cd "$candidate" && node --env-file=.env dist/preflight.js)
    python3 "$active/deploy/exchange-directories.py" --rollback "$active" "$candidate"
    cd "$active"
    sudo -n systemctl start lotusbuild-api lotusbuild-runner
    echo 'Candidate failed; previous directory restored. Verify both units and health.' >&2
  fi
  exit "$code"
}
trap rollback EXIT
stop_services
python3 deploy/exchange-directories.py "$active" "$candidate"
switched=1
cd "$active"
sudo -n systemctl start lotusbuild-api lotusbuild-runner
healthy=0
for attempt in {1..10}; do
  if systemctl is-active --quiet lotusbuild-api && systemctl is-active --quiet lotusbuild-runner && curl -fsS --max-time 5 -o /dev/null https://api.lotusbuild.co.uk/health; then healthy=1; break; fi
  sleep 2
done
test "$healthy" == 1
trap - EXIT
echo "Deployment healthy. Previous release retained at $candidate"
REMOTE
