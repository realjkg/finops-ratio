#!/usr/bin/env bash
# One command for merge evidence on a Mac (Apple silicon or Intel); also runs on Linux.
#
#   ./scripts/evidence/mac-evidence.sh --pr 179 [--head <sha, 12+ hex>] [--base <ref>] [--repo <local clone>]
#                                      [--no-db] [--migration-smoke] [--keep] [--dry-run]
#
# Clones realjkg/finops-ratio into a temporary workspace, checks out the PR head, starts a throwaway,
# localhost-only Postgres 16 (trust auth, exactly like CI) and SeaweedFS by the same image digests as CI
# when Docker is available, runs scripts/evidence/collect-pr-evidence.mjs, copies evidence.md/evidence.json
# to ~/ratio-evidence/pr-<n>/<head sha>/ and removes what it created, by exact name.
#
# bash 3.2 compatible (macOS /bin/bash). Installs nothing silently, needs no secret, sends no telemetry.
# Exit codes: 0 all required gates passed; 1 a gate or check failed; 2 usage; 3 preflight/setup; 4 git/PR resolution.
set -u -o pipefail

REPO_URL="https://github.com/realjkg/finops-ratio"
REPO_SLUG="realjkg/finops-ratio"
PG_IMAGE="postgres:16@sha256:1a6ab3f5345eb6dbe04a1349529caabdb0ab09293a09590fad07b2246bfa4b54"
S3_IMAGE="chrislusf/seaweedfs@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d"
MIN_FREE_KB=$((5 * 1024 * 1024))
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COLLECTOR="$SCRIPT_DIR/collect-pr-evidence.mjs"
OUT_HOME="${RATIO_EVIDENCE_HOME:-$HOME/ratio-evidence}"
WS_BASE="${TMPDIR:-/tmp}"
WS_BASE="${WS_BASE%/}"

# Nothing the caller exported may reach the run: drop every inherited RATIO_* variable (app database URLs,
# RATIO_ENV, ...) except the two documented inputs of this script. The collector also runs gates with an
# environment allowlist.
for v in $(env | sed -n 's/^\(RATIO_[A-Za-z0-9_]*\)=.*/\1/p'); do
  case "$v" in RATIO_EVIDENCE_HOME|RATIO_EVIDENCE_CHROMIUM) ;; *) unset "$v" ;; esac
done

PR="" HEAD_ARG="" BASE_ARG="" LOCAL_REPO="" NO_DB=0 KEEP=0 DRY=0 SKIP_NETWORK=0 SMOKE="" SELF_TEST_WS=""
WS="" PG_NAME="" S3_NAME="" BREW_DB="" DB_MODE="none" DB_REASON="" CPID=""

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
fail() { local code="$1"; shift; printf 'error: %s\n' "$*" >&2; exit "$code"; }
usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; }
need_value() { if [ $# -lt 2 ] || [ -z "$2" ]; then fail 2 "$1 needs a value"; fi; case "$2" in --*) fail 2 "$1 needs a value";; esac; }

while [ $# -gt 0 ]; do
  case "$1" in
    --pr) need_value "$@"; PR="$2"; shift 2 ;;
    --head) need_value "$@"; HEAD_ARG="$2"; shift 2 ;;
    --base) need_value "$@"; BASE_ARG="$2"; shift 2 ;;
    --repo) need_value "$@"; LOCAL_REPO="$2"; shift 2 ;;
    --no-db) NO_DB=1; shift ;;
    --migration-smoke) SMOKE="--migration-smoke"; shift ;;
    --keep) KEEP=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --skip-network-check) SKIP_NETWORK=1; shift ;;
    --self-test-cleanup) need_value "$@"; SELF_TEST_WS="$2"; shift 2 ;; # test hook: exercise the cleanup guard only
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail 2 "unknown argument: $1" ;;
  esac
done

# --- cleanup: exact names only; a workspace is removed only if it is one this script creates --------
# shellcheck disable=SC2329 # used by cleanup
is_our_workspace() {
  local rest="${1#"$WS_BASE"/}"
  [ "$rest" != "$1" ] || return 1 # not directly under the workspace base
  case "$rest" in */*|.*) return 1 ;; ratio-evidence-pr[0-9]*.??????) [ -d "$1" ] && [ ! -L "$1" ] ;; *) return 1 ;; esac
}
# shellcheck disable=SC2329 # invoked by the EXIT trap
cleanup() {
  local rc=$?
  if [ -n "$CPID" ]; then kill -TERM "$CPID" 2>/dev/null; wait "$CPID" 2>/dev/null; fi
  if [ -n "$PG_NAME" ]; then docker rm -f -v "$PG_NAME" >/dev/null 2>&1 && say "removed container $PG_NAME"; fi
  if [ -n "$S3_NAME" ]; then docker rm -f -v "$S3_NAME" >/dev/null 2>&1 && say "removed container $S3_NAME"; fi
  if [ -n "$BREW_DB" ]; then dropdb --if-exists "$BREW_DB" >/dev/null 2>&1 && say "dropped database $BREW_DB"; fi
  if [ -n "$WS" ]; then
    if [ "$KEEP" = 1 ]; then say "kept workspace: $WS"
    elif is_our_workspace "$WS"; then
      if [ -d "$WS/repo/.git" ]; then git -C "$WS/repo" worktree prune >/dev/null 2>&1 || true; fi
      rm -rf "$WS" && say "removed workspace $WS"
    else warn "refusing to remove $WS: not a workspace this script created"
    fi
  fi
  exit "$rc"
}
trap cleanup EXIT
# INT/TERM: stop the collector first (it removes its own rollback worktree), then the EXIT trap cleans up.
trap 'say "interrupted"; exit 130' INT TERM

if [ -n "$SELF_TEST_WS" ]; then WS="$SELF_TEST_WS"; exit 0; fi

case "$PR" in ''|0*|*[!0-9]*) fail 2 "--pr <positive number> is required (got '${PR}')" ;; esac
if [ -n "$HEAD_ARG" ]; then
  case "$HEAD_ARG" in *[!0-9a-f]*) fail 2 "--head must be a lowercase hex SHA" ;; esac
  [ "${#HEAD_ARG}" -ge 12 ] || fail 2 "--head needs at least 12 hex characters (a full 40-character SHA is best)"
fi
if [ -n "$LOCAL_REPO" ] && [ ! -d "$LOCAL_REPO/.git" ]; then fail 2 "--repo $LOCAL_REPO is not a git clone"; fi

# --- preflight --------------------------------------------------------------------------------
PREFLIGHT_FAIL=0
ok() { say "  ok    $*"; }
bad() { say "  FAIL  $*"; PREFLIGHT_FAIL=1; }
info() { say "  note  $*"; }

say "Preflight"
if command -v git >/dev/null 2>&1; then ok "git $(git --version | awk '{print $3}')"
else bad "git not found. Install the Xcode Command Line Tools: xcode-select --install"; fi

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
FREE_KB="$(df -Pk "$WS_BASE" | awk 'NR==2 {print $4}')"
if [ -n "$FREE_KB" ] && [ "$FREE_KB" -ge "$MIN_FREE_KB" ]; then ok "disk: $((FREE_KB / 1024 / 1024)) GB free in $WS_BASE"
else bad "disk: need >= 5 GB free in $WS_BASE (have $(( ${FREE_KB:-0} / 1024 / 1024 )) GB). Free space or set TMPDIR to a larger volume."; fi

reach() { curl -sS -o /dev/null -m 15 "$1" 2>/dev/null; }
if [ "$SKIP_NETWORK" = 1 ]; then info "network check skipped (--skip-network-check)"
else
  for url in https://github.com https://registry.npmjs.org/; do
    if reach "$url"; then ok "network: $url"; else bad "network: cannot reach $url (check VPN/proxy; git and npm need it)"; fi
  done
  if [ -z "${RATIO_EVIDENCE_CHROMIUM:-}" ]; then
    if reach https://cdn.playwright.dev/ || reach https://playwright.download.prss.microsoft.com/; then ok "network: Playwright browser download hosts"
    else info "cannot reach cdn.playwright.dev or playwright.download.prss.microsoft.com: the browser gates will be NOT RUN (or set RATIO_EVIDENCE_CHROMIUM)"; fi
  fi
fi

PG16_BIN=""
for d in "$(brew --prefix postgresql@16 2>/dev/null)/bin" /opt/homebrew/opt/postgresql@16/bin /usr/local/opt/postgresql@16/bin /usr/lib/postgresql/16/bin; do
  if [ -x "$d/pg_dump" ] && [ -x "$d/psql" ] && "$d/pg_dump" --version 2>/dev/null | grep -q ' 16\.'; then PG16_BIN="$d"; break; fi
done
if [ "$NO_DB" = 1 ]; then DB_MODE="none"; DB_REASON="skipped by --no-db"; info "database gates: skipped (--no-db)"
elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  DB_MODE="docker"; ok "docker: running (Postgres 16 + SeaweedFS by digest, localhost only, ephemeral)"
  if [ "$SKIP_NETWORK" = 0 ] && ! docker image inspect "$PG_IMAGE" >/dev/null 2>&1 && ! reach https://registry-1.docker.io/v2/; then
    bad "Docker Hub (registry-1.docker.io) unreachable and the pinned images are not cached; allow it or use --no-db"
  fi
elif command -v pg_isready >/dev/null 2>&1 && pg_isready -q -h localhost >/dev/null 2>&1 && command -v createdb >/dev/null 2>&1; then
  DB_MODE="brew"; ok "Homebrew Postgres: running (migration checks only; test:db also needs S3, so it is recorded NOT RUN)"
else
  DB_MODE="none"; DB_REASON="no Docker and no running local Postgres"
  info "database gates: NOT RUN ($DB_REASON). Start Docker Desktop/Colima/OrbStack, or: brew install postgresql@16 && brew services start postgresql@16"
fi
if [ "$DB_MODE" = docker ]; then
  if [ -n "$PG16_BIN" ]; then ok "pg_dump/psql 16: $PG16_BIN"
  else info "PG16 client tools not found: test:db will be NOT RUN (its pg_dump round-trip needs them). Fix: brew install postgresql@16"; fi
fi
if [ "$PREFLIGHT_FAIL" = 1 ]; then fail 3 "preflight failed: fix the FAIL lines above and run again"; fi

say ""
say "Plan"
say "  PR:         #$PR ($REPO_URL)"
say "  head:       ${HEAD_ARG:-PR head from pull/$PR/head}"
say "  base:       ${BASE_ARG:-merge-base with the PR base branch (gh if authenticated, else main)}"
say "  source:     ${LOCAL_REPO:-fresh clone of $REPO_URL}"
say "  database:   $DB_MODE${DB_REASON:+ ($DB_REASON)}"
say "  migrations: changed ones only${SMOKE:+, plus the full-set smoke (--migration-smoke)}"
say "  browser:    ${RATIO_EVIDENCE_CHROMIUM:-Playwright-managed Chromium (npx playwright install chromium)}"
say "  collector:  $COLLECTOR"
say "  output:     $OUT_HOME/pr-$PR/<head sha>/evidence.md and evidence.json"
say "  workspace:  $WS_BASE/ratio-evidence-pr$PR.XXXXXX ($([ "$KEEP" = 1 ] && echo kept || echo removed at the end))"
if [ "$DRY" = 1 ]; then say ""; say "dry run: nothing cloned, started or written"; exit 0; fi

# --- workspace and sources --------------------------------------------------------------------
WS="$(mktemp -d "$WS_BASE/ratio-evidence-pr$PR.XXXXXX")" || fail 3 "cannot create a temporary workspace"
mkdir -p "$WS/tmp"
say ""; say "Workspace: $WS"
if [ -n "$LOCAL_REPO" ]; then git clone --quiet --no-hardlinks -- "$LOCAL_REPO" "$WS/repo" || fail 4 "clone of $LOCAL_REPO failed"
else git clone --quiet -- "$REPO_URL" "$WS/repo" || fail 4 "clone of $REPO_URL failed"; fi
cd "$WS/repo" || fail 4 "no clone"
git fetch --quiet -- "$REPO_URL" "pull/$PR/head" || fail 4 "cannot fetch pull/$PR/head (does PR #$PR exist?)"
HEAD_SHA="$(git rev-parse FETCH_HEAD)"
if [ -n "$HEAD_ARG" ]; then
  case "$HEAD_SHA" in "$HEAD_ARG"*) ;; *) fail 4 "PR #$PR head is $HEAD_SHA, not --head $HEAD_ARG (the PR moved?)" ;; esac
fi
BASE_BRANCH="main"
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  b="$(gh pr view "$PR" --repo "$REPO_SLUG" --json baseRefName -q .baseRefName 2>/dev/null || true)"
  [ -n "$b" ] && BASE_BRANCH="$b"
fi
git fetch --quiet -- "$REPO_URL" "$BASE_BRANCH" || fail 4 "cannot fetch base branch $BASE_BRANCH"
BASE_TIP="$(git rev-parse FETCH_HEAD)"
if [ -n "$BASE_ARG" ]; then BASE_SHA="$(git rev-parse --verify --end-of-options "$BASE_ARG^{commit}" 2>/dev/null)" || fail 4 "--base $BASE_ARG not found"
else BASE_SHA="$(git merge-base "$BASE_TIP" "$HEAD_SHA")" || fail 4 "no merge-base between $BASE_BRANCH and the PR head"; fi
git checkout --quiet --detach "$HEAD_SHA" || fail 4 "checkout of $HEAD_SHA failed"
say "head $HEAD_SHA, base $BASE_SHA ($BASE_BRANCH; the collector uses the merge-base)"

say "Installing dependencies"
npm ci --no-audit --no-fund >"$WS/npm-ci.log" 2>&1 || fail 3 "npm ci failed (see $WS/npm-ci.log; run with --keep to inspect)"
if [ -z "${RATIO_EVIDENCE_CHROMIUM:-}" ]; then
  say "Installing the pinned Playwright Chromium (cache: ~/Library/Caches/ms-playwright on macOS)"
  npx --no-install playwright install chromium >"$WS/playwright-install.log" 2>&1 || warn "Playwright Chromium download failed (see $WS/playwright-install.log): the browser gates will be NOT RUN"
fi

# --- database (localhost only, ephemeral, trust auth exactly like CI) -------------------------
free_port() { node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close();})"; }
if [ "$DB_MODE" = docker ]; then
  SUFFIX="$(node -e "process.stdout.write(require('crypto').randomBytes(4).toString('hex'))")"
  for img in "$PG_IMAGE" "$S3_IMAGE"; do
    docker image inspect "$img" >/dev/null 2>&1 || docker pull -q "$img" >/dev/null || fail 3 "docker could not pull $img (Docker Hub blocked or rate-limited?); retry later or use --no-db"
  done
  PG_PORT="$(free_port)"; S3_PORT="$(free_port)"
  PG_NAME="ratio-evidence-pg-$PR-$SUFFIX"
  say "Starting $PG_NAME on 127.0.0.1:$PG_PORT (trust auth, tmpfs, removed at the end)"
  docker run -d --name "$PG_NAME" -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_USER=postgres --tmpfs /var/lib/postgresql/data \
    -p "127.0.0.1:$PG_PORT:5432" "$PG_IMAGE" >/dev/null || fail 3 "docker could not start Postgres (port taken? docker logs $PG_NAME)"
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
  export RATIO_EVIDENCE_TEST_DATABASE_URL="postgres://postgres@127.0.0.1:$PG_PORT/postgres"
  export RATIO_EVIDENCE_SCRATCH_DATABASE_URL="postgres://postgres@127.0.0.1:$PG_PORT/ratio_evidence_migrate"
  export RATIO_EVIDENCE_S3_ENDPOINT="http://127.0.0.1:$S3_PORT"
  if [ -n "$PG16_BIN" ]; then export RATIO_EVIDENCE_PG_DUMP="$PG16_BIN/pg_dump" RATIO_EVIDENCE_PSQL="$PG16_BIN/psql"; fi
elif [ "$DB_MODE" = brew ]; then
  BREW_DB="ratio_evidence_${PR}_$(node -e "process.stdout.write(require('crypto').randomBytes(4).toString('hex'))")"
  createdb "$BREW_DB" || fail 3 "createdb $BREW_DB failed"
  say "Created database $BREW_DB"
  RATIO_EVIDENCE_SCRATCH_DATABASE_URL="postgres://$(id -un)@127.0.0.1:5432/$BREW_DB"
  export RATIO_EVIDENCE_SCRATCH_DATABASE_URL
fi

# --- evidence (collector in the background so INT/TERM reach it promptly) ----------------------
PORT="$(free_port)"
say ""; say "Running the evidence collector (about 15-25 minutes)"
# shellcheck disable=SC2086 # $SMOKE is one optional flag
TMPDIR="$WS/tmp" node "$COLLECTOR" --base "$BASE_SHA" --head "$HEAD_SHA" --pr "$PR" --out "$WS/evidence" --logs "$WS/logs" --port "$PORT" $SMOKE &
CPID=$!
trap 'say "interrupted: stopping the collector"; kill -TERM "$CPID" 2>/dev/null; wait "$CPID" 2>/dev/null; CPID=""; exit 130' INT TERM
wait "$CPID"
RC=$?
CPID=""
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
