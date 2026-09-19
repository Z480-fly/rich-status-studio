import { createFileRoute } from "@tanstack/react-router";

/**
 * Serves an uploaded presence image from the private storage bucket so Discord
 * (and anyone rendering the profile) can fetch it over plain https.
 */
export const Route = createFileRoute("/api/public/presence-image/$name")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const name = params.name;
        if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) {
          return new Response("Not found", { status: 404 });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data, error } = await supabaseAdmin.storage.from("presence-images").download(name);
        if (error || !data) return new Response("Not found", { status: 404 });

        return new Response(await data.arrayBuffer(), {
          headers: {
            "content-type": data.type || "image/jpeg",
            "cache-control": "public, max-age=31536000, immutable",
          },
        });
      },
    },
  },
});
