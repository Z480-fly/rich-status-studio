/**
 * Server-only Discord OAuth2 helpers.
 *
 * Client id/secret and refresh tokens never leave this file's execution
 * context — the browser only ever receives an opaque app session cookie.
 */

export const DISCORD_SCOPES = ["identify", "sdk.social_layer_presence"] as const;

export interface DiscordTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
}

function credentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env["DISCORD_CLIENT_ID"];
  const clientSecret = process.env["DISCORD_CLIENT_SECRET"];
  if (!clientId || !clientSecret) throw new Error("Discord credentials are not configured");
  return { clientId, clientSecret };
}

export function authorizeUrl(redirectUri: string, state: string): string {
  const { clientId } = credentials();
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: DISCORD_SCOPES.join(" "),
    state,
    prompt: "consent",
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

async function tokenRequest(body: Record<string, string>): Promise<DiscordTokens> {
  const { clientId, clientSecret } = credentials();
  const res = await fetch("https://discord.com/api/v10/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...body }),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error("Discord token request failed", res.status, text);
    throw new Error(`Discord rejected the request (${res.status}).`);
  }
  return JSON.parse(text) as DiscordTokens;
}

export function exchangeCode(code: string, redirectUri: string): Promise<DiscordTokens> {
  return tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
}

export function refreshTokens(refreshToken: string): Promise<DiscordTokens> {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
}

export async function identify(accessToken: string): Promise<{ id: string; username: string }> {
  const res = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error("Discord session expired.");
  const json = (await res.json()) as { id?: string; username?: string; global_name?: string };
  if (!json.id) throw new Error("Discord did not identify the account.");
  return { id: json.id, username: json.global_name || json.username || "you" };
}

/** Stores/updates the account row and returns the Discord user id. */
export async function storeAccount(tokens: DiscordTokens): Promise<{ id: string; username: string }> {
  const user = await identify(tokens.access_token);
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin.from("discord_accounts").upsert(
    {
      discord_user_id: user.id,
      username: user.username,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      scope: tokens.scope ?? null,
      expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    },
    { onConflict: "discord_user_id" },
  );
  if (error) throw new Error(error.message);
  return user;
}

/** Returns a valid access token for the user, refreshing it when it is close to expiry. */
export async function freshAccessToken(discordUserId: string): Promise<string | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: row } = await supabaseAdmin
    .from("discord_accounts")
    .select("access_token, refresh_token, expires_at")
    .eq("discord_user_id", discordUserId)
    .maybeSingle();
  if (!row) return null;

  const expiresAt = new Date(row.expires_at as string).getTime();
  if (expiresAt - Date.now() > 120_000) return row.access_token as string;

  try {
    const tokens = await refreshTokens(row.refresh_token as string);
    await supabaseAdmin
      .from("discord_accounts")
      .update({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      })
      .eq("discord_user_id", discordUserId);
    return tokens.access_token;
  } catch (error) {
    console.error("Discord token refresh failed", error);
    return null;
  }
}

export const SESSION_COOKIE = "zora_session";

export async function createSession(discordUserId: string): Promise<string> {
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin
    .from("app_sessions")
    .insert({ token, discord_user_id: discordUserId });
  if (error) throw new Error(error.message);
  return token;
}

export function readSessionCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export async function sessionUser(token: string | null): Promise<string | null> {
  if (!token) return null;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("app_sessions")
    .select("discord_user_id, expires_at")
    .eq("token", token)
    .maybeSingle();
  if (!data) return null;
  if (new Date(data.expires_at as string).getTime() < Date.now()) return null;
  return data.discord_user_id as string;
}
