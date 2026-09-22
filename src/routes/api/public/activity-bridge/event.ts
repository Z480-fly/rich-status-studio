import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const EventBody = z.object({
  event: z.enum(["opened", "closed"]),
  app_name: z.string().trim().min(1).max(80),
  app_identifier: z.string().trim().max(200).optional(),
});

const appNames = new Set([
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
]);

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const Route = createFileRoute("/api/public/activity-bridge/event")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authorization = request.headers.get("authorization") ?? "";
        if (!authorization.startsWith("Bearer ")) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        const token = authorization.slice("Bearer ".length).trim();
        if (!token || token.length > 200) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        const parsed = EventBody.safeParse(await request.json().catch(() => null));
        if (!parsed.success || !appNames.has(parsed.data.app_name)) {
          return Response.json({ error: "Invalid activity event" }, { status: 400 });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        // The Activity Bridge tables are intentionally ahead of generated Supabase types.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const db = supabaseAdmin as any;
        const tokenHash = await hashToken(token);
        const { data: tokenRow, error: tokenError } = await db
          .from("activity_bridge_tokens")
          .select("discord_user_id")
          .eq("token_hash", tokenHash)
          .maybeSingle();
        if (tokenError || !tokenRow) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        const userId = tokenRow.discord_user_id as string;
        const { data: settings, error: settingsError } = await db
          .from("activity_bridge_settings")
          .select("enabled, visibility, shared_apps")
          .eq("discord_user_id", userId)
          .maybeSingle();
        if (settingsError) return Response.json({ error: "Could not read settings" }, { status: 500 });

        const sharedApps = Array.isArray(settings?.shared_apps) ? settings.shared_apps : [];
        if (!settings?.enabled || !sharedApps.includes(parsed.data.app_name)) {
          return Response.json({ accepted: false, reason: "sharing_disabled" });
        }

        const now = new Date().toISOString();
        const visibility = settings.visibility ?? "friends";
        if (visibility === "nobody") {
          return Response.json({ accepted: false, reason: "visibility_disabled" });
        }

        if (parsed.data.event === "opened") {
          await db
            .from("activity_events")
            .update({
              current_status: "ended",
              ended_at: now,
              last_seen: now,
            })
            .eq("discord_user_id", userId)
            .eq("app_name", parsed.data.app_name)
            .eq("current_status", "active");

          const { error } = await db.from("activity_events").insert({
            discord_user_id: userId,
            activity_type: "opened",
            app_name: parsed.data.app_name,
            app_identifier: parsed.data.app_identifier ?? null,
            started_at: now,
            current_status: "active",
            visibility,
            last_seen: now,
            source: "ios_shortcuts",
          });
          if (error) return Response.json({ error: error.message }, { status: 500 });
        } else {
          const { data: active } = await db
            .from("activity_events")
            .select("id, started_at")
            .eq("discord_user_id", userId)
            .eq("app_name", parsed.data.app_name)
            .eq("current_status", "active")
            .order("started_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (active?.id) {
            await db
              .from("activity_events")
              .update({ current_status: "ended", ended_at: now, last_seen: now })
              .eq("id", active.id)
              .eq("discord_user_id", userId);
          }
        }

        await db
          .from("activity_bridge_tokens")
          .update({ last_used_at: now })
          .eq("token_hash", tokenHash);

        return Response.json({ accepted: true });
      },
    },
  },
});
