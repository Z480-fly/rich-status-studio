import { DIVIDERS, FONT_STYLE_IDS, slugify } from "./fonts";

/**
 * Profile data model, shared by the builder, the server functions and the
 * public page. Everything stored is plain data: a theme plus an ordered list of
 * sections, which is what makes reordering, hiding and custom sections cheap.
 */

export type SectionKind = "about" | "links" | "apps" | "text";

export interface ProfileItem {
  id: string;
  label: string;
  url: string;
}

export interface ProfileSection {
  id: string;
  kind: SectionKind;
  title: string;
  hidden: boolean;
  body: string;
  items: ProfileItem[];
}

export interface ProfileTheme {
  accent: string;
  background: string;
  /** Optional https image drawn behind the profile with a legibility scrim. */
  backgroundImage: string;
  font: string;
  decoration: string;
  layout: ProfileLayout;
}

export type ProfileLayout = "classic" | "stacked" | "spotlight";

export interface ProfileDraft {
  handle: string;
  displayName: string;
  tagline: string;
  theme: ProfileTheme;
  sections: ProfileSection[];
  published: boolean;
}

export interface PublicProfile {
  handle: string;
  displayName: string;
  tagline: string;
  theme: ProfileTheme;
  sections: ProfileSection[];
  discordId: string;
  updatedAt: string;
}

export const PROFILE_BACKGROUNDS = [
  { id: "aurora", label: "Aurora", light: false },
  { id: "noir", label: "Noir", light: false },
  { id: "grid", label: "Grid", light: false },
  { id: "sunset", label: "Sunset", light: false },
  { id: "paper", label: "Paper", light: true },
  { id: "mint", label: "Mint", light: true },
] as const;

export const PROFILE_LAYOUTS: { id: ProfileLayout; label: string }[] = [
  { id: "classic", label: "Classic" },
  { id: "stacked", label: "Stacked" },
  { id: "spotlight", label: "Spotlight" },
];

export const SECTION_KINDS: { id: SectionKind; label: string; hint: string }[] = [
  { id: "about", label: "About", hint: "A paragraph about you" },
  { id: "links", label: "Links", hint: "Discord, Instagram, Spotify…" },
  { id: "apps", label: "Apps", hint: "Your favourite apps and accounts" },
  { id: "text", label: "Custom text", hint: "Anything else you want to say" },
];

export const ACCENT_SWATCHES = ["#6ee7b7", "#7dd3fc", "#c4b5fd", "#fda4af", "#fcd34d", "#f0abfc", "#94a3b8"];

export const HANDLE_PATTERN = /^[a-z0-9_]{3,24}$/;
const MAX_SECTIONS = 10;
const MAX_ITEMS = 20;
const MAX_BODY = 800;
const MAX_TAGLINE = 120;
const MAX_TITLE = 40;
const MAX_LABEL = 40;
const MAX_URL = 300;

function text(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim().slice(0, max);
}

function id(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[a-z0-9_-]{1,40}$/.test(value) ? value : fallback;
}

function safeUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  const raw = value.trim().slice(0, MAX_URL);
  if (!raw) return "";
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.toString();
  } catch {
    return "";
  }
}

export function isSectionKind(value: unknown): value is SectionKind {
  return value === "about" || value === "links" || value === "apps" || value === "text";
}

export function defaultTitle(kind: SectionKind): string {
  switch (kind) {
    case "about": return "About me";
    case "links": return "My links";
    case "apps": return "My apps";
    default: return "New section";
  }
}

export function newId(prefix = "s"): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

export function emptySection(kind: SectionKind): ProfileSection {
  return {
    id: newId(kind),
    kind,
    title: defaultTitle(kind),
    hidden: false,
    body: "",
    items: [],
  };
}

export function emptyProfile(displayName: string): ProfileDraft {
  const handle = slugify(displayName || "zora user");
  return {
    handle,
    displayName: displayName || "Your name",
    tagline: "Welcome to my world.",
    theme: {
      accent: ACCENT_SWATCHES[0]!,
      background: "aurora",
      backgroundImage: "",
      font: "gothic",
      decoration: DIVIDERS[1]!,
      layout: "classic",
    },
    sections: [emptySection("about"), emptySection("links")],
    published: true,
  };
}

/** Coerces untrusted input into a clean draft, throwing a message people can act on. */
export function readProfileDraft(input: unknown): ProfileDraft {
  const raw = (input ?? {}) as Record<string, unknown>;
  const displayName = text(raw["displayName"], 40);
  if (!displayName) throw new Error("Add a display name.");
  const handle = String(raw["handle"] ?? "").trim().toLowerCase();
  if (!HANDLE_PATTERN.test(handle)) {
    throw new Error("Handles need 3–24 characters: lowercase letters, numbers or underscores.");
  }
  const themeRaw = (raw["theme"] ?? {}) as Record<string, unknown>;
  const accent = typeof themeRaw["accent"] === "string" && /^#[0-9a-fA-F]{6}$/.test(themeRaw["accent"])
    ? themeRaw["accent"].toLowerCase()
    : ACCENT_SWATCHES[0]!;
  const background = PROFILE_BACKGROUNDS.some((option) => option.id === themeRaw["background"])
    ? String(themeRaw["background"])
    : "aurora";
  const backgroundImage = safeUrl(themeRaw["backgroundImage"]);
  const layout = PROFILE_LAYOUTS.some((option) => option.id === themeRaw["layout"])
    ? (themeRaw["layout"] as ProfileLayout)
    : "classic";
  const font = typeof themeRaw["font"] === "string" && FONT_STYLE_IDS.includes(themeRaw["font"]) ? themeRaw["font"] : "";
  const decoration = typeof themeRaw["decoration"] === "string" && DIVIDERS.includes(themeRaw["decoration"])
    ? themeRaw["decoration"]
    : "";

  const sectionsRaw = Array.isArray(raw["sections"]) ? raw["sections"].slice(0, MAX_SECTIONS) : [];
  const sections: ProfileSection[] = [];
  sectionsRaw.forEach((entry, index) => {
    const section = (entry ?? {}) as Record<string, unknown>;
    const kind = isSectionKind(section["kind"]) ? section["kind"] : "text";
    const itemsRaw = Array.isArray(section["items"]) ? section["items"].slice(0, MAX_ITEMS) : [];
    const items: ProfileItem[] = [];
    itemsRaw.forEach((item, itemIndex) => {
      const row = (item ?? {}) as Record<string, unknown>;
      const label = text(row["label"], MAX_LABEL);
      const url = safeUrl(row["url"]);
      if (!label || !url) return;
      items.push({ id: id(row["id"], `i_${index}_${itemIndex}`), label, url });
    });
    sections.push({
      id: id(section["id"], `s_${index}`),
      kind,
      title: text(section["title"], MAX_TITLE) || defaultTitle(kind),
      hidden: section["hidden"] === true,
      body: text(section["body"], MAX_BODY),
      items,
    });
  });

  return {
    handle,
    displayName,
    tagline: text(raw["tagline"], MAX_TAGLINE),
    theme: { accent, background, backgroundImage, font, decoration, layout },
    sections,
    published: raw["published"] !== false,
  };
}
