#!/usr/bin/env bash
#
# Zora presence worker — first-boot driver for Oracle Cloud Always Free (x86-64).
#
# This is what worker/deploy/cloud-init-oracle.yaml runs once, as root, with no
# interactive session. It exists so provisioning the host needs no terminal:
#
#   1. install the x86-64 runtime libraries libdiscord_partner_sdk.so links against
#   2. clone the public repository
#   3. hand over to worker/deploy/bootstrap.sh, which builds the worker, installs
#      it as a systemd service, and schedules pull-based redeploys on every push
#   4. report the result in one plain-text block
#
# Secrets are read from the setup file written by cloud-init, never echoed, and
# never stored in the repository.
#
# Usage (root):
#   bash worker/deploy/oracle-firstboot.sh
#
# Optional environment:
#   SETUP_FILE  default /etc/zora-worker-setup.env   (ZORA_API_BASE,
#                                                      WORKER_SHARED_SECRET,
#                                                      SDK_URL, RUNNER_TOKEN)
#   BRANCH      default main
#   SRC_DIR     default /opt/rich-status-studio
#   INSTALL_DIR default /opt/zora-presence-worker
#   ENV_FILE    default /etc/zora-worker.env
#   LOG_FILE    default /var/log/zora-firstboot.log
#   GITHUB_REPO default https://github.com/Z480-fly/rich-status-studio.git
#
# Nothing here is specific to Oracle except the assumption that this is a fresh
# Ubuntu host whose cloud-init ran this script: it is safe to re-run by hand.

set -euo pipefail

BRANCH="${BRANCH:-main}"
SRC_DIR="${SRC_DIR:-/opt/rich-status-studio}"
INSTALL_DIR="${INSTALL_DIR:-/opt/zora-presence-worker}"
ENV_FILE="${ENV_FILE:-/etc/zora-worker.env}"
SETUP_FILE="${SETUP_FILE:-/etc/zora-worker-setup.env}"
LOG_FILE="${LOG_FILE:-/var/log/zora-firstboot.log}"
REPO_URL="${GITHUB_REPO:-https://github.com/Z480-fly/rich-status-studio.git}"
SERVICE_NAME="${SERVICE_NAME:-zora-presence-worker}"

# The whole run is duplicated into a log file so the outcome can be inspected
# later without needing a terminal on the box.
exec > >(tee -a "$LOG_FILE") 2>&1

log() { printf '[%s] firstboot: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
warn() { log "WARN: $*"; }

[ "$(id -u)" -eq 0 ] || {
  echo "oracle-firstboot.sh must run as root" >&2
  exit 1
}

log "=== Zora worker first boot on $(uname -m) / $(. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-unknown}") ==="

# ---------------------------------------------------------------------------
# 1. Prerequisites and the x86-64 runtime libraries
# ---------------------------------------------------------------------------
#
# libdiscord_partner_sdk.so declares these DT_NEEDED entries:
#   libasound.so.2 → libasound2 / libasound2t64
#   libpulse.so.0  → libpulse0  / libpulse0t64
#   libX11.so.6    → libx11-6
#   libatomic.so.1 → libatomic1
# and the worker's own libcurl needs libcurl.so.4 → libcurl4 / libcurl4t64.
#
# Ubuntu 24.04 renamed several of these with a t64 suffix, so instead of pinning
# a fixed list (which fails on the release that renamed them) this installs only
# the names the release actually provides.
RUNTIME_CANDIDATES="libasound2 libasound2t64 libpulse0 libpulse0t64 libx11-6 libatomic1 libcurl4 libcurl4t64"
RUNTIME_SO="libasound.so.2 libpulse.so.0 libX11.so.6 libatomic.so.1 libcurl.so.4"

export DEBIAN_FRONTEND=noninteractive

if command -v apt-get >/dev/null 2>&1; then
  log "installing ca-certificates, git, curl, unzip + x86-64 runtime libraries"
  apt-get update -qq || warn "apt-get update failed; continuing"
  apt-get install -y --no-install-recommends ca-certificates git curl unzip \
    || warn "installing the base tools failed; continuing"

  available=""
  for pkg in $RUNTIME_CANDIDATES; do
    if apt-cache show "$pkg" >/dev/null 2>&1; then
      available="$available $pkg"
    fi
  done
  if [ -n "$available" ]; then
    # shellcheck disable=SC2086 # word splitting is intended: $available is a list
    apt-get install -y --no-install-recommends $available \
      || warn "some runtime libraries could not be installed; continuing"
  else
    warn "apt-cache resolved no runtime package names — bootstrap.sh will retry"
  fi
else
  warn "apt-get is unavailable — this driver expects an Ubuntu/Debian host"
fi

# `ldconfig -p` prints tab-indented lines like
#   \tlibasound.so.2 (libc6,x86-64) => /lib/x86_64-linux-gnu/libasound.so.2
# so compare the first field exactly rather than pattern-matching around it.
LDCONFIG="$(command -v ldconfig || echo /sbin/ldconfig)"
missing=""
for so in $RUNTIME_SO; do
  if "$LDCONFIG" -p 2>/dev/null | awk '{print $1}' | grep -qxF "$so"; then
    log "present: $so"
  else
    missing="$missing $so"
  fi
done
if [ -n "$missing" ]; then
  warn "missing runtime libraries:$missing"
  warn "the worker will still start, but libdiscord_partner_sdk.so cannot load until these exist"
else
  log "all x86-64 runtime libraries present"
fi

command -v git >/dev/null 2>&1 || {
  warn "git is not installed — cannot continue"
  exit 1
}

# ---------------------------------------------------------------------------
# 2. Secrets / configuration
# ---------------------------------------------------------------------------

if [ -f "$SETUP_FILE" ]; then
  # Exports ZORA_API_BASE / WORKER_SHARED_SECRET / SDK_URL / RUNNER_TOKEN.
  set -a
  # shellcheck disable=SC1090 # path is configurable
  . "$SETUP_FILE"
  set +a
  log "loaded configuration from $SETUP_FILE"
else
  warn "$SETUP_FILE not found — the worker will be installed but cannot start"
  warn "until ZORA_API_BASE and WORKER_SHARED_SECRET are provided"
fi

if [ -n "${ZORA_API_BASE:-}" ] && [ -n "${WORKER_SHARED_SECRET:-}" ]; then
  log "ZORA_API_BASE is set (${ZORA_API_BASE})"
else
  warn "ZORA_API_BASE and/or WORKER_SHARED_SECRET are empty"
fi

# ---------------------------------------------------------------------------
# 3. Checkout
# ---------------------------------------------------------------------------

if [ -d "${SRC_DIR}/.git" ]; then
  log "using existing checkout at ${SRC_DIR}"
else
  log "cloning ${REPO_URL} (${BRANCH}) → ${SRC_DIR}"
  rm -rf "$SRC_DIR"
  mkdir -p "$(dirname "$SRC_DIR")"
  git clone --quiet --depth 1 --branch "$BRANCH" "$REPO_URL" "$SRC_DIR" \
    || {
      warn "git clone failed — is the repository still public?"
      exit 1
    }
fi

[ -f "${SRC_DIR}/worker/deploy/bootstrap.sh" ] || {
  warn "no worker/deploy/bootstrap.sh in ${SRC_DIR} — nothing to run"
  exit 1
}

# ---------------------------------------------------------------------------
# 4. Bootstrap (build + systemd + pull-based updates)
# ---------------------------------------------------------------------------
#
# bootstrap.sh is the single source of truth for the install. It receives the
# configuration through the environment and writes the worker's own env file
# (/etc/zora-worker.env, mode 0600) itself — this driver never writes a secret.
log "running worker/deploy/bootstrap.sh"
bash "${SRC_DIR}/worker/deploy/bootstrap.sh" || {
  warn "bootstrap.sh reported a failure — see the output above"
  exit 1
}

# ---------------------------------------------------------------------------
# 5. Summary
# ---------------------------------------------------------------------------

log "=== result ==="

MODE="unknown"
[ -f "${INSTALL_DIR}/.build-mode" ] && MODE="$(cat "${INSTALL_DIR}/.build-mode")"
COMMIT="unknown"
[ -f "${INSTALL_DIR}/.deployed-commit" ] && COMMIT="$(cat "${INSTALL_DIR}/.deployed-commit")"

if [ "$MODE" = "dry-run" ]; then
  log "build mode        : dry-run (presence is logged, not published — set SDK_URL and re-run)"
else
  log "build mode        : ${MODE}"
fi
log "deployed commit   : ${COMMIT}"
log "installed to      : ${INSTALL_DIR}"

if [ -f "${INSTALL_DIR}/lib/libdiscord_partner_sdk.so" ]; then
  log "discord sdk       : staged"
else
  warn "discord sdk       : NOT staged — the worker is running in dry-run mode"
fi

if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
  log "service           : ${SERVICE_NAME} is active (restarts automatically, starts on boot)"
else
  warn "service           : ${SERVICE_NAME} is NOT active"
  systemctl --no-pager -l status "$SERVICE_NAME" 2>/dev/null || true
  journalctl -u "$SERVICE_NAME" -n 25 --no-pager 2>/dev/null || true
fi

if [ -f "$ENV_FILE" ]; then
  api_base="$(sed -n 's/^ZORA_API_BASE=//p' "$ENV_FILE" 2>/dev/null | head -n 1)"
  if [ -n "$api_base" ]; then
    # The poll endpoint answers 401 without the bearer secret, so this checks
    # DNS/TLS reachability without performing any work.
    status="$(curl -sS -o /dev/null -m 15 -w '%{http_code}' "${api_base%/}/api/public/worker/poll" 2>/dev/null || true)"
    case "${status:-}" in
      "" | 000) warn "API reachability : ${api_base} is NOT reachable from this host (the worker will keep retrying)" ;;
      401) log "API reachability : ${api_base} reachable (401 without a bearer, as expected)" ;;
      *) log "API reachability : ${api_base} → HTTP ${status}" ;;
    esac
  fi
else
  warn "no ${ENV_FILE} — the worker has no ZORA_API_BASE / WORKER_SHARED_SECRET yet"
fi

cat <<SUMMARY

--------------------------------------------------------------------------
First boot finished.

  worker service : ${SERVICE_NAME} (systemd, enabled, restarts on failure)
  build mode     : ${MODE}
  redeploys      : zora-worker-update.timer pulls main every ~15 min
  full log       : ${LOG_FILE}

Confirm it without a terminal: open the Zora app → "Server presence". The worker
status line there is driven by this host's heartbeats to the API.

To change configuration later: edit ${SETUP_FILE} and re-run this script, or
edit ${ENV_FILE} directly and restart the service.
--------------------------------------------------------------------------
SUMMARY
