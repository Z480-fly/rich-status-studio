# Zora presence worker (Linux)

This is the process that actually holds the Discord-side session open so your
Rich Presence keeps running after you close the web app on your phone.

```
iPhone → Zora web app → Zora API (Lovable / Cloudflare) → this worker (Linux VM) → Discord Social SDK → your profile
```

## Why it is a separate program

The Discord Social SDK is a **native C/C++ library** (`libdiscord_partner_sdk.so`
on Linux). Lovable's hosting runs the web app in a Cloudflare Worker sandbox,
which cannot load native shared libraries or hold a long-lived socket.
So the web/API half runs on Lovable, and this binary runs on any cheap Linux VM
(Oracle free tier, Hetzner, Fly.io machine, a Raspberry Pi — anything with
glibc x86_64/aarch64 and outbound internet).

Discord does not officially market the Social SDK as a "personal presence host".
Treat this as a working proof of concept, not a supported product configuration.

## Control-plane contract (already live in the web app)

The worker only speaks to the Zora API, never to the database.

`GET  /api/public/worker/poll`  → `Authorization: Bearer $WORKER_SHARED_SECRET`

```json
{
  "sessions": [
    {
      "discord_user_id": "123",
      "desired_state": "running",        // or "stopped"
      "revision": 7,
      "activity": { "type": 0, "details": "…", "state": "…",
                    "timestamps": { "start": 1710000000000 },
                    "assets": { "large_image": "https://…", "large_text": "…" },
                    "party": { "size": [3, 5] } },
      "access_token": "…"                 // fresh Discord OAuth2 access token, refreshed server-side
    }
  ],
  "server_time": "2026-01-01T00:00:00.000Z"
}
```

`POST /api/public/worker/heartbeat` → `Authorization: Bearer $WORKER_SHARED_SECRET`

```json
{ "discord_user_id": "123", "state": "running", "message": null, "revision": 7 }
```

`state` is one of `idle | connecting | running | cleared | error`.

## Environment

Copy `.env.example` to `.env`:

| Variable               | Meaning                                                           |
| ---------------------- | ----------------------------------------------------------------- |
| `ZORA_API_BASE`        | e.g. `https://rich-status-studio.lovable.app`                      |
| `WORKER_SHARED_SECRET` | same value as the `WORKER_SHARED_SECRET` secret in the Zora project |
| `DISCORD_APP_ID`       | your Discord application id                                        |
| `POLL_INTERVAL_MS`     | default `5000`                                                     |

## Build (native worker)

1. Download the **Discord Social SDK** for Linux from the Discord Developer
   Portal (Applications → your app → Social SDK → Downloads). Accept the terms.
2. Unzip it to `worker/third_party/discord_social_sdk/` so you have
   `include/cdiscord.h`, `include/discordpp.h`, `lib/release/libdiscord_partner_sdk.so`.
3. Install build deps: `sudo apt install build-essential cmake libcurl4-openssl-dev`
4. ```bash
   cd worker && cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j
   ```
5. Run: `./build/zora-presence-worker` (reads `.env` from the working directory)

Without the SDK in `third_party/`, CMake still builds a **dry-run** binary: the
same poll/reconcile/heartbeat loop, logging the presence updates it would push
instead of calling Discord. All SDK-specific calls live in the adapter block in
`worker/src/main.cpp` — after unzipping your SDK, re-check the `TODO(verify)`
markers there against your version's `discordpp.h` (the SDK cannot be compiled
or verified from this repository, since the download is gated).

### Run as a service

```bash
sudo cp deploy/zora-presence-worker.service /etc/systemd/system/
sudo systemctl enable --now zora-presence-worker
journalctl -u zora-presence-worker -f
```

## Harness (no SDK required)

`harness/worker.mjs` is the exact same polling/heartbeat loop in Node, with the
Discord call stubbed out. It exists so the API half can be tested without the
native SDK:

```bash
ZORA_API_BASE=http://localhost:8080 WORKER_SHARED_SECRET=… node harness/worker.mjs
```

`harness/selftest.mjs` runs that loop against an in-memory mock of both
endpoints and asserts the documented contract — bearer auth, apply on
revision change, no-op when unchanged, clear-once on stop, error heartbeats
with retry, and token freshness:

```bash
node harness/selftest.mjs   # or: bun run test:worker from the repo root
```

## Known risks / things that can stop the native worker working

- The Social SDK download is gated behind Discord's developer terms; the binary
  is not redistributable, so it is not committed here.
- `sdk.social_layer_presence` must be enabled for your application. Apps that
  have not been granted Social SDK access get `invalid_scope` at the OAuth step.
- The SDK expects a desktop-ish environment; it runs headless, but it needs
  outbound websocket access to Discord's gateway.
- One SDK `Client` per Discord account. Many accounts on one VM = many clients;
  memory is the practical limit.
- Discord may rate-limit or reject presence updates that change too often; the
  worker only calls `UpdateRichPresence` when the `revision` changes.
- If Discord revokes the OAuth grant (you remove the app in Discord settings),
  refresh fails and the API marks the session as errored.
