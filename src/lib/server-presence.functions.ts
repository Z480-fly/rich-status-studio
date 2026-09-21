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
}

/** Builds the Discord OAuth2 URL the phone should open to link the account. */
export const getDiscordLinkUrl = createServerFn({ method: "GET" }).handler(async () => {
  const { authorizeUrl } = await import("./discord-oauth.server");
  const origin =
    process.env["PUBLIC_SITE_URL"] ??
    (getRequestHeader("origin") || `https://${getRequestHeader("host") ?? ""}`);
  const clean = origin.replace(/\/$/, "");
  return { url: authorizeUrl(`${clean}/api/public/discord/callback`, crypto.randomUUID()) };
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
    return {
      linked: true,
      username: (account?.username as string | null) ?? null,
      desiredState: (session?.desired_state as "running" | "stopped") ?? "stopped",
      workerState: (session?.worker_state as string) ?? "idle",
      workerMessage: (session?.worker_message as string | null) ?? null,
      workerSeenSecondsAgo: heartbeat
        ? Math.round((Date.now() - new Date(heartbeat).getTime()) / 1000)
        : null,
      activity: (session?.activity as Json | null) ?? null,
    };
  },
);

function validateActivity(input: { activity: Record<string, Json> }) {
  if (!input?.activity || typeof input.activity !== "object") {
    throw new Error("Nothing to publish.");
  }
  // Only fields Discord actually accepts for rich presence. `name` is only
  // honoured by the server-side Social SDK worker (Activity::SetName); the
  // embedded-SDK path keeps showing the Discord app's own name.
  const allowed = ["name", "type", "details", "state", "timestamps", "assets", "party"] as const;
  const activity: Record<string, Json> = {};
  for (const key of allowed) {
    if (key in input.activity) activity[key] = input.activity[key] as Json;
  }
  return { activity };
}

async function writeDesiredState(
  desired: "running" | "stopped",
  activity: Record<string, Json> | null,
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
  .handler(({ data }) => writeDesiredState("running", data.activity));

export const updateServerPresence = createServerFn({ method: "POST" })
  .validator(validateActivity)
  .handler(({ data }) => writeDesiredState("running", data.activity));

export const stopServerPresence = createServerFn({ method: "POST" }).handler(() =>
  writeDesiredState("stopped", null),
);
