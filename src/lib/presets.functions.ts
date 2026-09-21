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

/**
 * The access token is optional: inside an Activity the Embedded SDK supplies
 * one, and in a browser tab the linked-account session cookie stands in for it
 * (see `actingUserId`). Anything else is ignored rather than trusted.
 */
function accountInput(input: unknown): { accessToken?: string } {
  const data = input as { accessToken?: unknown };
  const accessToken =
    typeof data?.accessToken === "string" && data.accessToken ? data.accessToken : undefined;
  return accessToken ? { accessToken } : {};
}

/**
 * Resolves the acting user from the Embedded Activity's access token when one
 * was passed, otherwise from the app session cookie set by the browser OAuth
 * link.
 *
 * Both surfaces are legitimate: inside an Activity the Discord iframe never
 * receives the production cookie, and outside it there is no SDK access token.
 * Photo uploads have to work from either one.
 */
async function actingUserId(accessToken?: string): Promise<string> {
  if (accessToken) return discordUserId(accessToken);

  const [{ getRequestHeader }, { readSessionCookie, sessionUser }] = await Promise.all([
    import("@tanstack/react-start/server"),
    import("./discord-oauth.server"),
  ]);
  const userId = await sessionUser(readSessionCookie(getRequestHeader("cookie")));
  if (!userId) {
    throw new Error(
      "Link your Discord account in a browser tab first — photos are stored against your account.",
    );
  }
  return userId;
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
  .validator(accountInput)
  .handler(async ({ data }) => {
    const userId = await actingUserId(data.accessToken);
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
  .validator(
    (input: {
      accessToken?: string;
      id?: string;
      name: string;
      emoji?: string;
      accent?: string;
      draft: PresenceDraft;
    }) => {
      const { accessToken } = accountInput(input);
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
    const userId = await actingUserId(data.accessToken);
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
  .validator((input: { accessToken?: string; id: string }) => {
    const { accessToken } = accountInput(input);
    if (!input.id) throw new Error("Missing preset.");
    return { accessToken, id: input.id };
  })
  .handler(async ({ data }) => {
    const userId = await actingUserId(data.accessToken);
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
 *
 * Identity comes from the Activity's access token or, in a plain browser tab,
 * from the linked-account session cookie.
 */
export const uploadPresenceImage = createServerFn({ method: "POST" })
  .validator((input: { accessToken?: string; dataUrl: string }) => {
    if (typeof input?.dataUrl !== "string" || !input.dataUrl.startsWith("data:image/")) {
      throw new Error("That wasn't a usable image.");
    }
    return { ...accountInput(input), dataUrl: input.dataUrl };
  })
  .handler(async ({ data }) => {
    const userId = await actingUserId(data.accessToken);

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
 * Discord's current Embedded App SDK supports public HTTPS URLs directly in
 * Rich Presence assets. Keep this server function as a compatibility layer so
 * older saved presets still work, but don't require the access token or the
 * external-assets endpoint just to display an image.
 */
export const resolveExternalAssets = createServerFn({ method: "POST" })
  .validator((input: { accessToken?: string; urls: string[] }) => {
    const urls = (input.urls ?? []).filter((u) => typeof u === "string" && /^https?:\/\//i.test(u));
    return { urls: urls.slice(0, 4) };
  })
  .handler(async ({ data }) => ({
    mapping: Object.fromEntries(data.urls.map((url) => [url, url])),
  }));
