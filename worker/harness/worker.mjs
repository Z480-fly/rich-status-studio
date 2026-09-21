#!/usr/bin/env node
/**
 * Zora presence worker — harness edition (no Discord SDK required).
 *
 * The exact same polling/heartbeat loop as the native C++ worker, with the
 * Discord call stubbed out. Use it to develop and test the API half without
 * the native library:
 *
 *   ZORA_API_BASE=http://localhost:8080 WORKER_SHARED_SECRET=… node harness/worker.mjs
 *
 * Everything below mirrors the control-plane contract documented in ../README.md.
 */

import { readFile } from "node:fs/promises";
import process from "node:process";

// ---------------------------------------------------------------------------
// Configuration (same env contract as the native worker)
// ---------------------------------------------------------------------------

const API_BASE = (process.env.ZORA_API_BASE ?? "http://localhost:8080").replace(/\/+$/, "");
const SECRET = process.env.WORKER_SHARED_SECRET ?? "";
const DISCORD_APP_ID = process.env.DISCORD_APP_ID ?? "";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 5000);
const SDK_MODE = process.env.HARNESS_SDK_MODE ?? "stub"; // "stub" | "failing"

if (!SECRET) {
  console.error("[harness] WORKER_SHARED_SECRET is required");
  process.exit(1);
}

/** Minimal .env fallback so the same file as the native worker can be reused. */
async function loadDotEnv() {
  if (process.env.WORKER_SHARED_SECRET) return;
  try {
    const raw = await readFile(new URL("../.env", import.meta.url), "utf8");
    for (const line of raw.split("\n")) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!match) continue;
      const key = match[1];
      let value = match[2] ?? "";
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    /* no .env file — fine, real env vars win anyway */
  }
}

// ---------------------------------------------------------------------------
// SDK stub — swap this file's applyActivity()/clearActivity() for real calls
// in the native worker. The harness prints instead of touching Discord.
// ---------------------------------------------------------------------------

const sdkStub = {
  connected: new Set(),
  updates: 0,
  clears: 0,
  failures: 0,

  connect(discordUserId) {
    if (SDK_MODE === "failing") {
      throw new Error(`[stub] social_layer_presence not enabled for app ${DISCORD_APP_ID || "(unset)"}`);
    }
    this.connected.add(discordUserId);
  },

  disconnect(discordUserId) {
    this.connected.delete(discordUserId);
  },

  async applyActivity(discordUserId, activity) {
    if (SDK_MODE === "failing") throw new Error("[stub] UpdateRichPresence refused");
    this.updates += 1;
    console.log(
      `[stub] UpdateRichPresence(${discordUserId}):`,
      JSON.stringify(activity),
    );
  },

  async clearActivity(discordUserId) {
    if (SDK_MODE === "failing") throw new Error("[stub] clear refused");
    this.clears += 1;
    console.log(`[stub] clear presence (${discordUserId})`);
  },
};

// ---------------------------------------------------------------------------
// HTTP helpers (global fetch, Node 18+)
// ---------------------------------------------------------------------------

async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { authorization: `Bearer ${SECRET}` },
  });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Worker loop — mirrors worker/src/main.cpp
// ---------------------------------------------------------------------------

/** Per-Discord-account state, exactly like the C++ worker's Session map. */
const sessions = new Map(); // discord_user_id -> { desired, revision, connecting }

async function reconcile(entry, session) {
  const running = session.desired_state === "running";

  if (entry && !running) {
    // Desired state flipped to stopped: clear once, drop the client.
    await sdkStub.clearActivity(session.discord_user_id);
    sessions.delete(session.discord_user_id);
    await apiPost("/api/public/worker/heartbeat", {
      discord_user_id: session.discord_user_id,
      state: "cleared",
      revision: session.revision,
    }).catch(() => {});
    return;
  }

  if (!running) return; // nothing desired; stay quiet (poll said "stopped" for unknown user)

  const revisionChanged = !entry || entry.revision !== session.revision;
  if (entry && !revisionChanged) return; // "the worker only calls UpdateRichPresence when revision changes"

  const isNew = !entry;
  if (isNew) {
    console.log(`[harness] connecting SDK client for ${session.discord_user_id}`);
    try {
      sdkStub.connect(session.discord_user_id);
    } catch (error) {
      console.error(`[harness] connect failed: ${error.message}`);
      await apiPost("/api/public/worker/heartbeat", {
        discord_user_id: session.discord_user_id,
        state: "error",
        message: String(error.message ?? error).slice(0, 500),
        revision: session.revision,
      }).catch(() => {});
      return;
    }
    sessions.set(session.discord_user_id, {
      desired: session.desired_state,
      revision: session.revision,
      connecting: false,
    });
    await apiPost("/api/public/worker/heartbeat", {
      discord_user_id: session.discord_user_id,
      state: "connecting",
      revision: session.revision,
    }).catch(() => {});
  }

  try {
    await sdkStub.applyActivity(session.discord_user_id, session.activity ?? {});
    const entryNow = sessions.get(session.discord_user_id);
    if (entryNow) {
      entryNow.revision = session.revision;
      entryNow.desired = session.desired_state;
    }
    await apiPost("/api/public/worker/heartbeat", {
      discord_user_id: session.discord_user_id,
      state: "running",
      revision: session.revision,
    }).catch(() => {});
  } catch (error) {
    sdkStub.failures += 1;
    console.error(`[harness] apply failed: ${error.message}`);
    await apiPost("/api/public/worker/heartbeat", {
      discord_user_id: session.discord_user_id,
      state: "error",
      message: String(error.message ?? error).slice(0, 500),
      revision: session.revision,
    }).catch(() => {});
    // Drop the client so the next poll reconnects, like the native worker.
    sdkStub.disconnect(session.discord_user_id);
    sessions.delete(session.discord_user_id);
  }
}

let tickCount = 0;
async function tick() {
  tickCount += 1;
  let payload;
  try {
    payload = await apiGet("/api/public/worker/poll");
  } catch (error) {
    console.error(`[harness] poll failed: ${error.message}`);
    return;
  }

  const sessionsFromServer = Array.isArray(payload.sessions) ? payload.sessions : [];
  const seen = new Set();

  for (const session of sessionsFromServer) {
    if (!session?.discord_user_id) continue;
    seen.add(session.discord_user_id);
    const entry = sessions.get(session.discord_user_id);
    if (session.desired_state === "stopped") {
      if (entry) await reconcile(entry, session);
      continue;
    }
    await reconcile(entry, session);
  }

  // Users that vanished from the poll: stop and drop them.
  for (const [discordUserId, entry] of sessions) {
    if (seen.has(discordUserId)) continue;
    console.log(`[harness] ${discordUserId} no longer in poll; clearing`);
    await sdkStub.clearActivity(discordUserId).catch(() => {});
    sdkStub.disconnect(discordUserId);
    sessions.delete(discordUserId);
  }

  if (tickCount % 12 === 1) {
    console.log(
      `[harness] tick ${tickCount}: ${sessionsFromServer.length} session(s) from API, ` +
        `${sessions.size} active client(s), ${sdkStub.updates} updates, ${sdkStub.clears} clears`,
    );
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

await loadDotEnv();

console.log(`[harness] starting against ${API_BASE} (poll every ${POLL_INTERVAL_MS}ms, SDK=${SDK_MODE})`);

let stopping = false;
process.on("SIGINT", () => {
  if (stopping) return;
  stopping = true;
  console.log("\n[harness] shutting down, clearing clients…");
  for (const discordUserId of sessions.keys()) {
    sdkStub.disconnect(discordUserId);
  }
  process.exit(0);
});

const loop = async () => {
  // Run immediately, then on the interval; never overlap ticks.
  for (;;) {
    const started = Date.now();
    try {
      await tick();
    } catch (error) {
      console.error(`[harness] tick error: ${error.message}`);
    }
    const elapsed = Date.now() - started;
    await sleep(Math.max(250, POLL_INTERVAL_MS - elapsed));
  }
};

await loop();
