import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { z } from "zod";

const APP_NAMES = [
  "TikTok",
  "Instagram",
  "YouTube",
  "Spotify",
  "Netflix",
  "Twitch",
  "Reddit",
  "Safari",
  "Minecraft",
  "Discord",
] as const;

export type ActivityBridgeApp = (typeof APP_NAMES)[number];
export type ActivityBridgeVisibility = "everyone" | "friends" | "nobody";

export interface ActivityBridgeSettings {
  enabled: boolean;
  visibility: ActivityBridgeVisibility;
  sharedApps: ActivityBridgeApp[];
}

const DEFAULT_SETTINGS: ActivityBridgeSettings = {
  enabled: false,
  visibility: "friends",
  sharedApps: [],
};

export const ACTIVITY_BRIDGE_APPS = APP_NAMES.map((name) => ({
  name,
  emoji:
    name === "TikTok"
      ? "🎵"
      : name === "Instagram"
        ? "📸"
        : name === "YouTube"
          ? "▶️"
          : name === "Spotify"
            ? "🎧"
            : name === "Netflix"
              ? "🎬"
              : name === "Twitch"
                ? "🟣"
                : name === "Reddit"
                  ? "👽"
                  : name === "Safari"
                    ? "🧭"
                    : name === "Minecraft"
                      ? "⛏️"
                      : "💬",
}));

async function currentUser(): Promise<string> {
  const { readSessionCookie, sessionUser } = await import("./discord-oauth.server");
  const userId = await sessionUser(readSessionCookie(getRequestHeader("cookie")));
  if (!userId) throw new Error("Link your Discord account first.");
  return userId;
}

function normalizeSettings(input: {
  enabled: boolean;
  visibility: ActivityBridgeVisibility;
  sharedApps: string[];
}): ActivityBridgeSettings {
  return {
    enabled: input.enabled,
    visibility: input.visibility,
    sharedApps: APP_NAMES.filter((name) => input.sharedApps.includes(name)),
  };
}

export const getActivityBridgeSettings = createServerFn({ method: "GET" }).handler(
  async (): Promise<ActivityBridgeSettings> => {
    const userId = await currentUser();
    // The migration is intentionally kept separate from generated Supabase types.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (await import("@/integrations/supabase/client.server")).supabaseAdmin as any;
    const { data, error } = await db
      .from("activity_bridge_settings")
      .select("enabled, visibility, shared_apps")
      .eq("discord_user_id", userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return DEFAULT_SETTINGS;
    return normalizeSettings({
      enabled: Boolean(data.enabled),
      visibility: data.visibility as ActivityBridgeVisibility,
      sharedApps: Array.isArray(data.shared_apps) ? data.shared_apps : [],
    });
  },
);

export const saveActivityBridgeSettings = createServerFn({ method: "POST" })
  .validator(
    z.object({
      enabled: z.boolean(),
      visibility: z.enum(["everyone", "friends", "nobody"]),
      sharedApps: z.array(z.string()).max(APP_NAMES.length),
    }),
  )
  .handler(async ({ data }) => {
    const userId = await currentUser();
    const settings = normalizeSettings(data);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (await import("@/integrations/supabase/client.server")).supabaseAdmin as any;
    const { error } = await db.from("activity_bridge_settings").upsert(
      {
        discord_user_id: userId,
        enabled: settings.enabled,
        visibility: settings.visibility,
        shared_apps: settings.sharedApps,
      },
      { onConflict: "discord_user_id" },
    );
    if (error) throw new Error(error.message);
    return settings;
  });

export const createActivityBridgeToken = createServerFn({ method: "POST" }).handler(async () => {
  const userId = await currentUser();
  const token = `zora_bridge_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
  const hash = await hashToken(token);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = (await import("@/integrations/supabase/client.server")).supabaseAdmin as any;
  await db.from("activity_bridge_tokens").delete().eq("discord_user_id", userId);
  const { error } = await db.from("activity_bridge_tokens").insert({
    discord_user_id: userId,
    token_hash: hash,
  });
  if (error) throw new Error(error.message);
  return { token };
});

export const deleteActivityBridgeHistory = createServerFn({ method: "POST" }).handler(async () => {
  const userId = await currentUser();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = (await import("@/integrations/supabase/client.server")).supabaseAdmin as any;
  const { error } = await db.from("activity_events").delete().eq("discord_user_id", userId);
  if (error) throw new Error(error.message);
  return { ok: true as const };
});

export async function hashActivityBridgeToken(token: string): Promise<string> {
  return hashToken(token);
}

async function hashToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export { APP_NAMES };
