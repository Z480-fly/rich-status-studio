import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Check, Copy, MessageCircle, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProfileView } from "@/components/ProfileView";
import { getPublicProfile } from "@/lib/profiles.functions";

export const Route = createFileRoute("/u/$handle")({
  head: ({ params }) => ({
    meta: [
      { title: `@${params.handle} — Zora` },
      { name: "description", content: `@${params.handle} on Zora — links, apps and a bit about them.` },
      { property: "og:title", content: `@${params.handle} — Zora` },
      { property: "og:description", content: `@${params.handle} on Zora — links, apps and a bit about them.` },
      { property: "og:type", content: "profile" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: PublicProfilePage,
});

function PublicProfilePage() {
  const { handle } = Route.useParams();
  const profileFn = useServerFn(getPublicProfile);
  const [copied, setCopied] = useState(false);
  const query = useQuery({
    queryKey: ["profile", "public", handle],
    queryFn: () => profileFn({ data: { handle } }),
    retry: false,
  });

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const profile = query.data?.profile;

  return (
    <main className="relative flex min-h-screen flex-col">
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-between p-4">
        <Link to="/" className="pointer-events-auto rounded-full border border-border/60 bg-background/70 px-3 py-1 text-xs font-semibold backdrop-blur">
          𝒁𝒐𝒓𝒂 <span className="text-primary">✦</span>
        </Link>
        <Button size="sm" variant="outline" className="pointer-events-auto bg-background/70 backdrop-blur" asChild>
          <Link to="/profile"><Sparkles />Make your own</Link>
        </Button>
      </div>

      {profile ? (
        <>
          <ProfileView profile={profile} className="flex-1" />
          <div className="sticky bottom-0 border-t border-border bg-background/85 px-4 py-3 backdrop-blur">
            <div className="mx-auto flex w-full max-w-xl flex-wrap items-center justify-center gap-2">
              <Button asChild>
                {/* Plain link so the ?to= invite parameter reaches the inbox route untouched. */}
                <a href={`/inbox?to=${encodeURIComponent(profile.discordId)}`}><MessageCircle />Message on Zora</a>
              </Button>
              <Button variant="outline" onClick={() => void copyLink()}>
                {copied ? <Check /> : <Copy />}{copied ? "Link copied" : "Copy link"}
              </Button>
            </div>
          </div>
        </>
      ) : query.isPending ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">Opening @{handle}…</p>
        </div>
      ) : query.isError ? (
        <div className="flex flex-1 items-center justify-center px-4">
          <div className="panel max-w-md p-8 text-center">
            <h1 className="text-xl font-semibold">Could not open this profile</h1>
            <p className="mt-2 break-words text-sm text-muted-foreground">{query.error.message}</p>
            <Button className="mt-4" variant="outline" onClick={() => void query.refetch()}>Try again</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center px-4">
          <div className="panel max-w-md p-8 text-center">
            <h1 className="text-xl font-semibold">This profile isn&apos;t available</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Nothing is published at /u/{handle} yet — the handle may be wrong or the profile may be private.
            </p>
            <Button className="mt-4" asChild><Link to="/profile">Build your own profile</Link></Button>
          </div>
        </div>
      )}
    </main>
  );
}
