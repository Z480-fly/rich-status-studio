import { createServerFn } from "@tanstack/react-start";

export interface UrlMetadata {
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  service: string;
  originalUrl: string;
}

function extractOgTags(html: string): {
  title: string | null;
  image: string | null;
  desc: string | null;
} {
  const pick = (prop: string): string | null => {
    const m = html.match(
      new RegExp(`<meta[^>]*(?:property|name)="${prop}"[^>]*content="([^"]*)"`, "i"),
    );
    return m?.[1] ?? null;
  };
  return {
    title: pick("og:title") ?? html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? null,
    image: pick("og:image"),
    desc: pick("og:description"),
  };
}

function deriveService(url: string, title: string | null): string {
  const host = new URL(url).hostname.replace("www.", "");
  if (host.includes("youtube.com") || host === "youtu.be") return "YouTube";
  if (host.includes("spotify.com")) return "Spotify";
  if (host.includes("tiktok.com")) return "TikTok";
  if (host.includes("instagram.com")) return "Instagram";
  if (host.includes("twitch.tv")) return "Twitch";
  return title ? host : "web";
}

async function extractYouTube(url: string): Promise<UrlMetadata> {
  const oembed = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
  const res = await fetch(oembed, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error("YouTube oEmbed failed");
  const d = (await res.json()) as { title?: string; author_name?: string; thumbnail_url?: string };
  return {
    title: d.title ?? null,
    description: d.author_name ?? null,
    imageUrl: d.thumbnail_url ?? null,
    service: "YouTube",
    originalUrl: url,
  };
}

async function extractSpotify(url: string): Promise<UrlMetadata> {
  const oembed = `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`;
  const res = await fetch(oembed, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error("Spotify oEmbed failed");
  const d = (await res.json()) as { title?: string; thumbnail_url?: string };
  return {
    title: d.title ?? null,
    description: null,
    imageUrl: d.thumbnail_url ?? null,
    service: "Spotify",
    originalUrl: url,
  };
}

async function extractGeneric(url: string): Promise<UrlMetadata> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(6000),
    headers: { "User-Agent": "Mozilla/5.0 (compatible; ZoraBot/1.0)" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const og = extractOgTags(html);
  return {
    title: og.title,
    description: og.desc,
    imageUrl: og.image,
    service: deriveService(url, og.title),
    originalUrl: url,
  };
}

/**
 * Extracts metadata from a URL. YouTube and Spotify use oEmbed (free, no key);
 * everything else falls back to Open Graph tags in the page HTML.
 *
 * The caller maps the result into the existing PresenceDraft — nothing is
 * locked or overridden automatically.
 */
export const extractUrlMetadata = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const data = input as { url?: unknown };
    if (typeof data?.url !== "string" || !data.url.trim()) throw new Error("Paste a URL first.");
    let parsed: URL;
    try {
      parsed = new URL(data.url.trim());
    } catch {
      throw new Error("That doesn't look like a valid URL.");
    }
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Only https URLs work.");
    return { url: parsed.href };
  })
  .handler(async ({ data }): Promise<UrlMetadata> => {
    const host = new URL(data.url).hostname.replace("www.", "");
    try {
      if (host.includes("youtube.com") || host === "youtu.be")
        return await extractYouTube(data.url);
      if (host.includes("spotify.com")) return await extractSpotify(data.url);
      return await extractGeneric(data.url);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Couldn't read that page: ${msg}`);
    }
  });
