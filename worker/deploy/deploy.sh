#!/usr/bin/env bash
#
# Zora presence worker — build + install on the Linux host.
#
# One script, three callers:
#   1. worker/deploy/bootstrap.sh                 first install on a fresh VM
#   2. zora-worker-update.timer                   pull-based redeploy (no inbound access needed)
#   3. .github/workflows/deploy-worker.yml        self-hosted runner (logs visible in the browser)
#
# It is idempotent: when the checked-out commit is already installed and the
# binary is present, it exits without rebuilding unless --force is given.
#
# Usage (as root):
#   bash worker/deploy/deploy.sh [--force] [--no-sync] [--branch REF]
#                                [--src DIR] [--install-dir DIR] [--sdk-root DIR]
#
# Environment (all optional):
#   GITHUB_REPO, BRANCH            source repo + ref (default: this project, main)
#   ZORA_API_BASE                  when set together with WORKER_SHARED_SECRET,
#   WORKER_SHARED_SECRET           /etc/zora-worker.env is rewritten (never logged)
#   DISCORD_APP_ID, POLL_INTERVAL_MS
#   INSTALL_DIR, SDK_ROOT, ENV_FILE, SERVICE_NAME, RUN_USER
#
# The Discord Social SDK is proprietary and never enters the repository. When it
# is present at $SDK_ROOT (containing include/discordpp.h and
# lib/release/libdiscord_partner_sdk.so) the worker is built in native mode and
# publishes real Rich Presence. When it is absent the worker is built in dry-run
# mode, which runs the identical control-plane loop and logs what it would push.

set -euo pipefail

REPO_URL="${GITHUB_REPO:-https://github.com/Z480-fly/rich-status-studio.git}"
BRANCH="${BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-/opt/zora-presence-worker}"
SDK_ROOT="${SDK_ROOT:-/opt/discord_social_sdk}"
ENV_FILE="${ENV_FILE:-/etc/zora-worker.env}"
SERVICE_NAME="${SERVICE_NAME:-zora-presence-worker}"
RUN_USER="${RUN_USER:-zora}"
UNIT_DIR="${UNIT_DIR:-/etc/systemd/system}"
SRC_DIR="${SRC_DIR:-/opt/rich-status-studio}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_FROM_SCRIPT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

FORCE=0
SYNC=1
SRC_EXPLICIT=0

log() { printf '[%s] deploy: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
warn() { log "WARN: $*"; }
fail() {
  log "ERROR: $*"
  exit 1
}

usage() {
  cat >&2 <<'USAGE'
Build + install the Zora presence worker; idempotent, safe to run repeatedly.

  bash worker/deploy/deploy.sh [--force] [--no-sync] [--branch REF]
       [--src DIR] [--install-dir DIR] [--sdk-root DIR]

  --force      rebuild even when this commit is already installed
  --no-sync    build the checkout this script lives in (used by CI)
  --src DIR    deploy checkout to sync/build from (default /opt/rich-status-studio)
  --sdk-root   where the Discord Social SDK is unpacked (default /opt/discord_social_sdk)
USAGE
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1 ;;
    --no-sync) SYNC=0 ;;
    --branch)
      BRANCH="${2:?--branch needs a value}"
      shift
      ;;
    --src)
      SRC_DIR="${2:?--src needs a value}"
      SRC_EXPLICIT=1
      shift
      ;;
    --install-dir)
      INSTALL_DIR="${2:?--install-dir needs a value}"
      shift
      ;;
    --sdk-root)
      SDK_ROOT="${2:?--sdk-root needs a value}"
      shift
      ;;
    -h | --help) usage ;;
    *) fail "unknown argument: $1 (try --help)" ;;
  esac
  shift
done

[ "$(id -u)" -eq 0 ] || fail "must run as root (use sudo)"

# --no-sync with no explicit --src builds the checkout this script lives in.
# That is how the GitHub Actions job builds the code actions/checkout fetched.
if [ "$SYNC" -eq 0 ] && [ "$SRC_EXPLICIT" -eq 0 ]; then
  SRC_DIR="$REPO_ROOT_FROM_SCRIPT"
fi

# ---------------------------------------------------------------------------
# Build dependencies
# ---------------------------------------------------------------------------

need_tools() {
  local missing=()
  local tool
  for tool in git cmake c++ curl; do
    command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
  done
  [ "${#missing[@]}" -eq 0 ] && return 0

  log "installing build dependencies: ${missing[*]}"
  if ! command -v apt-get >/dev/null 2>&1; then
    fail "missing ${missing[*]} and apt-get is unavailable — install them first"
  fi
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq || warn "apt-get update failed; trying to continue"
  # libasound2-dev is required by CMake in native mode; the pulse/X11 runtime
  # libraries are what libdiscord_partner_sdk.so itself links against.
  apt-get install -y --no-install-recommends \
    git cmake build-essential pkg-config ca-certificates curl \
    libcurl4-openssl-dev libasound2-dev libpulse0 libx11-6 unzip \
    || fail "apt-get install failed"
}

need_tools

# ---------------------------------------------------------------------------
# Source sync (the repository is public, so no credentials are involved)
# ---------------------------------------------------------------------------

sync_source() {
  [ "$SYNC" -eq 1 ] || return 0

  mkdir -p "$(dirname "$SRC_DIR")"
  if [ -d "${SRC_DIR}/.git" ]; then
    log "fetching ${BRANCH} in ${SRC_DIR}"
    git -C "$SRC_DIR" fetch --quiet --depth 1 origin "$BRANCH" \
      || fail "git fetch failed for ${REPO_URL}"
    # This is a dedicated deploy checkout, never a working tree: move it to the
    # fetched commit so the build always matches the branch.
    git -C "$SRC_DIR" checkout --quiet --force FETCH_HEAD \
      || fail "git checkout failed in ${SRC_DIR}"
  else
    log "cloning ${REPO_URL} into ${SRC_DIR}"
    rm -rf "$SRC_DIR"
    git clone --quiet --depth 1 --branch "$BRANCH" "$REPO_URL" "$SRC_DIR" \
      || fail "git clone failed for ${REPO_URL}"
  fi
}

sync_source

[ -f "${SRC_DIR}/worker/CMakeLists.txt" ] || fail "no worker/CMakeLists.txt under ${SRC_DIR}"
[ -f "${SRC_DIR}/worker/src/main.cpp" ] || fail "no worker/src/main.cpp under ${SRC_DIR}"

COMMIT="$(git -C "$SRC_DIR" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"

# ---------------------------------------------------------------------------
# Build mode
# ---------------------------------------------------------------------------

find_sdk_lib() {
  local root="$1"
  ls "${root}"/lib/release/libdiscord_partner_sdk.so \
    "${root}"/lib/libdiscord_partner_sdk.so 2>/dev/null | head -n 1 || true
}

# Prefer the SDK staged outside the checkout (the repository is public, so the
# proprietary SDK can never live in it). The CMake default is the repo's
# worker/third_party/discord_social_sdk, which is also honoured when present.
BUILTIN_SDK_ROOT="${SRC_DIR}/worker/third_party/discord_social_sdk"
SDK_INCLUDE="${SDK_ROOT}/include/discordpp.h"
SDK_LIB="$(find_sdk_lib "$SDK_ROOT")"

CMAKE_ARGS=(-S "${SRC_DIR}/worker" -B "${SRC_DIR}/worker/build" -DCMAKE_BUILD_TYPE=Release)
if [ -n "$SDK_LIB" ] && [ -f "$SDK_INCLUDE" ]; then
  MODE=native
  CMAKE_ARGS+=("-DDISCORD_SDK_ROOT=${SDK_ROOT}")
elif [ -f "${BUILTIN_SDK_ROOT}/include/discordpp.h" ] && \
  [ -n "$(find_sdk_lib "$BUILTIN_SDK_ROOT")" ]; then
  MODE=native
else
  MODE=dry-run
  if [ -f "$SDK_INCLUDE" ] || [ -n "$SDK_LIB" ]; then
    warn "incomplete SDK at ${SDK_ROOT} — expected both include/discordpp.h and lib/release/libdiscord_partner_sdk.so"
  else
    warn "no Discord Social SDK found — building the dry-run worker (presence is logged, not published)"
  fi
fi

STAMP_FILE="${INSTALL_DIR}/.deployed-commit"
MODE_FILE="${INSTALL_DIR}/.build-mode"
BINARY="${INSTALL_DIR}/zora-presence-worker"

if [ "$FORCE" -eq 0 ] && [ -x "$BINARY" ] && [ -f "$STAMP_FILE" ]; then
  if [ "$(cat "$STAMP_FILE" 2>/dev/null || true)" = "${COMMIT}:${MODE}" ]; then
    log "commit ${COMMIT} (${MODE}) already installed — nothing to do (use --force to rebuild)"
  else
    FORCE=1
  fi
else
  FORCE=1
fi

if [ "$FORCE" -eq 1 ]; then
  log "building ${MODE} worker from ${SRC_DIR} @ ${COMMIT}"
  cmake "${CMAKE_ARGS[@]}" >&2 || fail "cmake configure failed"
  cmake --build "${SRC_DIR}/worker/build" --parallel "$(nproc 2>/dev/null || echo 2)" >&2 \
    || fail "cmake build failed"

  BUILT_BINARY="${SRC_DIR}/worker/build/zora-presence-worker"
  [ -x "$BUILT_BINARY" ] || fail "expected binary not produced at ${BUILT_BINARY}"

  # ---------------------------------------------------------------------------
  # Install
  # ---------------------------------------------------------------------------

  if ! id -u "$RUN_USER" >/dev/null 2>&1; then
    log "creating system user ${RUN_USER}"
    useradd --system --home-dir "$INSTALL_DIR" --shell /usr/sbin/nologin "$RUN_USER" 2>/dev/null \
      || useradd --system --home "$INSTALL_DIR" --shell /usr/sbin/nologin "$RUN_USER"
  fi

  install -d -m 0755 "$INSTALL_DIR" "${INSTALL_DIR}/lib"
  install -m 0755 "$BUILT_BINARY" "${INSTALL_DIR}/zora-presence-worker"

  # CMake copies the proprietary runtime library next to the binary when it
  # built in native mode; the unit loads it through LD_LIBRARY_PATH.
  if [ -f "${SRC_DIR}/worker/build/libdiscord_partner_sdk.so" ]; then
    install -m 0644 "${SRC_DIR}/worker/build/libdiscord_partner_sdk.so" \
      "${INSTALL_DIR}/lib/libdiscord_partner_sdk.so"
  fi

  printf '%s:%s\n' "$COMMIT" "$MODE" >"$STAMP_FILE"
  printf '%s\n' "$MODE" >"$MODE_FILE"
fi

# ---------------------------------------------------------------------------
# Environment file (secrets live here, never in the repository or in logs)
# ---------------------------------------------------------------------------

if [ -n "${ZORA_API_BASE:-}" ] && [ -n "${WORKER_SHARED_SECRET:-}" ]; then
  log "writing ${ENV_FILE} from supplied environment"
  umask 077
  mkdir -p "$(dirname "$ENV_FILE")"
  {
    printf 'ZORA_API_BASE=%s\n' "$ZORA_API_BASE"
    printf 'WORKER_SHARED_SECRET=%s\n' "$WORKER_SHARED_SECRET"
    [ -n "${DISCORD_APP_ID:-}" ] && printf 'DISCORD_APP_ID=%s\n' "$DISCORD_APP_ID"
    [ -n "${POLL_INTERVAL_MS:-}" ] && printf 'POLL_INTERVAL_MS=%s\n' "$POLL_INTERVAL_MS"
  } >"$ENV_FILE"
  chmod 0600 "$ENV_FILE"
fi

# The service user's primary group is not always named after the user, so ask
# the system instead of assuming.
RUN_GROUP="$(id -gn "$RUN_USER" 2>/dev/null || echo "$RUN_USER")"

if [ -f "$ENV_FILE" ]; then
  install -m 0640 -o root -g "$RUN_GROUP" "$ENV_FILE" "${INSTALL_DIR}/.env"
else
  warn "no ${ENV_FILE} yet — the worker needs ZORA_API_BASE and WORKER_SHARED_SECRET to start"
fi

chown -R "${RUN_USER}:${RUN_GROUP}" "$INSTALL_DIR"
chmod 0755 "$INSTALL_DIR"

# ---------------------------------------------------------------------------
# systemd units
# ---------------------------------------------------------------------------

install -d -m 0755 "$UNIT_DIR"

WORKER_UNIT="${SRC_DIR}/worker/deploy/zora-presence-worker.service"
[ -f "$WORKER_UNIT" ] || fail "missing ${WORKER_UNIT} — cannot install the service unit"
install -m 0644 "$WORKER_UNIT" "${UNIT_DIR}/${SERVICE_NAME}.service"

# The update timer is what makes pushes to main deploy themselves. It is
# optional so that an older checkout can still install the worker itself.
UPDATE_SERVICE="${SRC_DIR}/worker/deploy/zora-worker-update.service"
UPDATE_TIMER="${SRC_DIR}/worker/deploy/zora-worker-update.timer"
if [ -f "$UPDATE_SERVICE" ] && [ -f "$UPDATE_TIMER" ]; then
  install -m 0644 "$UPDATE_SERVICE" "${UNIT_DIR}/zora-worker-update.service"
  install -m 0644 "$UPDATE_TIMER" "${UNIT_DIR}/zora-worker-update.timer"
else
  warn "update timer units not present in this checkout — skipping automatic redeploys"
fi

systemctl daemon-reload || warn "systemctl daemon-reload failed"
systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
if [ -f "$UPDATE_TIMER" ]; then
  systemctl enable --now zora-worker-update.timer >/dev/null 2>&1 \
    || warn "could not enable zora-worker-update.timer"
fi
systemctl restart "$SERVICE_NAME" || fail "could not restart ${SERVICE_NAME}"

# ---------------------------------------------------------------------------
# Verify
# ---------------------------------------------------------------------------

sleep 2
if systemctl is-active --quiet "$SERVICE_NAME"; then
  log "service ${SERVICE_NAME} is active (${MODE} build, commit ${COMMIT})"
else
  systemctl --no-pager -l status "$SERVICE_NAME" >&2 || true
  journalctl -u "$SERVICE_NAME" -n 30 --no-pager >&2 || true
  if [ ! -f "${INSTALL_DIR}/.env" ]; then
    fail "service ${SERVICE_NAME} is not active — ${INSTALL_DIR}/.env is missing (needs ZORA_API_BASE and WORKER_SHARED_SECRET)"
  fi
  fail "service ${SERVICE_NAME} is not active — see the journal output above"
fi

if [ -f "${INSTALL_DIR}/lib/libdiscord_partner_sdk.so" ]; then
  MISSING_LIBS="$(ldd "${INSTALL_DIR}/lib/libdiscord_partner_sdk.so" 2>/dev/null | grep 'not found' || true)"
  if [ -n "$MISSING_LIBS" ]; then
    warn "the SDK shared library needs host packages that are missing:"
    printf '%s\n' "$MISSING_LIBS" >&2
    warn "install them (e.g. libpulse0, libx11-6, libasound2) or the worker will not reach Ready"
  fi
fi

API_BASE="$(sed -n 's/^ZORA_API_BASE=//p' "$ENV_FILE" 2>/dev/null | head -n 1 || true)"
if [ -n "$API_BASE" ]; then
  # /api/public/worker/poll answers 401 without the bearer secret and performs
  # no work first, so this checks DNS/TLS reachability without side effects.
  STATUS="$(curl -sS -o /dev/null -m 15 -w '%{http_code}' \
    "${API_BASE%/}/api/public/worker/poll" 2>/dev/null || true)"
  if [ -z "$STATUS" ] || [ "$STATUS" = "000" ]; then
    warn "${API_BASE} is not reachable from this host — the worker will keep retrying"
  elif [ "$STATUS" = "401" ]; then
    log "API reachable (401 without a bearer token, as the worker endpoint requires)"
  else
    log "API reachable (${API_BASE} → HTTP ${STATUS})"
  fi
fi

journalctl -u "$SERVICE_NAME" -n 8 --no-pager >&2 || true
log "done — ${MODE} build, commit ${COMMIT}, service ${SERVICE_NAME} active"
