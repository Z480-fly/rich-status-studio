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
So the web/API half runs on Lovable, and this binary runs on any always-on
Linux host with glibc x86_64/aarch64 and outbound internet. See
[Where to run it](#where-to-run-it) for the free options that actually work and
the one catch with each.

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

## Where to run it

Rich Presence only exists while a process holds the Discord session open, so the
host has to give us a **long-lived Linux process**. That rules out most free
tiers twice over: the always-free VMs (Oracle, Google Cloud `e2-micro`, AWS,
Azure) all require a credit card at signup, and the platforms that don't require
one usually sleep idle apps and drop the presence.

Checked September 2026:

| Host | Card needed? | Sleeps? | Long-lived process? |
| --- | --- | --- | --- |
| **Northflank** — Developer Sandbox | Yes — verification only, never charged on this plan | No — "always-on-compute – no sleeping" | Yes: 2 services, 2 jobs, 1 addon |
| **Render** — Free instance | No payment method required at all | Yes — 15 min with no inbound traffic; 750 instance-hours/month | Yes, if something pings it at least every ~10 min |
| Koyeb | Yes, and it charges the prorated plan immediately | No | Yes, but effectively paid |
| Hugging Face Spaces | No | Yes | No — Docker Spaces now require a paid plan |
| Fly.io, Railway, DigitalOcean, Oracle | Yes | — | — |
| GitHub Actions | No | Yes (6 h job limit) | No — jobs are ephemeral, presence blinks every 6 h |

**Primary: Northflank Developer Sandbox.** Deploy this directory as a *worker*
service (no port required) built with the `Dockerfile`. Always-on, GitHub-driven
builds, proper logs. The only catch is their platform rule that every account
must have a payment method on file for identity verification — it is not
charged on the Sandbox plan, but a prepaid card may or may not pass
verification. If it does, this is the cleanest option by a wide margin.

**Fallback: Render Free instance.** Confirmed to need no payment method at all.
Build the same `Dockerfile` as a *web service* (Render only runs web services on
the free plan, which is why the container also answers HTTP on `$PORT`). Keep it
awake with any free 5-minute pinger (cron-job.org needs no card; a GitHub Actions
schedule also works) — 15 minutes of silence means a ~1 minute cold start and a
gap in your presence. One always-on service fits inside the 750 monthly
instance-hours; a 31-day month is 744.

### Supplying the Social SDK to the builder

The SDK is not redistributable, so it cannot be committed and the build resolves
it from a base64 build secret instead:

```sh
base64 -w0 discord_social_sdk_linux.zip > sdk.b64
```

Set the file's contents as `DISCORD_SOCIAL_SDK_B64` in the host's build-secret
settings (Northflank: build arguments/secrets; Render: secret file, since Render
bakes plain build arguments into the image). The `Dockerfile` unpacks it,
normalises the layout to `third_party/discord_social_sdk/{include,lib/release}`
and builds. Runtime secrets (`ZORA_API_BASE`, `WORKER_SHARED_SECRET`,
`DISCORD_APP_ID`) are ordinary environment variables on the host, never in the
image.

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
