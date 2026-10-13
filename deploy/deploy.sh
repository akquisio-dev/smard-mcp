#!/usr/bin/env bash
# Deploys the current commit to a server running smard-mcp under systemd
# (see deploy/smard-mcp.service). Usage: npm run deploy
#
# Settings come from deploy/deploy.env (not in git, see deploy.env.example)
# or the environment:
#   DEPLOY_HOST        ssh target, e.g. root@server.example.org (required)
#   DEPLOY_DIR         install directory            (default /opt/smard-mcp)
#   DEPLOY_NODE_BIN    directory of node and npm     (default /opt/node-22/bin)
#   DEPLOY_SERVICE     systemd unit                  (default smard-mcp)
#   DEPLOY_PORT        local HTTP port of the server (default 8450)
#   DEPLOY_PUBLIC_URL  public base URL to check afterwards (optional)
#
# Steps: refuse uncommitted or unpushed changes, typecheck + test + build,
# keep a copy of the running version, upload, install production
# dependencies, restart, and check /health for the new version. If the
# check fails, the previous version is restored and restarted.

set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -f deploy/deploy.env ]]; then
  # shellcheck source=/dev/null
  source deploy/deploy.env
fi
: "${DEPLOY_HOST:?Set DEPLOY_HOST (ssh target) in deploy/deploy.env or the environment}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/smard-mcp}"
DEPLOY_NODE_BIN="${DEPLOY_NODE_BIN:-/opt/node-22/bin}"
DEPLOY_SERVICE="${DEPLOY_SERVICE:-smard-mcp}"
DEPLOY_PORT="${DEPLOY_PORT:-8450}"

step() { printf '\n== %s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

step "Checking the working tree"
[[ -z "$(git status --porcelain)" ]] || fail "uncommitted changes; commit or stash them first"
git fetch --quiet origin
[[ "$(git rev-parse HEAD)" == "$(git rev-parse '@{u}')" ]] || fail "HEAD differs from its upstream branch; push (or pull) first"
version="$(node -p 'require("./package.json").version')"
commit="$(git rev-parse --short HEAD)"
echo "Deploying smard-mcp $version ($commit) to $DEPLOY_HOST:$DEPLOY_DIR"

step "Typecheck, tests, build"
npm run typecheck
npm test --silent
npm run build

step "Keeping a copy of the running version"
ssh "$DEPLOY_HOST" "set -e; if [ -d '$DEPLOY_DIR' ]; then rm -rf '$DEPLOY_DIR.prev'; cp -a '$DEPLOY_DIR' '$DEPLOY_DIR.prev'; fi"

step "Uploading"
rsync -a --delete --exclude node_modules dist package.json package-lock.json "$DEPLOY_HOST:$DEPLOY_DIR/"

step "Installing dependencies and restarting"
ssh "$DEPLOY_HOST" "set -e; cd '$DEPLOY_DIR'; PATH='$DEPLOY_NODE_BIN':\$PATH npm ci --omit=dev --no-fund --no-audit --loglevel=error; chown -R root:root '$DEPLOY_DIR'; systemctl restart '$DEPLOY_SERVICE'"

step "Checking /health"
check_remote() {
  ssh "$DEPLOY_HOST" "for i in \$(seq 1 20); do curl -fsS http://127.0.0.1:$DEPLOY_PORT/health 2>/dev/null && exit 0; sleep 0.5; done; exit 1"
}
health="$(check_remote || true)"
if [[ "$health" != *"\"version\":\"$version\""* ]]; then
  echo "Health check failed: ${health:-no answer}" >&2
  step "Rolling back to the previous version"
  ssh "$DEPLOY_HOST" "set -e; if [ -d '$DEPLOY_DIR.prev' ]; then rm -rf '$DEPLOY_DIR'; mv '$DEPLOY_DIR.prev' '$DEPLOY_DIR'; systemctl restart '$DEPLOY_SERVICE'; fi"
  echo "Previous version after rollback: $(check_remote || echo 'no answer')" >&2
  fail "deployment of $version failed and was rolled back"
fi
echo "$health"

if [[ -n "${DEPLOY_PUBLIC_URL:-}" ]]; then
  public="$(curl -fsS "$DEPLOY_PUBLIC_URL/health" || true)"
  [[ "$public" == *"\"version\":\"$version\""* ]] || fail "server runs $version, but $DEPLOY_PUBLIC_URL/health answers: ${public:-nothing}"
  echo "Public: $public"
fi

step "Done: smard-mcp $version ($commit) is live"
