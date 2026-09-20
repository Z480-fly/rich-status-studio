import { createFileRoute } from "@tanstack/react-router";

/**
 * Control-plane endpoint for the Linux presence worker.
 *
 * The worker polls this with `Authorization: Bearer $WORKER_SHARED_SECRET` and
 * receives every presence the server wants running (or explicitly cleared),
 * together with a freshly refreshed Discord access token for that account.
 *
 * Never call this from a browser — it hands out user access tokens.
 */
export const Route = createFileRoute("/api/public/worker/poll")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const secret = process.env["WORKER_SHARED_SECRET"];
        const auth = request.headers.get("authorization");
        if (!secret || auth !== `Bearer ${secret}`) {
          return new Response("Unauthorized", { status: 401 });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { freshAccessToken } = await import("@/lib/discord-oauth.server");

        const { data: rows, error } = await supabaseAdmin
          .from("presence_sessions")
          .select("discord_user_id, desired_state, activity, revision, updated_at")
          .order("updated_at", { ascending: true })
          .limit(200);
        if (error) return Response.json({ error: error.message }, { status: 500 });

        const sessions = [];
        for (const row of rows ?? []) {
          const running = row.desired_state === "running";
          const token = running ? await freshAccessToken(row.discord_user_id as string) : null;
          if (running && !token) {
            await supabaseAdmin
              .from("presence_sessions")
              .update({ worker_state: "error", worker_message: "Discord token could not be refreshed" })
              .eq("discord_user_id", row.discord_user_id as string);
            continue;
          }
          sessions.push({
            discord_user_id: row.discord_user_id,
            desired_state: row.desired_state,
            revision: row.revision,
            activity: row.activity,
            access_token: token,
          });
        }

        return Response.json({ sessions, server_time: new Date().toISOString() });
      },
    },
  },
});
