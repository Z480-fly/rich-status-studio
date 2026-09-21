# Running the Zora worker on Northflank

Northflank is the recommended host for the native worker: it builds the image
from this repository, runs one always-on container, and needs no server for you
to log into.

```
iPhone / browser  →  Zora web app  →  Northflank worker  →  official Discord Social SDK  →  Rich Presence
```

## What gets deployed

| | |
| --- | --- |
| Resource | one **combined service** (builds from git *and* runs the image) |
| Build source | this repository, `worker/Dockerfile`, build context `/worker` |
| Image | `debian:bookworm-slim`, worker + the SDK's `libdiscord_partner_sdk.so` |
| Ports | **none** — the worker only makes outbound calls, so it runs as a background service |
| Liveness | container stays up; state is read from logs and from the Zora app's worker heartbeat |
| Instances | 1 |
| Free-tier cost | 1 of the 2 services included in the Developer Sandbox plan |

The image is self-checking: the build fails if the Discord Social SDK is missing
or if any shared library of the worker or the SDK cannot be resolved in the
final image. A dry-run worker (the binary that logs instead of publishing
presence) can therefore never be deployed by accident.

## What only you can do

Three steps need the account owner. Everything else is automated by
[`northflank/deploy.mjs`](northflank/deploy.mjs).

1. **Create the Northflank account and add a payment method.** Northflank
   requires a card on *every* plan, including the free Developer Sandbox, purely
   to verify identity. Their docs are explicit about this; **whether a prepaid
   Visa is accepted is something only their checkout can answer** — please check
   before relying on it. Stay on the Developer Sandbox plan: 2 services, 2 jobs,
   1 addon, always-on compute, no sleeping. Set a billing alert while you are
   there.
2. **Create a personal API token** (Account settings → API tokens) and add it to
   this workspace in **Settings → Environment** as `NORTHFLANK_API_TOKEN`. The
   token is read from the environment by the deploy script, is never printed,
   and is never written into the repository.
3. **Supply a link to the Discord Social SDK archive** (Discord Developer Portal
   → your application → Social SDK → Downloads, accepting Discord's terms). The
   official `DiscordSocialSdk-1.10.19337.zip` is **~745 MB**, so the link must be
   a *direct* download link — a Google Drive *share* page returns an HTML page
   instead of the archive and the build will say so. Pass it as `--sdk-url`.

Also confirm this workspace has `WORKER_SHARED_SECRET` (the same value the Zora
app uses for its worker endpoints) and optionally `DISCORD_APP_ID`.

## Configuration the script applies

| Location | Key | Value |
| --- | --- | --- |
| Build argument | `DISCORD_SOCIAL_SDK_URL` | the SDK archive link (encrypted at rest) |
| Build argument | `DISCORD_SOCIAL_SDK_SHA256` | optional integrity check |
| Runtime variable | `ZORA_API_BASE` | deployed Zora app URL |
| Runtime variable | `WORKER_SHARED_SECRET` | must match the app's worker secret |
| Runtime variable | `POLL_INTERVAL_MS` | `5000` |
| Runtime variable | `DISCORD_APP_ID` | optional, informational |

Nothing here is committed to git: the SDK is proprietary and is fetched inside
the isolated build, and the secrets live as encrypted Northflank variables. The
repository only contains the Dockerfile, this document and the deploy script.

## Commands

```bash
# validate every payload against Northflank's live API spec — needs no token
node worker/deploy/northflank/deploy.mjs dry-run

# create the project + service, build, deploy, then verify the worker endpoints
node worker/deploy/northflank/deploy.mjs up \
  --api-base https://your-zora-app \
  --sdk-url  '<direct link to DiscordSocialSdk-*.zip>'

node worker/deploy/northflank/deploy.mjs status      # config + deployment status
node worker/deploy/northflank/deploy.mjs logs        # runtime and build logs
node worker/deploy/northflank/deploy.mjs check-api   # worker endpoints + linked sessions
node worker/deploy/northflank/deploy.mjs build       # rebuild after a push
```

`up` is idempotent: it reuses the project and service when they already exist,
converges the build arguments and environment, and rebuilds.

## Rebuilds and the SDK link

Continuous integration is **off by default**. The SDK link is a short-lived
signed URL, so a push-triggered rebuild would eventually fail on an expired
link. To rebuild after changing `worker/`, either run `build` again or re-run
`up` with a fresh `--sdk-url`. Add `--ci` only if you have arranged a stable
link, and note that the link then has to stay valid for every future build.

## What is verified, and what is not

Verified from this workspace:

- `dry-run` validates every endpoint, payload field, required field and enum
  value against Northflank's live OpenAPI specification — it passes.
- The worker's control-plane contract passes (`bun run test:worker`, 7/7),
  including bearer auth, revision handling, clear-once, error heartbeats and
  token freshness.
- The script is idempotent by construction, and `node --check` passes.

Not verified, because it needs your account and the SDK:

- The image has never been built anywhere — there is no Docker daemon in this
  workspace. The first Northflank build is the real test of the Dockerfile, and
  its build-time `ldd` gates will fail loudly if a runtime package is missing.
- Anything requiring the live SDK: a real Discord session, a profile update, and
  the `sdk.social_layer_presence` scope being granted to your application.
