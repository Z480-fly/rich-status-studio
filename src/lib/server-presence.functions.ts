import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";

/**
 * Browser-facing API for the server-side ("keep it running after I leave")
 * presence. The browser is only a controller: it never sees OAuth secrets,
 * access tokens or refresh tokens — just an httpOnly session cookie.
 */

async function currentUser(): Promise<string | null> {
  const { readSessionCookie, sessionUser } = await import("./discord-oauth.server");
  return sessionUser(readSessionCookie(getRequestHeader("cookie")));
}

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export interface ServerPresenceStatus {
  linked: boolean;
  username: string | null;
  desiredState: "running" | "stopped";
  workerState: string;
  workerMessage: string | null;
  workerSeenSecondsAgo: number | null;
  activity: Json | null;
  /** ISO time the status auto-stops, or null when it runs until manually stopped. */
  expiresAt: string | null;
}

/**
 * Builds the Discord OAuth2 URL the browser should open to link the account.
 *
 * The redirect target is always the production callback, never the origin this
 * page happens to be served from — see `discordRedirectUri()`. Deriving it from
 * the request is what produced "Invalid OAuth2 redirect_uri" when the button was
 * pressed inside the Activity (served from Discord's proxy host).
 */
export const getDiscordLinkUrl = createServerFn({ method: "GET" }).handler(async () => {
  const { authorizeUrl, discordRedirectUri } = await import("./discord-oauth.server");
  return { url: authorizeUrl(discordRedirectUri(), crypto.randomUUID()) };
});

export const getServerPresenceStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<ServerPresenceStatus> => {
    const userId = await currentUser();
    if (!userId) {
      return {
        linked: false,
        username: null,
        desiredState: "stopped",
        workerState: "idle",
        workerMessage: null,
        workerSeenSecondsAgo: null,
        activity: null,
        expiresAt: null,
      };
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const [{ data: account }, { data: session }] = await Promise.all([
      supabaseAdmin
        .from("discord_accounts")
        .select("username")
        .eq("discord_user_id", userId)
        .maybeSingle(),
      supabaseAdmin
        .from("presence_sessions")
        .select("*")
        .eq("discord_user_id", userId)
        .maybeSingle(),
    ]);

    const heartbeat = session?.worker_heartbeat_at as string | null | undefined;
    const expiresAt = (session?.expires_at as string | null) ?? null;
    const expired = expiresAt != null && new Date(expiresAt).getTime() <= Date.now();
    const desired = (session?.desired_state as "running" | "stopped") ?? "stopped";
    return {
      linked: true,
      username: (account?.username as string | null) ?? null,
      desiredState: expired && desired === "running" ? "stopped" : desired,
      workerState: (session?.worker_state as string) ?? "idle",
      workerMessage: (session?.worker_message as string | null) ?? null,
      workerSeenSecondsAgo: heartbeat
        ? Math.round((Date.now() - new Date(heartbeat).getTime()) / 1000)
        : null,
      activity: (session?.activity as Json | null) ?? null,
      expiresAt: expired ? null : expiresAt,
    };
  },
);

/** Longest a status may auto-expire after: 7 days. */
const MAX_EXPIRES_SECONDS = 7 * 24 * 60 * 60;

function validateActivity(input: { activity: Record<string, Json>; expiresInSeconds?: number | null }) {
  if (!input?.activity || typeof input.activity !== "object") {
    throw new Error("Nothing to publish.");
  }
  // Only fields Discord actually accepts for rich presence.
  const allowed = ["type", "details", "state", "timestamps", "assets", "party"] as const;
  const activity: Record<string, Json> = {};
  for (const key of allowed) {
    if (key in input.activity) activity[key] = input.activity[key] as Json;
  }
  let expiresInSeconds: number | null = null;
  if (input.expiresInSeconds != null) {
    if (
      typeof input.expiresInSeconds !== "number" ||
      !Number.isFinite(input.expiresInSeconds) ||
      input.expiresInSeconds < 60 ||
      input.expiresInSeconds > MAX_EXPIRES_SECONDS
    ) {
      throw new Error("Invalid expiration.");
    }
    expiresInSeconds = Math.round(input.expiresInSeconds);
  }
  return { activity, expiresInSeconds };
}

async function writeDesiredState(
  desired: "running" | "stopped",
  activity: Record<string, Json> | null,
  expiresInSeconds: number | null = null,
) {
  const userId = await currentUser();
  if (!userId) throw new Error("Link your Discord account first.");
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: existing } = await supabaseAdmin
    .from("presence_sessions")
    .select("revision")
    .eq("discord_user_id", userId)
    .maybeSingle();

  const payload = {
    discord_user_id: userId,
    desired_state: desired,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    activity: activity as any,
    expires_at:
      desired === "running" && expiresInSeconds != null
        ? new Date(Date.now() + expiresInSeconds * 1000).toISOString()
        : null,
    revision: ((existing?.revision as number) ?? 0) + 1,
  };
  const { error } = await supabaseAdmin
    .from("presence_sessions")
    .upsert(payload, { onConflict: "discord_user_id" });
  if (error) throw new Error(error.message);
  return { ok: true as const, desiredState: desired };
}

export const startServerPresence = createServerFn({ method: "POST" })
  .validator(validateActivity)
  .handler(({ data }) => writeDesiredState("running", data.activity, data.expiresInSeconds));

export const updateServerPresence = createServerFn({ method: "POST" })
  .validator(validateActivity)
  .handler(({ data }) => writeDesiredState("running", data.activity, data.expiresInSeconds));

export const stopServerPresence = createServerFn({ method: "POST" }).handler(() =>
  writeDesiredState("stopped", null),
);
