# Build + run the native Zora presence worker on a container host.
#
#   docker build -f worker/Dockerfile -t zora-presence-worker worker
#
# The Discord Social SDK is proprietary and must never be committed, so it is
# supplied to the build as a base64-encoded build secret named
# DISCORD_SOCIAL_SDK_B64 (the official Linux zip from the Developer Portal):
#
#   base64 -w0 discord_social_sdk_linux.zip > sdk.b64
#
# The build fails early with a clear message if that secret is missing.
# Runtime configuration (ZORA_API_BASE, WORKER_SHARED_SECRET, DISCORD_APP_ID, …)
# is normal host environment variables — nothing is baked into the image.

FROM debian:bookworm-slim AS build

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       build-essential cmake libcurl4-openssl-dev unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY CMakeLists.txt ./
COPY src ./src

ARG DISCORD_SOCIAL_SDK_B64=""
RUN set -e; \
    if [ -z "$DISCORD_SOCIAL_SDK_B64" ]; then \
      echo "ERROR: build secret DISCORD_SOCIAL_SDK_B64 is missing — see worker/README.md" >&2; \
      exit 1; \
    fi; \
    printf '%s' "$DISCORD_SOCIAL_SDK_B64" | base64 -d > /tmp/sdk.zip; \
    mkdir -p /tmp/sdk; \
    unzip -q /tmp/sdk.zip -d /tmp/sdk; \
    rm /tmp/sdk.zip; \
    inc="$(dirname "$(find /tmp/sdk -name discordpp.h -print -quit)")"; \
    so="$(dirname "$(find /tmp/sdk -name 'libdiscord_partner_sdk.so*' -print -quit)")"; \
    mkdir -p third_party/discord_social_sdk/include third_party/discord_social_sdk/lib/release; \
    cp -a "$inc"/. third_party/discord_social_sdk/include/; \
    cp -a "$so"/libdiscord_partner_sdk.so* third_party/discord_social_sdk/lib/release/

RUN cmake -B build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build -j"$(nproc)"

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends libcurl4 ca-certificates busybox \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --create-home --shell /usr/sbin/nologin worker \
    && mkdir -p /srv && printf 'zora presence worker\n' > /srv/index.html

# Only the binary and the SDK's shared library ship to the runtime image.
COPY --from=build /src/build/zora-presence-worker /usr/local/bin/zora-presence-worker
COPY --from=build /src/third_party/discord_social_sdk/lib/release/ /opt/discord-sdk/
ENV LD_LIBRARY_PATH=/opt/discord-sdk PORT=8080

WORKDIR /home/worker
USER worker

# Web-service hosts (e.g. Render free) require a listener on $PORT; worker hosts
# (e.g. Northflank) ignore it. Inbound traffic is also what keeps a free web
# instance from spinning down. The worker itself only talks outbound.
# The worker reads ./.env, so mirror the host environment into one first.
CMD ["/bin/sh", "-c", "printf 'ZORA_API_BASE=%s\\nWORKER_SHARED_SECRET=%s\\nDISCORD_APP_ID=%s\\nPOLL_INTERVAL_MS=%s\\nLIVENESS_INTERVAL_MS=%s\\n' \"$ZORA_API_BASE\" \"$WORKER_SHARED_SECRET\" \"$DISCORD_APP_ID\" \"${POLL_INTERVAL_MS:-5000}\" \"${LIVENESS_INTERVAL_MS:-30000}\" > /home/worker/.env && (busybox httpd -f -p \"$PORT\" -h /srv &) && exec /usr/local/bin/zora-presence-worker"]
