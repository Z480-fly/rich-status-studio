import { createServerFn } from "@tanstack/react-start";

/**
 * The Discord application (client) ID is public — it is embedded in every
 * OAuth URL — but it is stored as a project secret, so we hand it to the
 * browser through a tiny server function.
 */
export const getDiscordClientId = createServerFn({ method: "GET" }).handler(async () => {
  return {
    clientId: process.env["DISCORD_CLIENT_ID"] ?? process.env["VITE_DISCORD_CLIENT_ID"] ?? null,
  };
});

/**
 * Exchanges the OAuth authorization code returned by the Discord embedded SDK
 * for an access token. The client secret never leaves the server.
 */
export const exchangeDiscordCode = createServerFn({ method: "POST" })
  .validator((input: { code: string }) => {
    if (!input || typeof input.code !== "string" || input.code.length === 0) {
      throw new Error("Missing authorization code");
    }
    return { code: input.code };
  })
  .handler(async ({ data }) => {
    const clientId = process.env["DISCORD_CLIENT_ID"] ?? process.env["VITE_DISCORD_CLIENT_ID"];
    const clientSecret = process.env["DISCORD_CLIENT_SECRET"];

    if (!clientId || !clientSecret) {
      throw new Error("Discord credentials are not configured");
    }

    const response = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        code: data.code,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("Discord token exchange failed", response.status, text);
      throw new Error("Discord rejected the sign-in. Check the app credentials.");
    }

    const json = (await response.json()) as { access_token?: string };
    if (!json.access_token) {
      throw new Error("Discord did not return an access token");
    }

    return { accessToken: json.access_token };
  });
