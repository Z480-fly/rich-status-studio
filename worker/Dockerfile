# Container image for the native Zora presence worker (Northflank and friends).
#
#   docker build -f worker/Dockerfile \
#     --build-arg DISCORD_SOCIAL_SDK_URL='<link to DiscordSocialSdk-*.zip>' \
#     worker
#
# The Discord Social SDK is proprietary and is never committed or vendored into
# this repository, so the build fetches it. Provide it in one of two ways:
#
#   DISCORD_SOCIAL_SDK_URL    https link to the official SDK zip (recommended;
#                             the archive is ~745 MB, so this is the only
#                             practical transport — see deploy/README.md)
#   DISCORD_SOCIAL_SDK_B64    base64 of the same zip, for unusually small
#                             archives or offline/air-gapped builds
#
# Runtime configuration (ZORA_API_BASE, WORKER_SHARED_SECRET, DISCORD_APP_ID,
# POLL_INTERVAL_MS) is plain host environment — nothing is baked into the image.
#
# This image deliberately does NOT attach a public port: the worker only makes
# outbound calls (your app + discord.com), so it runs as a background worker on
# hosts like Northflank. Liveness is read from the logs and from the worker
# heartbeat the Zora app displays.

FROM debian:bookworm-slim AS build

# libasound2-dev: the SDK's audio subsystem is a hard link-time requirement
# (worker/CMakeLists.txt fails configuration without it).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       build-essential cmake pkg-config \
       libcurl4-openssl-dev libasound2-dev \
       ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY CMakeLists.txt ./
COPY src ./src

ARG DISCORD_SOCIAL_SDK_URL=""
ARG DISCORD_SOCIAL_SDK_B64=""
# Optional: fail the build if the downloaded archive does not match this hash.
ARG DISCORD_SOCIAL_SDK_SHA256=""

# Acquire the archive.
RUN set -eu; \
    if [ -n "$DISCORD_SOCIAL_SDK_URL" ]; then \
      echo "Fetching the Discord Social SDK from the supplied URL"; \
      curl -fL --retry 5 --retry-all-errors --retry-delay 5 \
           --connect-timeout 30 -o /tmp/sdk.zip "$DISCORD_SOCIAL_SDK_URL"; \
    elif [ -n "$DISCORD_SOCIAL_SDK_B64" ]; then \
      echo "Decoding the Discord Social SDK from DISCORD_SOCIAL_SDK_B64"; \
      printf '%s' "$DISCORD_SOCIAL_SDK_B64" | base64 -d > /tmp/sdk.zip; \
    else \
      echo "ERROR: no Discord Social SDK supplied. Set the build argument" >&2; \
      echo "       DISCORD_SOCIAL_SDK_URL (or DISCORD_SOCIAL_SDK_B64)." >&2; \
      echo "       A build without the SDK would silently produce the dry-run" >&2; \
      echo "       worker, which never publishes presence." >&2; \
      exit 1; \
    fi; \
    if [ -n "$DISCORD_SOCIAL_SDK_SHA256" ]; then \
      echo "$DISCORD_SOCIAL_SDK_SHA256  /tmp/sdk.zip" | sha256sum -c -; \
    fi

# Stage the archive at worker/third_party/discord_social_sdk, the layout CMake
# probes by default. The archive's internal directory structure is not assumed:
# the header and the shared library are located wherever the archive puts them.
RUN set -eu; \
    rm -rf /tmp/sdk; \
    mkdir -p /tmp/sdk; \
    unzip -q /tmp/sdk.zip -d /tmp/sdk; \
    rm -f /tmp/sdk.zip; \
    hdr="$(find /tmp/sdk -name discordpp.h -print -quit)"; \
    lib="$(find /tmp/sdk -name 'libdiscord_partner_sdk.so*' -print -quit)"; \
    if [ -z "$hdr" ] || [ -z "$lib" ]; then \
      echo "ERROR: the archive does not look like the Discord Social SDK" >&2; \
      echo "       include/discordpp.h found: ${hdr:-missing}" >&2; \
      echo "       libdiscord_partner_sdk.so found: ${lib:-missing}" >&2; \
      echo "       Make sure the link points straight at the SDK zip and not at" >&2; \
      echo "       a download/interstitial page." >&2; \
      exit 1; \
    fi; \
    sdk=third_party/discord_social_sdk; \
    mkdir -p "$sdk/include" "$sdk/lib/release"; \
    cp -a "$(dirname "$hdr")/." "$sdk/include/"; \
    cp -a "$(dirname "$lib")/." "$sdk/lib/release/"; \
    if [ ! -e "$sdk/lib/release/libdiscord_partner_sdk.so" ]; then \
      versioned="$(cd "$sdk/lib/release" && ls libdiscord_partner_sdk.so* | head -n 1)"; \
      ln -sf "$versioned" "$sdk/lib/release/libdiscord_partner_sdk.so"; \
    fi; \
    test -f "$sdk/include/discordpp.h"; \
    test -e "$sdk/lib/release/libdiscord_partner_sdk.so"; \
    echo "Staged SDK libraries: $(ls "$sdk/lib/release")"

# CMake prints "Discord Social SDK enabled" when it links the real SDK and falls
# back to the dry-run binary when it cannot find it. Assert the link, so a
# dry-run worker can never ship by accident.
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build -j"$(nproc)" \
    && ldd build/zora-presence-worker | grep -q 'libdiscord_partner_sdk.so' \
    && echo "Verified: worker is linked against the Discord Social SDK"

FROM debian:bookworm-slim

# Runtime dependencies declared by the SDK's Linux shared library. If one is
# missing the container starts and then dies with a link error, so the check
# below turns that into a build failure instead of a production surprise.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       libcurl4 ca-certificates \
       libpulse0 libx11-6 libasound2 libatomic1 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --create-home --shell /usr/sbin/nologin worker

COPY --from=build /src/build/zora-presence-worker /usr/local/bin/zora-presence-worker
COPY --from=build /src/third_party/discord_social_sdk/lib/release/ /opt/discord-sdk/

ENV LD_LIBRARY_PATH=/opt/discord-sdk \
    POLL_INTERVAL_MS=5000

# Build-time gate: the image must resolve every dependency of both the worker and
# the SDK, exactly as the target host will.
RUN ldd /usr/local/bin/zora-presence-worker > /tmp/ldd.txt; \
    if grep -q 'not found' /tmp/ldd.txt; then \
      echo "ERROR: unresolved shared libraries in the runtime image:" >&2; \
      grep 'not found' /tmp/ldd.txt >&2; \
      echo "Add the owning package to the apt-get list above." >&2; \
      exit 1; \
    fi; \
    rm -f /tmp/ldd.txt; \
    echo "Runtime dependencies resolved"

WORKDIR /home/worker
USER worker

# No EXPOSE and no server: the worker holds its Discord session with outbound
# websockets only. It reads the environment, falling back to ./.env if present.
CMD ["/usr/local/bin/zora-presence-worker"]
