import { createServerFn } from "@tanstack/react-start";
import type { PresenceDraft } from "./presence";

/** Public base used to build image URLs Discord can fetch. */
function publicBaseUrl(): string {
  return (process.env["PUBLIC_SITE_URL"] ?? "https://rich-status-studio.lovable.app").replace(
    /\/$/,
    "",
  );
}

/** Verifies a Discord OAuth access token and returns the owning user id. */
async function discordUserId(accessToken: string): Promise<string> {
  const res = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error("Your Discord session expired. Reconnect and try again.");
  const json = (await res.json()) as { id?: string };
  if (!json.id) throw new Error("Discord did not identify you.");
  return json.id;
}

function requireToken(input: unknown): { accessToken: string } {
  const data = input as { accessToken?: unknown };
  if (!data || typeof data.accessToken !== "string" || !data.accessToken) {
    throw new Error("Connect to Discord first.");
  }
  return { accessToken: data.accessToken };
}

export interface SavedPreset {
  id: string;
  name: string;
  emoji: string;
  accent: string;
  draft: PresenceDraft;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToPreset(row: any): SavedPreset {
  return {
    id: row.id as string,
    name: row.name as string,
    emoji: row.emoji as string,
    accent: row.accent as string,
    draft: row.draft as PresenceDraft,
  };
}

export const listSavedPresets = createServerFn({ method: "POST" })
  .inputValidator(requireToken)
  .handler(async ({ data }) => {
    const userId = await discordUserId(data.accessToken);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: rows, error } = await supabaseAdmin
      .from("presets")
      .select("*")
      .eq("discord_user_id", userId)
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    return { presets: (rows ?? []).map(rowToPreset) };
  });

export const saveSavedPreset = createServerFn({ method: "POST" })
  .inputValidator(
    (input: { accessToken: string; id?: string; name: string; emoji?: string; accent?: string; draft: PresenceDraft }) => {
      const { accessToken } = requireToken(input);
      if (!input.name?.trim()) throw new Error("Give the preset a name.");
      if (!input.draft) throw new Error("Nothing to save.");
      return {
        accessToken,
        id: input.id,
        name: input.name.trim().slice(0, 60),
        emoji: (input.emoji || "✨").slice(0, 8),
        accent: input.accent || "oklch(0.8 0.13 180)",
        draft: input.draft,
      };
    },
  )
  .handler(async ({ data }) => {
    const userId = await discordUserId(data.accessToken);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const payload = {
      discord_user_id: userId,
      name: data.name,
      emoji: data.emoji,
      accent: data.accent,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      draft: data.draft as any,
    };

    if (data.id) {
      const { data: row, error } = await supabaseAdmin
        .from("presets")
        .update(payload)
        .eq("id", data.id)
        .eq("discord_user_id", userId)
        .select("*")
        .single();
      if (error) throw new Error(error.message);
      return { preset: rowToPreset(row) };
    }

    const { data: row, error } = await supabaseAdmin
      .from("presets")
      .insert(payload)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return { preset: rowToPreset(row) };
  });

export const deleteSavedPreset = createServerFn({ method: "POST" })
  .inputValidator((input: { accessToken: string; id: string }) => {
    const { accessToken } = requireToken(input);
    if (!input.id) throw new Error("Missing preset.");
    return { accessToken, id: input.id };
  })
  .handler(async ({ data }) => {
    const userId = await discordUserId(data.accessToken);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("presets")
      .delete()
      .eq("id", data.id)
      .eq("discord_user_id", userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/**
 * Stores a photo picked on the phone and returns a permanent https URL that
 * Discord can fetch. The bucket itself stays private — the image is served
 * back through this app's own public image route.
 */
export const uploadPresenceImage = createServerFn({ method: "POST" })
  .inputValidator((input: { accessToken: string; dataUrl: string }) => {
    const { accessToken } = requireToken(input);
    if (typeof input.dataUrl !== "string" || !input.dataUrl.startsWith("data:image/")) {
      throw new Error("That wasn't a usable image.");
    }
    return { accessToken, dataUrl: input.dataUrl };
  })
  .handler(async ({ data }) => {
    const userId = await discordUserId(data.accessToken);

    const match = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(data.dataUrl);
    if (!match) throw new Error("That wasn't a usable image.");
    const contentType = match[1]!;
    const bytes = Buffer.from(match[2]!, "base64");
    if (bytes.byteLength > 5 * 1024 * 1024) {
      throw new Error("That photo is still too large after compression.");
    }

    const ext = contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";
    const name = `${userId}-${crypto.randomUUID()}.${ext}`;

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.storage
      .from("presence-images")
      .upload(name, bytes, { contentType, upsert: false });
    if (error) throw new Error(error.message);

    return { url: `${publicBaseUrl()}/api/public/presence-image/${name}` };
  });

/**
 * Discord cannot use a raw external URL in an activity's assets. Registering it
 * as an application external asset returns an `mp:` path that it can.
 */
export const resolveExternalAssets = createServerFn({ method: "POST" })
  .inputValidator((input: { accessToken: string; urls: string[] }) => {
    const { accessToken } = requireToken(input);
    const urls = (input.urls ?? []).filter((u) => typeof u === "string" && /^https?:\/\//i.test(u));
    return { accessToken, urls: urls.slice(0, 4) };
  })
  .handler(async ({ data }) => {
    if (data.urls.length === 0) return { mapping: {} as Record<string, string> };

    const clientId = process.env["DISCORD_CLIENT_ID"];
    if (!clientId) throw new Error("Discord credentials are not configured");

    const res = await fetch(`https://discord.com/api/v10/applications/${clientId}/external-assets`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${data.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ urls: data.urls }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error("external-assets failed", res.status, text);
      throw new Error("Discord wouldn't accept one of the images.");
    }

    const list = (await res.json()) as { url?: string; external_asset_path?: string }[];
    const mapping: Record<string, string> = {};
    list.forEach((entry, index) => {
      const source = entry.url ?? data.urls[index];
      if (source && entry.external_asset_path) {
        mapping[source] = `mp:${entry.external_asset_path}`;
      }
    });
    return { mapping };
  });
