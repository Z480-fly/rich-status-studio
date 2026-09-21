# Deploying the worker without a terminal

This directory is everything needed to get the native presence worker running on
a Linux host **without ever typing a command into an SSH session**.

```
iPhone / browser  →  Zora web app (this repo)  →  worker on your Ubuntu host  →  official Discord Social SDK  →  Rich Presence
```

The web half runs wherever the app is hosted. The worker is the only piece that
must live on your own server, because the Discord Social SDK is a native
`libdiscord_partner_sdk.so` that needs a long-lived process.

## Why this is pull-based (and why that is good news)

The repository is **public**, which removes every credential from the critical
path:

| Usually needed | Here |
| --- | --- |
| SSH login to install software | not needed — the panel's user-data field runs the bootstrap |
| Deploy key / PAT for `git clone` | not needed — the repo is public |
| Inbound port / port-forward | not needed — the host only makes outbound HTTPS calls |
| A registration token for deploys | optional — the update timer handles pushes, the runner only adds logs |

That means it works even where SSH does not: behind CGNAT, on an IPv6-only
address, or with the SSH forward rule broken (which is the current state of the
`96.9.101.54:20016` rule — it times out from the public internet, not just from
here).

## The one unavoidable action

**Someone has to cause one execution on the host.** Everything else here is
already prepared and automatic.

Prefer the panel's **User Data / cloud-init / startup script / custom script**
field — that is not a terminal, and it is a single paste. If the panel has no
such field, the browser console is the same single paste. There is no third
option: a machine cannot install software if nothing ever runs on it.

## Before you start

- Confirm the instance is **powered on** in the ASCS panel. Right now
  `96.9.101.54:20016` refuses to answer and the IPv6 address is unreachable from
  here, so verify the instance state first.
- Have these two values ready (they go into the server, never into this chat and
  never into git):
  - `ZORA_API_BASE` — the URL of the deployed Zora app, e.g. `https://your-app.example`
  - `WORKER_SHARED_SECRET` — the same value the app uses for the worker endpoints

## Path A — panel user-data (preferred, no terminal at all)

Look in the ASCS panel for any of these, under the instance's settings or its
Rebuild / Reinstall / Advanced view:

- "User Data", "User-Data", "cloud-init", "Custom data"
- "Startup script", "Initialization script", "Post-install script", "Custom script"
- "Run command" / "Execute command"

Any one of them is enough. Note that most panels only apply user-data at
create/reinstall time, so the usual trigger is Rebuild or Reinstall — which wipes
the instance, fine for a fresh one. I could not find public ASCS documentation
that lists these fields, so this is the checklist rather than a screenshot.

1. Open `worker/deploy/cloud-init.yaml` in this repository.
2. Replace `<<<https://your-zora-app-url>>>` and the `WORKER_SHARED_SECRET`
   placeholder.
3. Paste the whole file into the panel's **User Data / cloud-init / Startup
   script** field and apply it (usually reinstall or reboot the instance).
4. Wait ~5 minutes for the build, then open the Zora app and check the worker
   status shown for your account.

If you would rather not put the shared secret in user-data (it can be readable
through the cloud metadata service), leave `WORKER_SHARED_SECRET` empty, let the
bootstrap install everything, and add the two lines to
`/etc/zora-worker.env` from the browser console afterwards.

## Path B — browser console (one paste, if the panel has no user-data field)

The console is a shell, so this is the fallback. One line, nothing else:

```bash
curl -fsSL -o /tmp/zora-bootstrap.sh \
  https://raw.githubusercontent.com/Z480-fly/rich-status-studio/main/worker/deploy/bootstrap.sh \
  && sudo env ZORA_API_BASE='https://your-zora-app-url' \
              WORKER_SHARED_SECRET='PASTE_SECRET_HERE' \
              bash /tmp/zora-bootstrap.sh
```

Add `SDK_URL='<link to the SDK zip>'` to the same `sudo env` line to install the
Discord Social SDK in the same pass (a Google Drive share link works).

If the console opens blank or drops (common on iPhone Safari), the usual causes
are iCloud Private Relay, Lockdown Mode, or a content blocker interfering with
the panel's WebSocket — test with Private Relay off before giving up on it.

## Path C — automatic deploys with browser-visible logs (optional upgrade)

The bootstrap already schedules `zora-worker-update.timer`, which re-deploys
within ~15 minutes of any push to `main`. What it cannot give you is a build log
you can read on your phone.

To add that, install the GitHub Actions self-hosted runner:

1. GitHub → this repository → **Settings → Actions → Runners → New self-hosted
   runner**. Copy the **registration token** shown there (it is short-lived).
2. Either re-run the console one-liner with `RUNNER_TOKEN='<token>'`, or re-run
   the bootstrap through the panel with `RUNNER_TOKEN` exported.
3. From then on, every push to `main` that touches `worker/**` runs
   `.github/workflows/deploy-worker.yml` **on your host**, and the full output
   (cmake, install, `systemctl status`, journal tail) is readable in the GitHub
   app on your phone.

Set `ZORA_API_BASE` and `WORKER_SHARED_SECRET` under **Settings → Secrets and
variables → Actions** if you want GitHub to manage the host's env file for you;
they are injected without ever being printed.

Until a runner is registered, the workflow run simply stays queued — harmless.
The timer keeps deploying.

## Where the Discord Social SDK goes

The SDK is proprietary and is never committed, staged or vendored into this
repository. On the host it lives **outside** the checkout:

```
/opt/discord_social_sdk/include/discordpp.h
/opt/discord_social_sdk/lib/release/libdiscord_partner_sdk.so
```

Give the bootstrap `SDK_URL=<zip link>` and it downloads, verifies and unpacks it
there. `SDK_URL` also accepts a **path to an already-extracted SDK directory**
(must contain `include/discordpp.h`), which is worth using if you unzip it
yourself.

Practical detail: the official archive (`DiscordSocialSdk-1.10.19337.zip`) is
**~745 MB**, and a Google Drive share link returns an HTML "can't scan this file
for viruses" page before the real download. Both the size and that confirmation
step are handled by `bootstrap.sh`, but budget the disk space (unpacking needs
roughly 3× the archive size; the script warns if the host is short) and expect a
slow first download.

Without the SDK the worker still builds and runs in **dry-run** mode: the
identical poll → reconcile → heartbeat loop, logging the presence it would
publish. Dry-run is a real end-to-end test of the control plane (auth, revision
detection, token refresh, heartbeats) — it just does not touch Discord. The
update timer notices the SDK appearing on a later run and rebuilds in native
mode automatically.

Version verified against this code: **1.10.19337**.

## What the host needs (all installed by the bootstrap)

- Build: `git`, `cmake`, `build-essential`, `pkg-config`, `libcurl4-openssl-dev`,
  `libasound2-dev`
- Runtime for the SDK: `libpulse0`, `libx11-6`, `libasound2`, `ca-certificates`
- Outbound HTTPS to your app and to `discord.com` (no inbound port)

## Observability without a terminal

- **Worker alive / last heartbeat / last error** — shown per account in the
  Zora app's Server presence panel (state is one of `idle | connecting |
  running | cleared | error`). This is the primary signal.
- **Build and service logs** — GitHub Actions run logs (Path C), readable in the
  browser.
- **On-host logs** — `journalctl -u zora-presence-worker`; only reachable from a
  shell or through an Actions run (`if: always()` prints a 40-line tail).

## Files here

| File | Purpose |
| --- | --- |
| `bootstrap.sh` | One-shot root install: packages, clone, SDK staging, secrets, service, update timer, optional runner |
| `deploy.sh` | Idempotent build + install + restart; used by bootstrap, the timer and CI |
| `cloud-init.yaml` | Ready-to-paste user-data blob for the panel |
| `zora-presence-worker.service` | The worker's systemd unit |
| `zora-worker-update.service` / `.timer` | Pull-based redeploy on every push to `main` |

## Manual equivalent (if you ever do get a shell)

```bash
bash worker/deploy/deploy.sh --force          # build + install + restart
systemctl status zora-presence-worker
journalctl -u zora-presence-worker -f
```

## What is verified vs. not

- Verified: the deploy path is credential-free, the scripts are syntax-checked,
  `deploy.sh` is idempotent, the worker builds and the contract harness passes in
  CI.
- Not verified: anything requiring the host itself. Until the instance answers or
  the bootstrap runs there, "the worker is installed / publishing presence" is
  unproven, and live Rich Presence additionally needs a Discord application with
  `openid` + `sdk.social_layer_presence` and a completed OAuth link.
