import { DiscordSDK } from "@discord/embedded-app-sdk";
import { exchangeDiscordCode, getDiscordClientId } from "./discord.functions";
import { devLog, warnLog } from "./logger";

let sdk: DiscordSDK | null = null;
let clientIdCache: string | null = null;
let authenticated = false;
let accessToken: string | null = null;
let username = "you";

/** Last payload we successfully pushed, so we can reapply it after a resume. */
let lastActivity: Record<string, unknown> | null = null;
let lastActivityJson = "";
let applying: Promise<void> | null = null;

const MAX_RETRIES = 4;
const assetCache = new Map<string, string>();

export type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

let state: ConnectionState = "disconnected";
const listeners = new Set<(s: ConnectionState) => void>();

function setState(next: ConnectionState) {
  if (state === next) return;
  state = next;
  devLog(`state:${next}`);
  listeners.forEach((l) => l(next));
}

export function getConnectionState(): ConnectionState {
  return state;
}

export function subscribeConnection(listener: (s: ConnectionState) => void): () => void {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function isConnected(): boolean {
  return authenticated;
}

/** Discord only injects `frame_id` when the page runs inside a real Activity iframe. */
export function isInsideDiscord(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).has("frame_id");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ensureSdk(): Promise<DiscordSDK> {
  if (sdk) return sdk;
  if (!clientIdCache) {
    const { clientId } = await getDiscordClientId();
    if (!clientId) throw new Error("The Discord application ID hasn't been configured yet.");
    clientIdCache = clientId;
  }
  const created = new DiscordSDK(clientIdCache);
  await created.ready();

  // A new SDK instance must be authenticated before it can accept commands.
  // This matters after a transient RPC failure, when applyWithRetry drops the
  // old handle and creates a replacement while the OAuth token is still valid.
  if (authenticated && accessToken) {
    try {
      const auth = await created.commands.authenticate({ access_token: accessToken });
      accessToken = auth.access_token || accessToken;
      username = auth.user.global_name || auth.user.username || username;
      devLog("sdk:reauthenticated", username);
    } catch (error) {
      warnLog("sdk:reauthenticate-failed", error);
      authenticated = false;
      accessToken = null;
      sdk = null;
      setState("disconnected");
      throw new Error("Your Discord connection expired. Connect again.");
    }
  }

  sdk = created;
  devLog("sdk:connected");
  return created;
}

export async function connectToDiscord(): Promise<{ username: string }> {
  if (!isInsideDiscord()) {
    throw new Error(
      "This page isn't running inside Discord. Launch it as an Activity in a voice channel to control your real presence.",
    );
  }
  if (authenticated) return { username };

  setState("connecting");
  try {
    const active = await ensureSdk();

    const { code } = await active.commands.authorize({
      client_id: clientIdCache!,
      response_type: "code",
      state: "",
      prompt: "none",
      scope: ["identify", "rpc.activities.write"],
    });

    const { accessToken: token } = await exchangeDiscordCode({ data: { code } });
    const auth = await active.commands.authenticate({ access_token: token });

    accessToken = token;
    authenticated = true;
    username = auth?.user?.global_name || auth?.user?.username || "you";
    setState("connected");
    devLog("sdk:authenticated", username);
    return { username };
  } catch (error) {
    setState("disconnected");
    warnLog("sdk:connect-failed", error);
    throw error;
  }
}

/** Discord accepts public HTTPS image URLs directly for Rich Presence assets. */
async function resolveAssets(
  activity: Record<string, unknown> | null,
): Promise<Record<string, unknown> | null> {
  return activity;
}

async function pushActivity(activity: Record<string, unknown> | null): Promise<void> {
  const active = await ensureSdk();
  const payload = await resolveAssets(activity);
  // Discord's Embedded App SDK accepts external https image URLs directly.
  // Keep the payload intact instead of converting URLs through the API, which
  // can fail for perfectly valid public images.
  await active.commands.setActivity({ activity: payload });
}

/** Applies an activity with bounded retries and a single in-flight request. */
async function applyWithRetry(activity: Record<string, unknown> | null, label: string): Promise<void> {
  if (applying) await applying.catch(() => {});

  applying = (async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        await pushActivity(activity);
        devLog(`setActivity:success (${label})`, attempt > 0 ? `after ${attempt} retries` : "");
        return;
      } catch (error) {
        lastError = error;
        warnLog(`setActivity:failure (${label})`, error);
        if (!authenticated) break;
        if (attempt === MAX_RETRIES) break;
        // Drop the SDK handle so the next attempt re-initialises it.
        sdk = null;
        setState("reconnecting");
        devLog("reconnect:attempt", attempt + 1);
        await sleep(Math.min(8000, 500 * 2 ** attempt));
      }
    }
    setState(authenticated ? "connected" : "disconnected");
    throw lastError instanceof Error ? lastError : new Error("Discord rejected the update.");
  })();

  try {
    await applying;
    if (authenticated) {
      setState("connected");
      devLog("reconnect:success");
    }
  } finally {
    applying = null;
  }
}

export async function publishActivity(activity: Record<string, unknown>): Promise<void> {
  if (!authenticated) throw new Error("Connect to Discord first.");
  const json = JSON.stringify(activity);
  await applyWithRetry(activity, "manual");
  lastActivity = activity;
  lastActivityJson = json;
}

export async function resetActivity(): Promise<void> {
  if (!authenticated) throw new Error("Connect to Discord first.");
  // The Embedded App SDK uses a nullable activity to clear Rich Presence.
  // Sending `{ type: 0 }` only creates an empty Playing activity.
  await applyWithRetry(null, "clear");
  lastActivity = null;
  lastActivityJson = "";
}

/**
 * Re-pushes the live status after the Activity comes back to the foreground.
 * iOS or Discord may have torn the session down while we were hidden; this is
 * the legitimate recovery path, not a way to keep the Activity alive.
 */
export async function reapplyAfterResume(): Promise<boolean> {
  if (!authenticated || !lastActivity) return false;
  const activity = { ...lastActivity };
  // Refresh the "started at" stamp so a count-up timer isn't frozen.
  const timestamps = activity["timestamps"] as { start?: number; end?: number } | undefined;
  if (timestamps?.start && !timestamps.end) {
    activity["timestamps"] = timestamps;
  }
  try {
    await applyWithRetry(activity, "resume");
    return true;
  } catch {
    return false;
  }
}

export function hasLiveActivity(): boolean {
  return !!lastActivityJson;
}
