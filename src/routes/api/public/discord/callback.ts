import { createFileRoute } from "@tanstack/react-router";

/**
 * Official Discord OAuth2 redirect target.
 *
 * Discord sends the authorization code here; we exchange it server-side for an
 * access + refresh token pair, store both in the database, and hand the browser
 * only an opaque httpOnly session cookie.
 *
 * This exact URL must be registered in the Discord Developer Portal under
 * OAuth2 → Redirects: https://rich-status-studio.lovable.app/api/public/discord/callback
 *
 * The exchange below reuses `discordRedirectUri()` rather than `url.origin` so
 * the redirect_uri is byte-identical to the authorize request no matter which
 * host (the real site, a preview URL or Discord's Activity proxy) serves this
 * route.
 */
export const Route = createFileRoute("/api/public/discord/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error_description") ?? url.searchParams.get("error");

        const back = (query: string) =>
          new Response(null, { status: 302, headers: { location: `/${query}` } });

        if (error) return back(`?link=error&reason=${encodeURIComponent(error)}`);
        if (!code) return back("?link=error&reason=missing_code");

        try {
          const { exchangeCode, storeAccount, createSession, discordRedirectUri, SESSION_COOKIE } =
            await import("@/lib/discord-oauth.server");
          const tokens = await exchangeCode(code, discordRedirectUri());
          const user = await storeAccount(tokens);
          const session = await createSession(user.id);

          return new Response(null, {
            status: 302,
            headers: {
              location: "/?link=ok",
              "set-cookie": `${SESSION_COOKIE}=${session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`,
            },
          });
        } catch (e) {
          console.error("Discord OAuth callback failed", e);
          const reason = e instanceof Error ? e.message : "unknown";
          return back(`?link=error&reason=${encodeURIComponent(reason)}`);
        }
      },
    },
  },
});
