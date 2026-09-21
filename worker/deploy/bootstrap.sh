#!/usr/bin/env bash
#
# Zora presence worker — one-shot bootstrap for a fresh Ubuntu host.
#
# This is the single entry point that has to run once on the server. Everything
# after it is automatic:
#
#   * build dependencies and the SDK's runtime libraries are installed
#   * the public repository is cloned to /opt/rich-status-studio
#   * the worker is built and installed as a systemd service
#   * a systemd timer re-deploys on every push to main (pull-based: no inbound
#     port, no SSH, no credentials, works behind CGNAT or IPv6-only)
#   * optionally, a GitHub Actions self-hosted runner is installed so builds and
#     logs are visible in the browser
#
# Usage (as root):
#   ZORA_API_BASE=https://your-app.example \
#   WORKER_SHARED_SECRET=... \
#   bash worker/deploy/bootstrap.sh
#
# Optional environment:
#   SDK_URL             link (or local path) to the official Discord Social SDK
#                       zip; a Google Drive share link is handled automatically
#   RUNNER_TOKEN        registration token from
#                       GitHub → repo → Settings → Actions → Runners → New runner
#   RUNNER_LABELS       default: self-hosted,linux,x64,zora-worker
#   RUNNER_NAME         default: <hostname>-zora
#   GITHUB_REPO         default https://github.com/Z480-fly/rich-status-studio.git
#   BRANCH              default main
#   DISCORD_APP_ID, POLL_INTERVAL_MS
#
# Nothing here is stored in, or read from, the repository: the Discord Social
# SDK and all secrets stay on the host.

set -euo pipefail

REPO_URL="${GITHUB_REPO:-https://github.com/Z480-fly/rich-status-studio.git}"
BRANCH="${BRANCH:-main}"
SRC_DIR="${SRC_DIR:-/opt/rich-status-studio}"
SDK_ROOT="${SDK_ROOT:-/opt/discord_social_sdk}"
ENV_FILE="${ENV_FILE:-/etc/zora-worker.env}"
RUN_USER="${RUN_USER:-zora}"
INSTALL_DIR="${INSTALL_DIR:-/opt/zora-presence-worker}"

log() { printf '[%s] bootstrap: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
warn() { log "WARN: $*"; }
fail() {
  log "ERROR: $*"
  exit 1
}

[ "$(id -u)" -eq 0 ] || fail "must run as root (use sudo)"
command -v apt-get >/dev/null 2>&1 || fail "this bootstrap targets Ubuntu/Debian (apt-get not found)"

export DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------------------
# 1. Packages
# ---------------------------------------------------------------------------

log "installing packages (build toolchain + SDK runtime libraries)"
apt-get update -qq || warn "apt-get update failed; trying to continue"
apt-get install -y --no-install-recommends \
  ca-certificates curl git cmake build-essential pkg-config unzip \
  libcurl4-openssl-dev libasound2-dev \
  libpulse0 libx11-6 libasound2 \
  || fail "apt-get install failed"

# ---------------------------------------------------------------------------
# 2. Repository + service user
# ---------------------------------------------------------------------------

if [ ! -d "${SRC_DIR}/.git" ]; then
  log "cloning ${REPO_URL} → ${SRC_DIR}"
  rm -rf "$SRC_DIR"
  mkdir -p "$(dirname "$SRC_DIR")"
  git clone --quiet --depth 1 --branch "$BRANCH" "$REPO_URL" "$SRC_DIR" \
    || fail "git clone failed (is the repository still public?)"
fi

if ! id -u "$RUN_USER" >/dev/null 2>&1; then
  log "creating system user ${RUN_USER}"
  useradd --system --home-dir "$INSTALL_DIR" --shell /usr/sbin/nologin "$RUN_USER" 2>/dev/null \
    || useradd --system --home "$INSTALL_DIR" --shell /usr/sbin/nologin "$RUN_USER"
fi

# ---------------------------------------------------------------------------
# 3. Optional: stage the proprietary Discord Social SDK
# ---------------------------------------------------------------------------

drive_direct_url() {
  local url="$1" id=""
  if [[ "$url" =~ /file/d/([A-Za-z0-9_-]+) ]]; then
    id="${BASH_REMATCH[1]}"
  elif [[ "$url" =~ [?\&]id=([A-Za-z0-9_-]+) ]]; then
    id="${BASH_REMATCH[1]}"
  fi
  if [ -n "$id" ]; then
    printf 'https://drive.google.com/uc?export=download&id=%s\n' "$id"
  else
    printf '%s\n' "$url"
  fi
}

# Google Drive serves an HTML "can't scan this file for viruses" form instead of
# the archive when the file is large. Rebuild the direct link from that form.
drive_confirm_url() {
  local page="$1" action id confirm uuid
  action="$(grep -oE 'action="[^"]+"' "$page" | head -n 1 | cut -d'"' -f2 || true)"
  id="$(grep -oE 'name="id" value="[^"]+"' "$page" | head -n 1 | cut -d'"' -f4 || true)"
  confirm="$(grep -oE 'name="confirm" value="[^"]+"' "$page" | head -n 1 | cut -d'"' -f4 || true)"
  uuid="$(grep -oE 'name="uuid" value="[^"]+"' "$page" | head -n 1 | cut -d'"' -f4 || true)"
  [ -n "$action" ] && [ -n "$id" ] || return 1
  printf '%s?id=%s&export=download&confirm=%s&uuid=%s\n' "$action" "$id" "${confirm:-t}" "$uuid"
}

fetch_archive() {
  local url="$1" out="$2"
  url="$(drive_direct_url "$url")"
  log "downloading SDK archive (the official zip is several hundred MB)"
  curl -fsSL --retry 3 --retry-delay 2 -o "$out" "$url" || return 1

  if [ "$(head -c 200 "$out" | grep -ci '<html' || true)" != "0" ]; then
    local retry legacy
    retry="$(drive_confirm_url "$out" || true)"
    legacy="$(grep -o 'confirm=[A-Za-z0-9_-]*' "$out" | head -n 1 | cut -d= -f2 || true)"
    if [ -z "$retry" ] && [ -n "$legacy" ]; then
      retry="${url%%&confirm=*}&confirm=${legacy}"
    fi
    [ -n "$retry" ] || return 1
    log "Drive asked for confirmation — resuming with the confirm token"
    curl -fsSL --retry 3 --retry-delay 2 -o "$out" "$retry" || return 1
  fi

  unzip -tq "$out" >/dev/null 2>&1 || return 1
  return 0
}

stage_sdk() {
  local archive="${1:-}"
  if [ -z "$archive" ]; then
    return 1
  fi

  # An already-extracted SDK directory can be handed over directly, which avoids
  # unpacking the several-hundred-MB archive a second time.
  if [ -d "$archive" ] && [ -f "${archive}/include/discordpp.h" ]; then
    rm -rf "$SDK_ROOT"
    mkdir -p "$(dirname "$SDK_ROOT")"
    cp -a "$archive" "$SDK_ROOT"
    log "Discord Social SDK staged at ${SDK_ROOT} (copied from ${archive})"
    return 0
  fi

  local tmp
  tmp="$(mktemp -d)"
  local zip="${tmp}/discord-social-sdk.zip"

  case "$archive" in
    http://* | https://*)
      fetch_archive "$archive" "$zip" || {
        warn "could not download the SDK archive — continuing without it (dry-run build)"
        rm -rf "$tmp"
        return 1
      }
      ;;
    *)
      cp "$archive" "$zip" 2>/dev/null || {
        warn "SDK archive ${archive} not found — continuing without it (dry-run build)"
        rm -rf "$tmp"
        return 1
      }
      ;;
  esac

  # Unpacking needs roughly the archive size again, plus the staged copy.
  local need_kb free_kb
  need_kb=$(( $(stat -c%s "$zip") / 1024 * 3 ))
  free_kb=$(df -Pk "$(dirname "$SDK_ROOT")" 2>/dev/null | awk 'NR==2 {print $4}' || echo 0)
  if [ -n "$free_kb" ] && [ "$free_kb" -gt 0 ] && [ "$free_kb" -lt "$need_kb" ]; then
    warn "only $((free_kb / 1024))MB free under $(dirname "$SDK_ROOT") but unpacking needs about $((need_kb / 1024))MB"
    warn "free space first, or pass an already-extracted SDK path as SDK_URL"
  fi

  unzip -qo "$zip" -d "$tmp/extracted" || {
    warn "SDK archive did not extract — continuing without it (dry-run build)"
    rm -rf "$tmp"
    return 1
  }

  # The archive layout varies; accept any directory that holds the header.
  local header
  header="$(find "$tmp/extracted" -type f -name discordpp.h -print -quit)"
  if [ -z "$header" ]; then
    warn "no include/discordpp.h inside the archive — continuing without it (dry-run build)"
    rm -rf "$tmp"
    return 1
  fi

  local sdk_dir
  sdk_dir="$(dirname "$(dirname "$header")")"
  rm -rf "$SDK_ROOT"
  mkdir -p "$(dirname "$SDK_ROOT")"
  mv "$sdk_dir" "$SDK_ROOT"
  rm -rf "$tmp"
  log "Discord Social SDK staged at ${SDK_ROOT}"
  return 0
}

if [ -n "${SDK_URL:-}" ]; then
  stage_sdk "$SDK_URL" || true
elif [ -f "${SDK_ROOT}/include/discordpp.h" ]; then
  log "using existing SDK at ${SDK_ROOT}"
else
  warn "no SDK_URL supplied and no SDK at ${SDK_ROOT} — the worker will run in dry-run mode."
  warn "Re-run this script later with SDK_URL=<zip link> to switch to real presence."
fi

# ---------------------------------------------------------------------------
# 4. Secrets (written only when supplied; never echoed)
# ---------------------------------------------------------------------------

if [ -n "${ZORA_API_BASE:-}" ] && [ -n "${WORKER_SHARED_SECRET:-}" ]; then
  log "writing ${ENV_FILE}"
  umask 077
  mkdir -p "$(dirname "$ENV_FILE")"
  {
    printf 'ZORA_API_BASE=%s\n' "$ZORA_API_BASE"
    printf 'WORKER_SHARED_SECRET=%s\n' "$WORKER_SHARED_SECRET"
    [ -n "${DISCORD_APP_ID:-}" ] && printf 'DISCORD_APP_ID=%s\n' "$DISCORD_APP_ID"
    [ -n "${POLL_INTERVAL_MS:-}" ] && printf 'POLL_INTERVAL_MS=%s\n' "$POLL_INTERVAL_MS"
  } >"$ENV_FILE"
  chmod 0600 "$ENV_FILE"
elif [ -f "$ENV_FILE" ]; then
  log "keeping existing ${ENV_FILE}"
else
  warn "ZORA_API_BASE / WORKER_SHARED_SECRET not supplied — the worker cannot start without them."
  warn "Set them in ${ENV_FILE} (two KEY=value lines) or re-run this script with both exported."
fi

# ---------------------------------------------------------------------------
# 5. Optional: GitHub Actions self-hosted runner (browser-visible build logs)
# ---------------------------------------------------------------------------

install_runner() {
  local token="$1"
  local runner_dir=/opt/actions-runner
  local repo_https="${REPO_URL%.git}"
  local arch label
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) warn "unsupported architecture $(uname -m) for the runner — skipping"; return 1 ;;
  esac
  label="${RUNNER_LABELS:-self-hosted,linux,${arch},zora-worker}"

  log "installing the GitHub Actions runner"
  apt-get install -y --no-install-recommends libicu-dev >/dev/null 2>&1 || warn "libicu-dev install failed; continuing"

  local version
  version="$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest \
    | grep -m1 '"tag_name"' | cut -d'"' -f4 | sed 's/^v//')" || true
  [ -n "${version:-}" ] || {
    warn "could not determine the runner version — skipping the runner install"
    return 1
  }

  local tarball="actions-runner-linux-${arch}-${version}.tar.gz"
  mkdir -p "$runner_dir"
  curl -fsSL -o "/tmp/${tarball}" \
    "https://github.com/actions/runner/releases/download/v${version}/${tarball}" \
    || {
      warn "runner download failed — skipping the runner install"
      return 1
    }
  tar -xzf "/tmp/${tarball}" -C "$runner_dir"
  rm -f "/tmp/${tarball}"

  if [ ! -x "${runner_dir}/config.sh" ]; then
    warn "runner archive did not unpack as expected — skipping the runner install"
    return 1
  fi

  (
    cd "$runner_dir"
    ./bin/installdependencies.sh >/dev/null 2>&1 || true
    ./config.sh --url "$repo_https" --token "$token" \
      --name "${RUNNER_NAME:-$(hostname)-zora}" --labels "$label" \
      --work _work --unattended --replace \
      && ./svc.sh install root \
      && ./svc.sh start
  ) || {
    warn "runner registration failed — the pull-based update timer still deploys on every push"
    return 1
  }
  log "runner installed: subsequent pushes to ${BRANCH} run the Deploy worker workflow"
  return 0
}

if [ -n "${RUNNER_TOKEN:-}" ]; then
  install_runner "$RUNNER_TOKEN" || true
else
  log "no RUNNER_TOKEN supplied — skipping the runner (pull-based updates still work)"
fi

# ---------------------------------------------------------------------------
# 6. Build, install, start — and schedule future deploys
# ---------------------------------------------------------------------------

log "running the deploy script"
ZORA_API_BASE="${ZORA_API_BASE:-}" WORKER_SHARED_SECRET="${WORKER_SHARED_SECRET:-}" \
  DISCORD_APP_ID="${DISCORD_APP_ID:-}" POLL_INTERVAL_MS="${POLL_INTERVAL_MS:-}" \
  bash "${SRC_DIR}/worker/deploy/deploy.sh" --src "$SRC_DIR" --branch "$BRANCH" --force \
  || fail "deploy.sh failed — see the output above. If it reports a missing ${ENV_FILE}, add ZORA_API_BASE and WORKER_SHARED_SECRET and re-run this script."

cat >&2 <<SUMMARY

--------------------------------------------------------------------------
Bootstrap finished.

  deploy checkout : ${SRC_DIR}
  installed to    : ${INSTALL_DIR}
  service         : zora-presence-worker (systemd, restarts automatically)
  updates         : zora-worker-update.timer re-deploys whenever main changes
  worker status   : visible in the Zora web app (the heartbeat shown per account)

Next steps without a terminal:
  1. Open the Zora app and use "Server presence" — the worker status line tells
     you whether the worker is polling.
  2. To re-run or update this host: push to ${BRANCH}, wait for the timer (or
     restart zora-worker-update.service from the panel).
  3. To add the Discord Social SDK later: re-run this script with SDK_URL set.
--------------------------------------------------------------------------
SUMMARY
