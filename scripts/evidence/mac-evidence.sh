#!/usr/bin/env bash
# One command for merge evidence on a Mac (Apple silicon or Intel); also runs on Linux.
#
#   ./scripts/evidence/mac-evidence.sh --pr 179 [--head <sha>] [--base <ref>] [--repo <local clone>]
#                                      [--no-db] [--keep] [--dry-run]
#
# Clones realjkg/finops-ratio into a temporary workspace, checks out the PR head, starts a throwaway
# Postgres 16 + SeaweedFS (Docker, pinned by the same digests as CI) when it can, runs
# scripts/evidence/collect-pr-evidence.mjs, copies evidence.md/evidence.json to
# ~/ratio-evidence/pr-<n>/<head sha>/ and cleans up everything it created, by exact name.
#
# bash 3.2 compatible (macOS /bin/bash). Installs nothing silently, needs no secret, sends no telemetry,
# writes only to its workspace and ~/ratio-evidence (plus the Docker containers it names).
# Exit codes: 0 all required gates passed; 1 a gate or check failed; 2 usage; 3 preflight; 4 git/PR resolution.
set -u -o pipefail

REPO_URL="https://github.com/realjkg/finops-ratio"
REPO_SLUG="realjkg/finops-ratio"
PG_IMAGE="postgres:16@sha256:1a6ab3f5345eb6dbe04a1349529caabdb0ab09293a09590fad07b2246bfa4b54"
S3_IMAGE="chrislusf/seaweedfs@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d"
MIN_FREE_KB=$((5 * 1024 * 1024))
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COLLECTOR="$SCRIPT_DIR/collect-pr-evidence.mjs"
OUT_HOME="${RATIO_EVIDENCE_HOME:-$HOME/ratio-evidence}"

PR="" HEAD_ARG="" BASE_ARG="" LOCAL_REPO="" NO_DB=0 KEEP=0 DRY=0 SKIP_NETWORK=0
WS="" PG_NAME="" S3_NAME="" BREW_DB="" DB_MODE="none" DB_REASON=""

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
fail() { local code="$1"; shift; printf 'error: %s\n' "$*" >&2; exit "$code"; }
usage() {
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --pr) [ $# -ge 2 ] || fail 2 "--pr needs a number"; PR="$2"; shift 2 ;;
    --head) [ $# -ge 2 ] || fail 2 "--head needs a SHA"; HEAD_ARG="$2"; shift 2 ;;
    --base) [ $# -ge 2 ] || fail 2 "--base needs a ref or SHA"; BASE_ARG="$2"; shift 2 ;;
    --repo) [ $# -ge 2 ] || fail 2 "--repo needs a path"; LOCAL_REPO="$2"; shift 2 ;;
    --no-db) NO_DB=1; shift ;;
    --keep) KEEP=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --skip-network-check) SKIP_NETWORK=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail 2 "unknown argument: $1" ;;
  esac
done
case "$PR" in ''|*[!0-9]*) fail 2 "--pr <number> is required (got '${PR}')" ;; esac
if [ -n "$HEAD_ARG" ]; then case "$HEAD_ARG" in *[!0-9a-f]*) fail 2 "--head must be a full or abbreviated lowercase SHA" ;; esac; fi
if [ -n "$LOCAL_REPO" ] && [ ! -d "$LOCAL_REPO/.git" ]; then fail 2 "--repo $LOCAL_REPO is not a git clone"; fi

# --- cleanup (exact names only) -----------------------------------------------------------------
# shellcheck disable=SC2329 # invoked by the EXIT trap
cleanup() {
  local rc=$?
  if [ -n "$PG_NAME" ]; then docker rm -f -v "$PG_NAME" >/dev/null 2>&1 && say "removed container $PG_NAME"; fi
  if [ -n "$S3_NAME" ]; then docker rm -f -v "$S3_NAME" >/dev/null 2>&1 && say "removed container $S3_NAME"; fi
  if [ -n "$BREW_DB" ]; then dropdb --if-exists "$BREW_DB" >/dev/null 2>&1 && say "dropped database $BREW_DB"; fi
  if [ -n "$WS" ] && [ -d "$WS" ]; then
    if [ "$KEEP" = 1 ]; then say "kept workspace: $WS"
    else
      if [ -d "$WS/repo/.git" ]; then git -C "$WS/repo" worktree prune >/dev/null 2>&1 || true; fi
      rm -rf "$WS" && say "removed workspace $WS"
    fi
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# --- preflight --------------------------------------------------------------------------------
PREFLIGHT_FAIL=0
ok() { say "  ok    $*"; }
bad() { say "  FAIL  $*"; PREFLIGHT_FAIL=1; }
info() { say "  note  $*"; }

say "Preflight"
if command -v git >/dev/null 2>&1; then ok "git $(git --version | awk '{print $3}')"
else bad "git not found. Install the Xcode Command Line Tools: xcode-select --install"; fi

# Node: the repo's engines range (">=22.13"), from this script's checkout.
NODE_MIN="$(sed -n 's/.*"node": *">=\([0-9][0-9.]*\)".*/\1/p' "$SCRIPT_DIR/../../package.json" | head -n 1)"
[ -n "$NODE_MIN" ] || NODE_MIN="22.13"
NODE_MAJOR_MIN="${NODE_MIN%%.*}"
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e "const [a,b]=process.versions.node.split('.').map(Number);const [x,y]=process.argv[1].split('.').map(Number);process.exit(a>x||(a===x&&b>=y)?0:1)" "$NODE_MIN"
}
if ! node_ok; then
  # Select an installed version with a version manager when one is present (never installs).
  if [ -n "${NVM_DIR:-}" ] && [ -s "$NVM_DIR/nvm.sh" ]; then # shellcheck source=/dev/null
    . "$NVM_DIR/nvm.sh" >/dev/null 2>&1; nvm use "$NODE_MAJOR_MIN" >/dev/null 2>&1 || true
  elif command -v fnm >/dev/null 2>&1; then eval "$(fnm env 2>/dev/null)"; fnm use "$NODE_MAJOR_MIN" >/dev/null 2>&1 || true
  elif command -v volta >/dev/null 2>&1; then info "volta found: run 'volta install node@$NODE_MAJOR_MIN' if the check below fails"
  fi
fi
if node_ok; then ok "node $(node -v) (needs >= $NODE_MIN)"
else
  hint="brew install node@$NODE_MAJOR_MIN && brew link --overwrite node@$NODE_MAJOR_MIN"
  if [ -n "${NVM_DIR:-}" ]; then hint="nvm install $NODE_MAJOR_MIN && nvm use $NODE_MAJOR_MIN"
  elif command -v fnm >/dev/null 2>&1; then hint="fnm install $NODE_MAJOR_MIN && fnm use $NODE_MAJOR_MIN"
  elif command -v volta >/dev/null 2>&1; then hint="volta install node@$NODE_MAJOR_MIN"; fi
  bad "node >= $NODE_MIN required (found: $(node -v 2>/dev/null || echo none)). Run: $hint"
fi
if command -v npm >/dev/null 2>&1; then ok "npm $(npm -v)"; else bad "npm not found (it ships with Node)"; fi

if [ -d "$OUT_HOME" ]; then if [ -w "$OUT_HOME" ]; then ok "output: $OUT_HOME"; else bad "cannot write to $OUT_HOME"; fi
elif [ -w "$(dirname "$OUT_HOME")" ]; then ok "output: $OUT_HOME (created on the real run)"
else bad "cannot create $OUT_HOME (set RATIO_EVIDENCE_HOME to a writable folder)"; fi
FREE_KB="$(df -Pk "${TMPDIR:-/tmp}" | awk 'NR==2 {print $4}')"
if [ -n "$FREE_KB" ] && [ "$FREE_KB" -ge "$MIN_FREE_KB" ]; then ok "disk: $((FREE_KB / 1024 / 1024)) GB free in ${TMPDIR:-/tmp}"
else bad "disk: need >= 5 GB free in ${TMPDIR:-/tmp} (have $(( ${FREE_KB:-0} / 1024 / 1024 )) GB). Free space or set TMPDIR to a larger volume."; fi

if [ "$SKIP_NETWORK" = 1 ]; then info "network check skipped (--skip-network-check)"
else
  for url in https://github.com https://registry.npmjs.org/; do
    if curl -sS -o /dev/null -m 15 "$url" 2>/dev/null; then ok "network: $url"
    else bad "network: cannot reach $url (check VPN/proxy; npm and git need it)"; fi
  done
fi

# Database tools: Docker (Docker Desktop, Colima, OrbStack) first, then Homebrew Postgres.
PG16_BIN=""
for d in "$(brew --prefix postgresql@16 2>/dev/null)/bin" /opt/homebrew/opt/postgresql@16/bin /usr/local/opt/postgresql@16/bin /usr/lib/postgresql/16/bin; do
  if [ -x "$d/pg_dump" ] && [ -x "$d/psql" ] && "$d/pg_dump" --version 2>/dev/null | grep -q ' 16\.'; then PG16_BIN="$d"; break; fi
done
if [ "$NO_DB" = 1 ]; then DB_MODE="none"; DB_REASON="skipped by --no-db"; info "database gates: skipped (--no-db)"
elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then DB_MODE="docker"; ok "docker: running (Postgres 16 + SeaweedFS by digest)"
elif command -v pg_isready >/dev/null 2>&1 && pg_isready -q -h localhost >/dev/null 2>&1 && command -v createdb >/dev/null 2>&1; then
  DB_MODE="brew"; ok "Homebrew Postgres: running (migrations only; test:db also needs S3, so it is recorded NOT RUN)"
else
  DB_MODE="none"; DB_REASON="no Docker and no running local Postgres"
  info "database gates: NOT RUN ($DB_REASON). Start Docker Desktop/Colima/OrbStack, or: brew install postgresql@16 && brew services start postgresql@16"
fi
if [ "$DB_MODE" = docker ] && [ -z "$PG16_BIN" ]; then info "PG16 client tools not found: test:db will be NOT RUN (its pg_dump round-trip needs them). Fix: brew install postgresql@16"; fi
if [ "$DB_MODE" = docker ] && [ -n "$PG16_BIN" ]; then ok "pg_dump/psql 16: $PG16_BIN"; fi

if [ "$PREFLIGHT_FAIL" = 1 ]; then fail 3 "preflight failed: fix the FAIL lines above and run again"; fi

say ""
say "Plan"
say "  PR:         #$PR ($REPO_URL)"
say "  head:       ${HEAD_ARG:-PR head from pull/$PR/head}"
say "  base:       ${BASE_ARG:-merge-base with the PR base branch (gh if authenticated, else main)}"
say "  source:     ${LOCAL_REPO:-fresh clone of $REPO_URL}"
say "  database:   $DB_MODE${DB_REASON:+ ($DB_REASON)}"
say "  collector:  $COLLECTOR"
say "  output:     $OUT_HOME/pr-$PR/<head sha>/evidence.md and evidence.json"
say "  workspace:  ${TMPDIR:-/tmp}/ratio-evidence-pr$PR.XXXXXX ($([ "$KEEP" = 1 ] && echo kept || echo removed at the end))"
if [ "$DRY" = 1 ]; then say ""; say "dry run: nothing cloned, started or written"; exit 0; fi

# --- workspace and sources --------------------------------------------------------------------
WS="$(mktemp -d "${TMPDIR:-/tmp}/ratio-evidence-pr$PR.XXXXXX")" || fail 3 "cannot create a temporary workspace"
say ""; say "Workspace: $WS"
if [ -n "$LOCAL_REPO" ]; then git clone --quiet --no-hardlinks "$LOCAL_REPO" "$WS/repo" || fail 4 "clone of $LOCAL_REPO failed"
else git clone --quiet "$REPO_URL" "$WS/repo" || fail 4 "clone of $REPO_URL failed"; fi
cd "$WS/repo" || fail 4 "no clone"
git fetch --quiet "$REPO_URL" "pull/$PR/head" || fail 4 "cannot fetch pull/$PR/head (does PR #$PR exist?)"
HEAD_SHA="$(git rev-parse FETCH_HEAD)"
if [ -n "$HEAD_ARG" ]; then
  case "$HEAD_SHA" in "$HEAD_ARG"*) ;; *) fail 4 "PR #$PR head is $HEAD_SHA, not --head $HEAD_ARG (the PR moved?)" ;; esac
fi
BASE_BRANCH="main"
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  b="$(gh pr view "$PR" --repo "$REPO_SLUG" --json baseRefName -q .baseRefName 2>/dev/null || true)"
  [ -n "$b" ] && BASE_BRANCH="$b"
fi
git fetch --quiet "$REPO_URL" "$BASE_BRANCH" || fail 4 "cannot fetch base branch $BASE_BRANCH"
BASE_TIP="$(git rev-parse FETCH_HEAD)"
if [ -n "$BASE_ARG" ]; then BASE_SHA="$(git rev-parse --verify "$BASE_ARG^{commit}" 2>/dev/null)" || fail 4 "--base $BASE_ARG not found"
else BASE_SHA="$(git merge-base "$BASE_TIP" "$HEAD_SHA")" || fail 4 "no merge-base between $BASE_BRANCH and the PR head"; fi
git checkout --quiet --detach "$HEAD_SHA" || fail 4 "checkout of $HEAD_SHA failed"
say "head $HEAD_SHA, base $BASE_SHA ($BASE_BRANCH)"

say "Installing dependencies and the pinned Playwright Chromium"
npm ci --no-audit --no-fund >"$WS/npm-ci.log" 2>&1 || fail 3 "npm ci failed (see $WS/npm-ci.log; run with --keep to inspect)"
npx --no-install playwright install chromium >"$WS/playwright-install.log" 2>&1 || warn "Playwright Chromium download failed (see $WS/playwright-install.log): the browser gates will be NOT RUN"

# --- database ---------------------------------------------------------------------------------
free_port() { node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close();})"; }
if [ "$DB_MODE" = docker ]; then
  SUFFIX="$(node -e "process.stdout.write(require('crypto').randomBytes(4).toString('hex'))")"
  POSTGRES_PASSWORD="$(node -e "process.stdout.write(require('crypto').randomBytes(24).toString('hex'))")"
  export POSTGRES_PASSWORD
  PG_PORT="$(free_port)"; S3_PORT="$(free_port)"
  PG_NAME="ratio-evidence-pg-$PR-$SUFFIX"
  say "Starting $PG_NAME on 127.0.0.1:$PG_PORT"
  docker run -d --name "$PG_NAME" -e POSTGRES_PASSWORD -e POSTGRES_USER=postgres --tmpfs /var/lib/postgresql/data \
    -p "127.0.0.1:$PG_PORT:5432" "$PG_IMAGE" >/dev/null || fail 3 "docker could not start Postgres (port in use? docker logs $PG_NAME)"
  S3_NAME="ratio-evidence-s3-$PR-$SUFFIX"
  say "Starting $S3_NAME on 127.0.0.1:$S3_PORT"
  docker run -d --name "$S3_NAME" --tmpfs /data -p "127.0.0.1:$S3_PORT:8333" "$S3_IMAGE" \
    server -s3 -dir=/data -volume.max=64 -master.volumeSizeLimitMB=64 >/dev/null || fail 3 "docker could not start SeaweedFS"
  ready=0; i=0
  while [ $i -lt 90 ]; do
    if docker exec "$PG_NAME" pg_isready -q -U postgres -h 127.0.0.1 -p 5432 >/dev/null 2>&1 && curl -s -o /dev/null "http://127.0.0.1:$S3_PORT/"; then ready=1; break; fi
    i=$((i + 1)); sleep 2
  done
  [ "$ready" = 1 ] || fail 3 "Postgres/SeaweedFS not ready after 180 s (docker logs $PG_NAME; docker logs $S3_NAME)"
  docker exec "$PG_NAME" psql -q -U postgres -c "CREATE DATABASE ratio_evidence_migrate" >/dev/null || fail 3 "could not create the scratch migration database"
  export RATIO_TEST_DATABASE_URL="postgres://postgres:$POSTGRES_PASSWORD@127.0.0.1:$PG_PORT/postgres"
  export RATIO_MIGRATE_DATABASE_URL="postgres://postgres:$POSTGRES_PASSWORD@127.0.0.1:$PG_PORT/ratio_evidence_migrate"
  export RATIO_TEST_S3_ENDPOINT="http://127.0.0.1:$S3_PORT"
  if [ -n "$PG16_BIN" ]; then export RATIO_PG_DUMP="$PG16_BIN/pg_dump" RATIO_PSQL="$PG16_BIN/psql"; fi
elif [ "$DB_MODE" = brew ]; then
  BREW_DB="ratio_evidence_${PR}_$(node -e "process.stdout.write(require('crypto').randomBytes(4).toString('hex'))")"
  createdb "$BREW_DB" || fail 3 "createdb $BREW_DB failed"
  say "Created database $BREW_DB"
  RATIO_MIGRATE_DATABASE_URL="postgres://$(id -un)@127.0.0.1:5432/$BREW_DB"
  export RATIO_MIGRATE_DATABASE_URL
fi

# --- evidence ---------------------------------------------------------------------------------
PORT="$(free_port)"
say ""; say "Running the evidence collector (about 15-25 minutes)"
node "$COLLECTOR" --base "$BASE_SHA" --head "$HEAD_SHA" --pr "$PR" --out "$WS/evidence" --logs "$WS/logs" --port "$PORT"
RC=$?
DEST="$OUT_HOME/pr-$PR/$HEAD_SHA"
if [ -f "$WS/evidence/evidence.md" ]; then
  mkdir -p "$DEST" && cp "$WS/evidence/evidence.md" "$WS/evidence/evidence.json" "$DEST/"
  say ""; say "Summary (PR #$PR, head $HEAD_SHA)"
  node -e "const e=require(process.argv[1]);for(const c of e.charter)console.log(String(c.id).padEnd(3)+c.status.padEnd(24)+c.item);console.log('');for(const g of e.gates)console.log(g.status.padEnd(9)+g.name)" "$DEST/evidence.json"
  say ""; say "Evidence: $DEST/evidence.md"
  say "Send it back: attach evidence.md and evidence.json to PR #$PR (or paste the summary above as a comment)."
  if [ -t 1 ] && command -v open >/dev/null 2>&1; then open "$DEST/evidence.md" || true; fi
else
  warn "the collector wrote no evidence (exit $RC); rerun with --keep and see $WS/logs"
fi
exit "$RC"
