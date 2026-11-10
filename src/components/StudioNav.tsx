import { Link } from "@tanstack/react-router";
import { MessageCircle, Palette, Sparkles, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";

export function StudioNav({ active = "creator" }: { active?: "creator" | "inbox" }) {
  return <header className="studio-nav flex flex-wrap items-center justify-between gap-4 border-b border-border pb-5">
    <Link to="/" className="flex items-center gap-3" aria-label="Zora Studio home">
      <span className="flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground"><Sparkles className="size-5" /></span>
      <span className="font-display text-xl font-semibold">𝒁𝒐𝒓𝒂 𝑺𝒕𝒖𝒅𝒊𝒐 <span className="text-primary">✦</span></span>
    </Link>
    <nav aria-label="Zora navigation" className="flex w-full items-center gap-1 sm:w-auto">
      <Button variant={active === "creator" ? "secondary" : "ghost"} asChild className="flex-1 sm:flex-none"><Link to="/"><Sparkles />Creator</Link></Button>
      <Button variant={active === "inbox" ? "secondary" : "ghost"} asChild className="flex-1 sm:flex-none"><Link to="/inbox"><MessageCircle />Inbox</Link></Button>
      <Button variant="ghost" asChild className="flex-1 sm:flex-none"><Link to="/fonts"><Palette />Fonts</Link></Button>
      <Button variant="ghost" asChild className="flex-1 sm:flex-none"><Link to="/profile"><UserRound />Profile</Link></Button>
    </nav>
  </header>;
}