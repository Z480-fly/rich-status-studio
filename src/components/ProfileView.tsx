import type { CSSProperties } from "react";
import {
  ExternalLink,
  Github,
  Globe,
  Instagram,
  MessageCircle,
  Music2,
  Twitch,
  Youtube,
} from "lucide-react";
import { transform } from "@/lib/fonts";
import type { ProfileDraft, ProfileSection, PublicProfile } from "@/lib/profiles.schema";

/**
 * Renders a Zora profile. The builder preview and the public page use this same
 * component, so what someone arranges is exactly what visitors see.
 */

interface Palette {
  text: string;
  muted: string;
  card: string;
  border: string;
  shell: CSSProperties;
}

function paletteFor(background: string, accent: string, image: string): Palette {
  const dark: Palette = {
    text: "#f4f4f5",
    muted: "color-mix(in oklab, #f4f4f5 62%, transparent)",
    card: "color-mix(in oklab, #ffffff 7%, transparent)",
    border: "color-mix(in oklab, #ffffff 15%, transparent)",
    shell: {},
  };
  // A photo always gets a dark scrim so the text stays readable whatever was uploaded.
  if (image) {
    return {
      ...dark,
      shell: {
        backgroundColor: "#08090c",
        backgroundImage: `linear-gradient(180deg, rgba(8,10,16,0.72), rgba(8,10,16,0.86)), url("${image.replace(/"/g, "%22")}")`,
        backgroundSize: "cover",
        backgroundPosition: "center",
        backgroundAttachment: "fixed",
      },
    };
  }
  switch (background) {
    case "noir":
      return { ...dark, shell: { background: `radial-gradient(120% 80% at 50% 0%, ${accent}14 0%, transparent 55%), #08090c` } };
    case "grid":
      return {
        ...dark,
        shell: {
          backgroundImage: `linear-gradient(${accent}14 1px, transparent 1px), linear-gradient(90deg, ${accent}14 1px, transparent 1px), radial-gradient(100% 70% at 50% 0%, #1b2230 0%, #0a0d13 70%)`,
          backgroundSize: "44px 44px, 44px 44px, 100% 100%",
          backgroundColor: "#0a0d13",
        },
      };
    case "sunset":
      return { ...dark, shell: { background: `radial-gradient(120% 90% at 15% 0%, ${accent}40 0%, transparent 50%), radial-gradient(100% 80% at 90% 10%, #f9731633 0%, transparent 55%), linear-gradient(180deg, #1a1020 0%, #120d18 100%)` } };
    case "paper":
      return {
        text: "#18181b",
        muted: "color-mix(in oklab, #18181b 62%, transparent)",
        card: "color-mix(in oklab, #18181b 4%, transparent)",
        border: "color-mix(in oklab, #18181b 14%, transparent)",
        shell: { background: `radial-gradient(100% 70% at 50% 0%, ${accent}33 0%, transparent 60%), linear-gradient(180deg, #f7f5f0 0%, #efece5 100%)` },
      };
    case "mint":
      return {
        text: "#08211b",
        muted: "color-mix(in oklab, #08211b 62%, transparent)",
        card: "color-mix(in oklab, #08211b 5%, transparent)",
        border: "color-mix(in oklab, #08211b 16%, transparent)",
        shell: { background: `radial-gradient(100% 80% at 20% 0%, ${accent}66 0%, transparent 55%), linear-gradient(180deg, #e8fff6 0%, #d6f7ea 100%)` },
      };
    default:
      return {
        ...dark,
        shell: { background: `radial-gradient(120% 90% at 10% 0%, ${accent}30 0%, transparent 50%), radial-gradient(90% 70% at 90% 8%, #7dd3fc22 0%, transparent 55%), linear-gradient(180deg, #0b1019 0%, #111823 100%)` },
      };
  }
}

function iconFor(url: string) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    if (host.includes("discord")) return MessageCircle;
    if (host.includes("instagram")) return Instagram;
    if (host.includes("spotify")) return Music2;
    if (host.includes("youtube") || host.includes("youtu.be")) return Youtube;
    if (host.includes("twitch")) return Twitch;
    if (host.includes("github")) return Github;
  } catch {
    /* a malformed link still renders as a plain website link */
  }
  return Globe;
}

function SectionBody({ section, palette, font }: { section: ProfileSection; palette: Palette; font: string }) {
  const stamp = (value: string) => transform(value, font || undefined);
  if (section.kind === "about" || section.kind === "text") {
    if (!section.body) return <p style={{ color: palette.muted }} className="text-sm italic">Nothing written here yet.</p>;
    return (
      <p className="whitespace-pre-wrap text-sm leading-relaxed" style={{ color: palette.text }}>
        {stamp(section.body)}
      </p>
    );
  }
  if (!section.items.length) return <p style={{ color: palette.muted }} className="text-sm italic">No links yet.</p>;
  return (
    <div className={section.kind === "apps" ? "grid gap-2 sm:grid-cols-2" : "flex flex-col gap-2"}>
      {section.items.map((item) => {
        const Icon = iconFor(item.url);
        return (
          <a
            key={item.id}
            href={item.url}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-transform hover:-translate-y-0.5"
            style={{ background: palette.card, border: `1px solid ${palette.border}`, color: palette.text }}
          >
            <Icon className="size-4 shrink-0" style={{ color: palette.text }} />
            <span className="min-w-0 flex-1 truncate font-medium">{stamp(item.label)}</span>
            <ExternalLink className="size-3.5 shrink-0 opacity-40 transition-opacity group-hover:opacity-90" />
          </a>
        );
      })}
    </div>
  );
}

export function ProfileView({
  profile,
  preview = false,
  className = "",
}: {
  profile: ProfileDraft | PublicProfile;
  preview?: boolean;
  className?: string;
}) {
  const { theme } = profile;
  const palette = paletteFor(theme.background, theme.accent, theme.backgroundImage);
  const stamp = (value: string) => transform(value, theme.font || undefined);
  const visible = profile.sections.filter((section) => preview || !section.hidden);
  const layout = theme.layout;
  const container = layout === "spotlight" ? "max-w-3xl" : layout === "stacked" ? "max-w-2xl" : "max-w-xl";
  const headerAlign = layout === "stacked" ? "items-start text-left" : "items-center text-center";
  const sectionGrid = layout === "spotlight" ? "grid gap-4 sm:grid-cols-2" : "flex flex-col gap-5";

  return (
    <div className={`w-full ${className}`} style={palette.shell}>
      <div className={`mx-auto w-full ${container} px-5 py-10 sm:px-6 sm:py-14`}>
        <header className={`flex flex-col gap-4 ${headerAlign}`}>
          <div
            className="flex size-16 shrink-0 items-center justify-center rounded-2xl text-2xl font-semibold"
            style={{ background: `color-mix(in oklab, ${theme.accent} 22%, transparent)`, border: `1px solid ${theme.accent}66`, color: theme.accent }}
          >
            {profile.displayName.slice(0, 1).toUpperCase()}
          </div>
          <div className={layout === "stacked" ? "" : "text-center"}>
            <h1 className="text-3xl font-semibold leading-tight sm:text-4xl" style={{ color: palette.text }}>
              {stamp(profile.displayName)}
            </h1>
            {profile.tagline && (
              <p className="mt-2 text-sm sm:text-base" style={{ color: palette.muted }}>
                {stamp(profile.tagline)}
              </p>
            )}
            <p className="mt-3 text-xs uppercase tracking-[0.2em]" style={{ color: theme.accent }}>
              @{profile.handle}
            </p>
          </div>
          {theme.decoration && (
            <p className="select-all text-sm" style={{ color: palette.muted }} aria-hidden>
              {theme.decoration}
            </p>
          )}
        </header>

        <div className={`mt-10 ${sectionGrid}`}>
          {visible.map((section) => (
            <section
              key={section.id}
              className={layout === "stacked" ? "rounded-2xl p-4 sm:p-5" : ""}
              style={layout === "stacked" ? { background: palette.card, border: `1px solid ${palette.border}` } : undefined}
            >
              <div className="mb-3 flex items-center gap-2">
                <h2 className="text-xs font-semibold uppercase tracking-[0.22em]" style={{ color: palette.muted }}>
                  {stamp(section.title)}
                </h2>
                {preview && section.hidden && (
                  <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide" style={{ background: `${theme.accent}26`, color: theme.accent }}>
                    Hidden
                  </span>
                )}
              </div>
              <SectionBody section={section} palette={palette} font={theme.font} />
            </section>
          ))}
          {!visible.length && (
            <p className="text-sm italic" style={{ color: palette.muted }}>
              This profile has no sections yet.
            </p>
          )}
        </div>

        <footer className="mt-12 text-center text-xs" style={{ color: palette.muted }}>
          Made with <span style={{ color: theme.accent }}>✦</span> Zora
        </footer>
      </div>
    </div>
  );
}
