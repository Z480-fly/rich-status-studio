import { createFileRoute } from "@tanstack/react-router";
import { Inbox } from "@/components/Inbox";

export const Route = createFileRoute("/inbox")({
  head: () => ({ meta: [
    { title: "Inbox — Zora Studio" },
    { name: "description", content: "Private conversations with other Zora Studio users." },
    { property: "og:title", content: "Inbox — Zora Studio" },
    { property: "og:description", content: "Connect with other Zora Studio users in your private inbox." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
  component: Inbox,
});