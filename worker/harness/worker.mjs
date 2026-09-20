#!/usr/bin/env node
/**
 * Zora presence worker — Node harness.
 *
 * The exact control-plane loop of worker/src/main.cpp (poll → reconcile →
 * heartbeat), with the Discord Social SDK call stubbed out. Use it to test the
 * API half — auth, revision change detection, token handling, heartbeats —
 * without the native SDK.
 *
 * Env:
 *   ZORA_API_BASE         e.g. https://rich-status-studio.lovable.app
 *   WORKER_SHARED_SECRET  same value as the server secret
 *   POLL_INTERVAL_MS      default 5000
 *   HARNESS_FAIL_DISCORD  "1" makes the stubbed Discord calls throw
 *
 * Run:  node worker/harness/worker.mjs
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DEFAULT_POLL_INTERVAL_MS = 5000;
const HTTP_TIMEOUT_MS = 10_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function errorMessage(error) {
  if (error instanceof Error && error.message) return error.message.slice(0, 400);
  return String(error).slice(0, 400);
}

function tailToken(token) {
  return typeof token === "string" && token.length > 6 ? `…${token.slice(-6)}` : "***";
}

/**
 * Discord Social SDK stand-in. Records every call (useful for tests) and
 * succeeds by default; HARNESS_FAIL_DISCORD=1 makes it throw so the error
 * reporting path can be exercised.
 */
export function stubDiscord({ fail = false, log = console } = {}) {
  return {
    calls: [],
    async apply(accessToken, activity) {
      this.calls.push({ op: "apply", token: accessToken, activity });
      if (fail) throw new Error("stubbed Discord failure");
      log.info?.(
        `[discord] apply token=${tailToken(accessToken)} activity=${JSON.stringify(activity)}`,
      );
    },
    async clear(accessToken) {
      this.calls.push({ op: "clear", token: accessToken });
      if (fail) throw new Error("stubbed Discord failure");
      log.info?.(`[discord] clear token=${tailToken(accessToken)}`);
    },
  };
}

/**
 * Builds one stateful reconcile pass against the Zora API.
 *
 * Per-user state machine (identical to worker/src/main.cpp):
 *  - desired "running": apply the activity when the revision changed or the
 *    last apply did not stick (error/cleared); otherwise heartbeat as running.
 *  - desired "stopped": clear once if we had something applied; heartbeat
 *    cleared; never re-apply until the server bumps the revision again.
 *  - a heartbeat is sent every pass for every session so the phone sees fresh
 *    worker liveness, not just activity changes.
 */
export function createWorker({
  apiBase,
  secret,
  fetchImpl = fetch,
  discord = stubDiscord(),
  log = console,
}) {
  if (!apiBase) throw new Error("ZORA_API_BASE is required");
  if (!secret) throw new Error("WORKER_SHARED_SECRET is required");
  const base = String(apiBase).replace(/\/+$/, "");

  /** discord_user_id → { revision, desiredState, appliedActivityJson } */
  const sessions = new Map();

  async function poll() {
    const res = await fetchImpl(`${base}/api/public/worker/poll`, {
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (res.status === 401) {
      throw new Error("poll: 401 Unauthorized — WORKER_SHARED_SECRET mismatch");
    }
    if (!res.ok) throw new Error(`poll: HTTP ${res.status}`);
    return await res.json();
  }

  async function heartbeat(body) {
    const res = await fetchImpl(`${base}/api/public/worker/heartbeat`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`heartbeat: HTTP ${res.status}`);
  }

  async function reconcile(session) {
    const userId = String(session?.discord_user_id ?? "");
    if (!userId) return;

    const revision = Number(session?.revision ?? 0);
    const desired = session?.desired_state === "running" ? "running" : "stopped";
    const prev = sessions.get(userId) ?? {
      revision: -1,
      desiredState: "",
      appliedActivityJson: "",
    };

    let state;
    let message = null;

    if (desired === "running") {
      const activity = session?.activity ?? null;
      const activityJson = JSON.stringify(activity);
      const needsApply = revision !== prev.revision || prev.appliedActivityJson !== activityJson;
      if (needsApply) {
        try {
          await discord.apply(session.access_token, activity);
          state = "running";
          prev.appliedActivityJson = activityJson;
        } catch (error) {
          state = "error";
          message = errorMessage(error);
        }
      } else {
        state = "running"; // unchanged — heartbeat keeps liveness
      }
    } else if (prev.appliedActivityJson !== "") {
      try {
        await discord.clear(session.access_token);
        state = "cleared";
        prev.appliedActivityJson = "";
      } catch (error) {
        state = "error";
        message = errorMessage(error);
      }
    } else {
      state = "cleared"; // nothing applied — nothing to clear
    }

    prev.revision = revision;
    prev.desiredState = desired;
    sessions.set(userId, prev);

    try {
      await heartbeat({ discord_user_id: userId, state, message, revision });
    } catch (error) {
      log.warn?.(`[heartbeat] failed for ${userId}: ${errorMessage(error)}`);
    }
    log.info?.(
      `[session] ${userId} desired=${desired} → ${state}` +
        (message ? ` (${message})` : "") +
        ` rev=${revision}`,
    );
  }

  /** One poll → reconcile → heartbeat pass. Returns the session count. */
  return async function pollOnce() {
    const payload = await poll();
    const list = Array.isArray(payload?.sessions) ? payload.sessions : [];
    for (const session of list) {
      await reconcile(session);
    }
    return list.length;
  };
}

/** CLI entry point: validate env, then run the loop forever. */
export async function main({ env = process.env } = {}) {
  const apiBase = env.ZORA_API_BASE;
  const secret = env.WORKER_SHARED_SECRET;
  if (!apiBase || !secret) {
    console.error("ZORA_API_BASE and WORKER_SHARED_SECRET are required. See worker/README.md.");
    process.exitCode = 1;
    return;
  }

  const pollIntervalMs = Number(env.POLL_INTERVAL_MS) || DEFAULT_POLL_INTERVAL_MS;
  const discord = stubDiscord({ fail: env.HARNESS_FAIL_DISCORD === "1" });
  const pollOnce = createWorker({ apiBase, secret, discord });

  console.log(
    `harness: polling ${apiBase.replace(/\/+$/, "")}/api/public/worker/poll every ${pollIntervalMs}ms (Discord stubbed)`,
  );

  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      stopping = true;
    });
  }

  while (!stopping) {
    try {
      await pollOnce();
    } catch (error) {
      console.error(`poll failed: ${errorMessage(error)}`);
    }
    await sleep(pollIntervalMs);
  }
  console.log("harness: stopped");
}

// Run as CLI when executed directly (not when imported by the self-test).
const invokedAsCli = (() => {
  try {
    return (
      !!process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url
    );
  } catch {
    return false;
  }
})();

if (invokedAsCli) {
  await main();
}
