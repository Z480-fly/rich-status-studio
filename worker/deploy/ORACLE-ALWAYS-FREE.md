# Deploying the Zora worker to Oracle Cloud Always Free

A backup host for the presence worker that is **free forever** (not a trial), runs
**24/7**, and needs **no terminal, no SSH and no inbound port** — you create one
instance in a browser, paste a config blob, and the VM finishes the install
itself.

```
Oracle Cloud Always Free VM (Ubuntu x86-64)
  └─ cloud-init  → worker/deploy/oracle-firstboot.sh
       ├─ installs the x86-64 runtime libraries the Discord SDK needs
       ├─ clones the public repo
       └─ worker/deploy/bootstrap.sh
            ├─ builds the worker (native mode when the SDK is present)
            ├─ installs /opt/zora-presence-worker + systemd unit
            ├─ writes /etc/zora-worker.env  (mode 0600, secrets never logged)
            └─ enables zora-worker-update.timer → redeploys when main changes
```

Anything the worker needs it fetches **outbound** (Zora API over HTTPS, Discord).
Oracle's default firewall can therefore stay completely closed.

## Why this shape, and why not the bigger free tier

Oracle's flagship Always Free offer is `VM.Standard.A1.Flex` (ARM, up to 2 OCPU /
12 GB). **It cannot run this worker.** The official Discord Social SDK 1.10.19337
ships exactly one Linux library, and it is x86-64:

```
$ readelf -h lib/release/libdiscord_partner_sdk.so
  Machine:  Advanced Micro Devices X86-64
```

The `arm64` folders in the SDK archive contain `discord_partner_sdk.dll` and
`.lib` — that is **Windows on ARM**, not Linux. There is no Linux aarch64 build.
So the usable Always Free shape is the AMD one:

| | |
| --- | --- |
| Shape | `VM.Standard.E2.1.Micro` — AMD x86-64 |
| Resources | 1/8 OCPU (burstable), 1 GB RAM, 47 GB+ boot volume |
| Always Free allowance | **two** such instances, plus 200 GB block storage total |
| Public IPv4 | yes, one per instance |
| Free for | the life of the tenancy — no trial clock |

1 GB of RAM is plenty here: the worker is a small binary that polls and holds a
socket. The build is one translation unit linked against a prebuilt `.so`.

## 1. Create the instance

Browser only. In the Oracle Cloud console:

1. **Compute → Instances → Create instance**
2. **Image and shape → Change image**: *Ubuntu 24.04* (or 22.04), an
   **Always Free Eligible** image.
3. **Change shape**: **Specialty and previous generation** → **`VM.Standard.E2.1.Micro`**.
   Do *not* choose an A1/Ampere shape — see above.
4. **Add SSH keys**: skip it, or upload a key if you want shell access later.
   The worker itself never needs it.
5. **Show advanced options → Management → Cloud-init script**: paste the entire
   contents of [`cloud-init-oracle.yaml`](./cloud-init-oracle.yaml), with the
   placeholders filled in (step 2 below).
6. **Create**. The instance boots, and cloud-init runs the install unattended.

> Leave the **public IP** assignment on. It is what lets you (and, optionally,
> GitHub) reach the box later; the worker does not need it.

## 2. The placeholders

Inside the pasted blob, in `/etc/zora-worker-setup.env`:

| Placeholder | What to put there | Required |
| --- | --- | --- |
| `ZORA_API_BASE` | Your deployed Zora app URL, e.g. `https://….lovable.app` | yes |
| `WORKER_SHARED_SECRET` | The same value the web app sends to `/api/public/worker/*` | yes |
| `SDK_URL` | Google Drive share link to the official Discord Social SDK zip, or a path to an already-extracted SDK directory | no — without it the worker installs in **dry-run** mode and publishes nothing |
| `RUNNER_TOKEN` | GitHub → repo → **Settings → Actions → Runners → New self-hosted runner** | no — see "Browser-visible logs" |

Fill these **in the Oracle console**, not anywhere else. They are never written
into this repository:

- the SDK is proprietary and stays on the host (`/opt/discord_social_sdk`)
- `WORKER_SHARED_SECRET` is written only to `/etc/zora-worker.env` (mode 0600)
- the driver is deliberately careful not to use `set -x`, so nothing leaks into
  the boot log

**Dry-run first is the sane default:** leave `SDK_URL` empty, confirm the worker
polls and heartbeats, then add the SDK URL and re-run the driver (step 4) to
switch to real Rich Presence.

## 3. What happens on first boot

1. cloud-init writes `/etc/zora-worker-setup.env` (0600) and downloads
   `oracle-firstboot.sh` from this repository.
2. The driver installs `libasound2`, `libpulse0`, `libx11-6`, `libatomic1` and
   `libcurl4` — the libraries `libdiscord_partner_sdk.so` and the worker link
   against — then **verifies each `.so` is actually present** and logs which ones
   are missing, if any.
3. It clones this public repository to `/opt/rich-status-studio`.
4. It runs `worker/deploy/bootstrap.sh`, which installs the toolchain, stages the
   SDK (when `SDK_URL` is set), builds the worker, installs it to
   `/opt/zora-presence-worker`, installs the systemd units and starts
   `zora-presence-worker`.
5. It prints a summary: build mode, deployed commit, service state, SDK presence,
   and whether `ZORA_API_BASE` was reachable.

Everything is logged to **`/var/log/zora-firstboot.log`** and to cloud-init's own
output.

## 4. Changing configuration later

Edit `/etc/zora-worker-setup.env` and re-run the driver, or edit the worker's own
env file and restart the service:

```bash
bash /usr/local/sbin/zora-oracle-firstboot.sh    # full re-install, safe to repeat
```

That is the only command in this document, and you only need it if you are
already at a shell. Without one, the simplest path is to **re-create the instance
with an updated blob** — it is idempotent and rebuilds from scratch in a few
minutes.

## 5. Verifying it works without a terminal

- **Primary:** open the Zora app → **Server presence**. The worker status line
  there is driven by this host's `POST /api/public/worker/heartbeat` calls, so it
  is the real end-to-end signal. `running` means the session is live on Discord.
- **Browser-visible build logs:** add `RUNNER_TOKEN` to the setup file and
  re-run the driver. The instance then registers itself as a self-hosted runner
  (labels `self-hosted,linux,x64,zora-worker`) and the existing
  [`.github/workflows/deploy-worker.yml`](../../.github/workflows/deploy-worker.yml)
  runs on every push, with its log output visible in GitHub → **Actions**.
- **Redeploys without anything:** `zora-worker-update.timer` pulls `main` every
  ~15 minutes and re-runs `deploy.sh`, which is a no-op when the installed commit
  is already current.

## 6. Honest caveats

| Caveat | Detail | Mitigation |
| --- | --- | --- |
| **Idle reclamation** | Oracle documents that Always Free instances *may* be reclaimed if, over 7 days, 95th-percentile CPU < 20% **and** network < 20%. A quiet presence worker sits close to that profile. | Keep a small amount of activity on the box, or accept the risk: re-creating the instance with the same blob restores service in minutes. |
| **Card required** | Oracle asks for a payment method at signup for identity verification. Always Free resources are not charged, but it is not a no-card signup. | — |
| **Disk** | The SDK archive is ~745 MB and unpacking needs roughly 3× that free. | Default 47 GB boot volume is fine; `bootstrap.sh` warns if space is short. |
| **Likely no IPv6-only path** | This guide assumes the normal public IPv4. Nothing in the worker requires IPv6. | — |
| **Proprietary SDK** | The SDK must never be committed. | It is staged at `/opt/discord_social_sdk` outside the checkout, and `worker/third_party/discord_social_sdk` is git-ignored. |
| **1 GB RAM** | Enough to run and to build one translation unit. A full SDK rebuild would not fit. | The SDK is downloaded prebuilt; only the worker is compiled. |

## 7. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Service active but app still shows the worker offline | `ZORA_API_BASE` or `WORKER_SHARED_SECRET` wrong/empty | Correct them in `/etc/zora-worker-setup.env`, re-run the driver |
| Log says `missing runtime libraries: libatomic.so.1 …` | Runtime library step failed | Re-run the driver; it is safe to repeat |
| Log says `discord sdk : NOT staged` | `SDK_URL` empty or the download failed | Set `SDK_URL` to the Drive link and re-run; check the log for the Drive confirmation step |
| `API reachability : … NOT reachable` | Egress blocked, wrong URL, or the app is down | Verify the URL in a browser; Oracle allows outbound by default |
| Instance disappeared from the console | Idle reclamation | Create a new instance with the same blob |
| Need to change the worker code | — | Push to `main`; the update timer picks it up within ~15 minutes |

## 8. Files involved

| File | Role |
| --- | --- |
| [`cloud-init-oracle.yaml`](./cloud-init-oracle.yaml) | The blob you paste into the Oracle console |
| [`oracle-firstboot.sh`](./oracle-firstboot.sh) | First-boot driver: runtime libraries → clone → bootstrap → summary |
| [`bootstrap.sh`](./bootstrap.sh) | First install on a fresh host (packages, SDK staging, secrets, service) |
| [`deploy.sh`](./deploy.sh) | Idempotent build + install + restart; used by bootstrap, the timer and CI |
| [`zora-presence-worker.service`](./zora-presence-worker.service) | The long-running systemd service |
| [`zora-worker-update.timer`](./zora-worker-update.timer) | Pull-based redeploy on every push to `main` |

None of these contain credentials. The SDK is never committed.
