import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const Body = z.object({
  discord_user_id: z.string().min(1).max(64),
  state: z.enum(["idle", "connecting", "running", "cleared", "error"]),
  // nullish, not optional: the worker reports "message": null when there is
  // nothing to say, and `.optional()` rejects an explicit null — which turned
  // every heartbeat into a 400 and left the panel showing "No worker activity".
  message: z.string().max(500).nullish(),
  revision: z.number().int().nonnegative().nullish(),
});

/** The Linux worker reports here so the phone can see whether presence is live. */
export const Route = createFileRoute("/api/public/worker/heartbeat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env["WORKER_SHARED_SECRET"];
        const auth = request.headers.get("authorization");
        if (!secret || auth !== `Bearer ${secret}`) {
          return new Response("Unauthorized", { status: 401 });
        }

        const parsed = Body.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return Response.json({ error: "Invalid body" }, { status: 400 });

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { error } = await supabaseAdmin
          .from("presence_sessions")
          .update({
            worker_state: parsed.data.state,
            worker_message: parsed.data.message ?? null,
            worker_heartbeat_at: new Date().toISOString(),
          })
          .eq("discord_user_id", parsed.data.discord_user_id);
        if (error) return Response.json({ error: error.message }, { status: 500 });

        return Response.json({ ok: true });
      },
    },
  },
});
