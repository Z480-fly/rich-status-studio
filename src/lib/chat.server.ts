import { getRequestHeader, setResponseHeader } from "@tanstack/react-start/server";
import { readSessionCookie, sessionUser } from "./discord-oauth.server";

export async function chatIdentity(accessToken?: string) {
  setResponseHeader("Cache-Control", "no-store");
  let id: string | null = null;
  let username: string | undefined;
  let displayName: string | undefined;
  if (accessToken) {
    const response = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new Error("Your Discord connection expired. Connect again.");
    const user = await response.json() as { id?: string; username?: string; global_name?: string };
    id = user.id ?? null;
    username = user.username;
    displayName = user.global_name || user.username;
  } else {
    id = await sessionUser(readSessionCookie(getRequestHeader("cookie")));
  }
  if (!id) return null;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  if (!username) {
    const { data, error } = await supabaseAdmin.from("discord_accounts").select("username").eq("discord_user_id", id).maybeSingle();
    if (error) throw new Error("Inbox is temporarily unavailable. Try again.");
    username = data?.username || undefined;
    displayName = username;
  }
  if (!username || !displayName) throw new Error("Link your Discord account again to open your inbox.");
  const { error } = await supabaseAdmin.from("chat_users").upsert({ discord_user_id: id, discord_name: username, display_name: displayName, updated_at: new Date().toISOString() });
  if (error) throw new Error("Inbox is temporarily unavailable. Try again.");
  return { id, username, displayName };
}

export async function requireChatIdentity(accessToken?: string) {
  const user = await chatIdentity(accessToken);
  if (!user) throw new Error("Link your Discord account to open your inbox.");
  return user;
}