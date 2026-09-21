/**
 * Shape of a presence draft in this app.
 *
 * Only fields that Discord actually honours for an *embedded Activity* are
 * modelled here. Deliberately absent:
 *   - `name`    : always the Discord application's own name, not settable.
 *   - `buttons` : not supported by the Embedded App SDK (native apps only).
 */

import { PUBLIC_SITE_ORIGIN } from "./site";

export type ActivityTypeValue = 0 | 1 | 2 | 3 | 5;

/**
 * The verb Discord renders above the status, one per activity type.
 *
 * Streaming only applies when the payload also carries a Twitch URL — see
 * STREAMING_URL. Type 4 (Custom) is excluded: the Social SDK's
 * UpdateRichPresence rejects it with "Invalid enum value".
 */
export const ACTIVITY_TYPES: { value: ActivityTypeValue; label: string; verb: string }[] = [
  { value: 0, label: "Playing", verb: "Playing" },
  { value: 1, label: "Streaming", verb: "Streaming" },
  { value: 2, label: "Listening", verb: "Listening to" },
  { value: 3, label: "Watching", verb: "Watching" },
  { value: 5, label: "Competing", verb: "Competing in" },
];

/** Type 1 renders as Streaming only with a Twitch URL attached to the payload. */
export const STREAMING_URL = "https://twitch.tv/discord";

/** Finds the verb for a type value, tolerating types outside this app's list. */
export function verbFor(type: number): string {
  return ACTIVITY_TYPES.find((t) => t.value === type)?.verb ?? "";
}

export type TimestampMode = "none" | "elapsed" | "remaining";

export interface PresenceDraft {
  type: ActivityTypeValue;
  details: string;
  state: string;
  /** Hex colour (#rrggbb) for the studio accent and the generated status artwork. */
  color: string;
  largeImage: string;
  largeText: string;
  smallImage: string;
  smallText: string;
  timestampMode: TimestampMode;
  durationMinutes: number;
  partyCurrent: number;
  partyMax: number;
}

export interface Preset {
  id: string;
  name: string;
  emoji: string;
  accent: string;
  draft: PresenceDraft;
}

const base: PresenceDraft = {
  type: 0,
  details: "",
  state: "",
  color: "",
  largeImage: "",
  largeText: "",
  smallImage: "",
  smallText: "",
  timestampMode: "elapsed",
  durationMinutes: 30,
  partyCurrent: 0,
  partyMax: 0,
};

const make = (
  id: string,
  name: string,
  emoji: string,
  accent: string,
  draft: Partial<PresenceDraft>,
): Preset => ({ id, name, emoji, accent, draft: { ...base, ...draft } });

export const PRESETS: Preset[] = [
  make("music", "Music", "🎵", "oklch(0.78 0.16 145)", {
    type: 2,
    details: "🎵 Listening to Music",
    state: "On repeat, all night",
    largeText: "Now playing",
    smallText: "🎧",
  }),
  make("minecraft", "Minecraft", "⛏️", "oklch(0.72 0.15 145)", {
    type: 0,
    details: "⛏️ Playing Minecraft",
    state: "Mining diamonds",
    largeText: "Hardcore world",
    smallText: "Day 412",
  }),
  make("youtube", "YouTube", "▶️", "oklch(0.65 0.21 25)", {
    type: 3,
    details: "▶️ Watching YouTube",
    state: "Video essays at 2am",
    largeText: "YouTube",
  }),
  make("instagram", "Instagram", "📸", "oklch(0.7 0.19 20)", {
    type: 0,
    details: "📸 Browsing Instagram",
    state: "Deep in the explore page",
    largeText: "Instagram",
  }),
  make("tiktok", "TikTok", "🎶", "oklch(0.75 0.15 200)", {
    type: 0,
    details: "🎶 Scrolling TikTok",
    state: "Just one more video",
    largeText: "TikTok",
  }),
  make("gaming", "Gaming", "🎮", "oklch(0.7 0.18 300)", {
    type: 0,
    details: "🎮 In a ranked match",
    state: "Do not disturb",
    largeText: "Gaming",
    partyCurrent: 3,
    partyMax: 5,
  }),
  make("watching", "Watching", "🍿", "oklch(0.78 0.14 70)", {
    type: 3,
    details: "🍿 Watching a movie",
    state: "No spoilers please",
    durationMinutes: 115,
  }),
  make("listening", "Listening", "🎧", "oklch(0.76 0.13 250)", {
    type: 2,
    details: "🎧 Listening to a podcast",
    state: "Episode 42",
  }),
  make("chilling", "Chilling", "🛋️", "oklch(0.8 0.1 95)", {
    type: 0,
    details: "🛋️ Chilling",
    state: "Away from keyboard",
  }),
  make("custom", "Custom", "✨", "oklch(0.8 0.13 180)", {
    type: 0,
    details: "",
    state: "",
  }),
];

export const emptyDraft = base;

/** Studio accent used when the draft carries no colour of its own. */
export const DEFAULT_ACCENT = "oklch(0.8 0.13 180)";

/**
 * Accepts "4ade80", "#4ADE80" or "#4ad" and returns "#4ade80"; null when the
 * input is not a usable hex colour. Also tolerates a missing value so drafts
 * saved before the colour field existed keep working.
 */
export function normalizeHex(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const digits = match[1]!.toLowerCase();
  return `#${digits.length === 3 ? digits.replace(/./g, (c) => c + c) : digits}`;
}

/**
 * Inline styles that tint the studio with the chosen hex colour.
 *
 * Discord's presence payload has no colour field, so the colour shows up in
 * two places: as the profile artwork (see `swatchPath`) and here, as the
 * dashboard's own background and top glow. Both return `undefined` for an
 * invalid or absent colour so the page falls back to the unthemed look
 * instead of a broken CSS value.
 */
export function studioBackgroundStyle(
  hex: string | null | undefined,
): { backgroundColor: string } | undefined {
  const color = normalizeHex(hex);
  return color
    ? { backgroundColor: `color-mix(in srgb, ${color} 7%, var(--background))` }
    : undefined;
}

export function studioGlowStyle(
  hex: string | null | undefined,
): { opacity: number; background: string } | undefined {
  const color = normalizeHex(hex);
  if (!color) return undefined;
  return {
    opacity: 1,
    background: `radial-gradient(60% 100% at 50% 0%, color-mix(in srgb, ${color} 26%, transparent), transparent 70%)`,
  };
}

/**
 * Public URL of the generated colour swatch.
 *
 * Discord's presence payload has no colour field, so a chosen colour is
 * published as the status artwork instead — an image Discord can fetch, which
 * is what makes the colour visible on the profile.
 */
export function swatchPath(hex: string): string {
  return `/api/public/presence-swatch/${hex.slice(1)}.png`;
}

export function swatchUrl(hex: string): string {
  return `${PUBLIC_SITE_ORIGIN}${swatchPath(hex)}`;
}

/** Builds the exact payload sent to Discord's setActivity command. */
export function buildActivityPayload(draft: PresenceDraft) {
  const activity: Record<string, unknown> = { type: draft.type };

  // Streaming only reads as "Streaming" when the payload carries a Twitch URL;
  // Discord accepts any https URL here, a placeholder is enough to flip the verb.
  if (draft.type === 1 && !activity["url"]) activity["url"] = STREAMING_URL;

  if (draft.details.trim()) activity["details"] = draft.details.trim();
  if (draft.state.trim()) activity["state"] = draft.state.trim();

  const assets: Record<string, string> = {};
  // A picked photo wins; otherwise a chosen colour becomes the artwork.
  const color = normalizeHex(draft.color);
  const largeImage = draft.largeImage.trim() || (color ? swatchUrl(color) : "");
  if (largeImage) assets["large_image"] = largeImage;
  if (draft.largeText.trim()) assets["large_text"] = draft.largeText.trim();
  if (draft.smallImage.trim()) assets["small_image"] = draft.smallImage.trim();
  if (draft.smallText.trim()) assets["small_text"] = draft.smallText.trim();
  if (Object.keys(assets).length > 0) activity["assets"] = assets;

  const now = Date.now();
  if (draft.timestampMode === "elapsed") {
    activity["timestamps"] = { start: now };
  } else if (draft.timestampMode === "remaining") {
    activity["timestamps"] = {
      start: now,
      end: now + Math.max(1, draft.durationMinutes) * 60_000,
    };
  }

  if (draft.partyMax > 0 && draft.partyCurrent > 0) {
    activity["party"] = { size: [draft.partyCurrent, draft.partyMax] };
  }

  return activity;
}
