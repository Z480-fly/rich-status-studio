import { createServerFn } from "@tanstack/react-start";
import type { Json } from "@/integrations/supabase/types";
import {
  HANDLE_PATTERN,
  emptyProfile,
  readProfileDraft,
  type ProfileDraft,
  type PublicProfile,
} from "./profiles.schema";
import { slugify } from "./fonts";

/**
 * Profiles are service-role data: the browser never queries the table directly,
 * it only talks to these functions. Identity comes from the Discord OAuth
 * session cookie in a browser tab, or from the Embedded Activity access token.
 */

function accountInput(input: unknown): { accessToken?: string } {
  const data = input as { accessToken?: unknown };
  return typeof data?.accessToken === "string" && data.accessToken ? { accessToken: data.accessToken } : {};
}

async function viewer(accessToken?: string): Promise<{ id: string; name: string }> {
  if (accessToken) {
    const res = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error("Your Discord connection expired. Connect again.");
    const user = (await res.json()) as { id?: string; username?: string; global_name?: string };
    if (!user.id) throw new Error("Discord did not identify you.");
    return { id: user.id, name: user.global_name || user.username || "Zora user" };
  }

  const [{ getRequestHeader }, { readSessionCookie, sessionUser }] = await Promise.all([
    import("@tanstack/react-start/server"),
    import("./discord-oauth.server"),
  ]);
  const id = await sessionUser(readSessionCookie(getRequestHeader("cookie")));
  if (!id) throw new Error("Link your Discord account to build your profile.");
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("discord_accounts")
    .select("username")
    .eq("discord_user_id", id)
    .maybeSingle();
  return { id, name: data?.username || "Zora user" };
}

type ProfileRow = {
  handle: string;
  display_name: string;
  tagline: string;
  theme: Json;
  sections: Json;
  published: boolean;
};

/** Stored rows were validated on the way in; re-validate so old data can never break a page. */
function rowToProfile(row: ProfileRow, fallbackName: string): ProfileDraft {
  const fallback = emptyProfile(fallbackName);
  try {
    return readProfileDraft({
      handle: row.handle,
      displayName: row.display_name,
      tagline: row.tagline,
      theme: row.theme,
      sections: row.sections,
      published: row.published,
    });
  } catch {
    return { ...fallback, handle: row.handle || fallback.handle, published: row.published };
  }
}

export interface MyProfile {
  viewer: { id: string; name: string };
  profile: ProfileDraft;
  saved: boolean;
}

export const getMyProfile = createServerFn({ method: "POST" })
  .validator(accountInput)
  .handler(async ({ data }): Promise<MyProfile> => {
    const me = await viewer(data.accessToken);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin
      .from("profiles")
      .select("handle,display_name,tagline,theme,sections,published")
      .eq("discord_user_id", me.id)
      .maybeSingle();
    if (error) throw new Error("Could not load your profile. Try again.");
    const profile = row ? rowToProfile(row, me.name) : { ...emptyProfile(me.name), handle: slugify(me.name) };
    return { viewer: { id: me.id, name: me.name }, profile, saved: Boolean(row) };
  });

export const saveMyProfile = createServerFn({ method: "POST" })
  .validator((input: { accessToken?: string; profile: ProfileDraft }) => ({
    ...accountInput(input),
    profile: input?.profile,
  }))
  .handler(async ({ data }): Promise<{ profile: ProfileDraft }> => {
    const me = await viewer(data.accessToken);
    const draft = readProfileDraft(data.profile);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin
      .from("profiles")
      .upsert(
        {
          discord_user_id: me.id,
          handle: draft.handle,
          display_name: draft.displayName,
          tagline: draft.tagline,
          theme: draft.theme as unknown as Json,
          sections: draft.sections as unknown as Json,
          published: draft.published,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "discord_user_id" },
      )
      .select("handle,display_name,tagline,theme,sections,published")
      .single();
    if (error) {
      if (error.code === "23505") throw new Error("That handle is taken — pick another one.");
      if (error.code === "23503") throw new Error("Link your Discord account before saving a profile.");
      throw new Error("Could not save your profile. Try again.");
    }
    return { profile: rowToProfile(row, me.name) };
  });

/** Public read used by /u/<handle>. Unpublished profiles are invisible. */
export const getPublicProfile = createServerFn({ method: "POST" })
  .validator((input: { handle: string }) => {
    const handle = String(input?.handle ?? "").trim().toLowerCase();
    if (!HANDLE_PATTERN.test(handle)) throw new Error("That profile link is not valid.");
    return { handle };
  })
  .handler(async ({ data }): Promise<{ profile: PublicProfile | null }> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin
      .from("profiles")
      .select("discord_user_id,handle,display_name,tagline,theme,sections,published,updated_at")
      .eq("handle", data.handle)
      .maybeSingle();
    if (error) throw new Error("Could not load that profile. Try again.");
    if (!row || !row.published) return { profile: null };
    const draft = rowToProfile(row, row.display_name);
    return {
      profile: {
        handle: draft.handle,
        displayName: draft.displayName,
        tagline: draft.tagline,
        theme: draft.theme,
        sections: draft.sections,
        discordId: row.discord_user_id,
        updatedAt: row.updated_at,
      },
    };
  });
