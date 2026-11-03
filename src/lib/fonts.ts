/**
 * Zora Font Studio engine.
 *
 * "Fancy fonts" are not installed typefaces — they are Unicode characters that
 * look like a different alphabet, which is why they paste into almost any app.
 * Every style here is a pure `string -> string` transform, so it works on the
 * server (profile rendering) and in the browser (live preview) alike.
 */

export type TextCase = "as-typed" | "upper" | "lower";

export interface FontStyle {
  id: string;
  label: string;
  sample: string;
  convert: (text: string) => string;
}

/** Character range of a mathematical alphanumeric style. */
interface Block {
  upper: number;
  lower: number;
  digits?: number;
}

/** Builds a converter that shifts A-Z, a-z (and optionally 0-9) into a block. */
function block(style: Block): (text: string) => string {
  return (text) =>
    Array.from(text)
      .map((char) => {
        const code = char.codePointAt(0) ?? 0;
        if (code >= 65 && code <= 90) return String.fromCodePoint(style.upper + code - 65);
        if (code >= 97 && code <= 122) return String.fromCodePoint(style.lower + code - 97);
        if (style.digits && code >= 48 && code <= 57) return String.fromCodePoint(style.digits + code - 48);
        return char;
      })
      .join("");
}

/**
 * Some mathematical styles have no code point for a few letters: the block
 * leaves a reserved slot and Unicode points at a look-alike symbol instead
 * (ℬ, ℭ, ℯ, ℎ …). Overrides are keyed by the *source* character so those slots
 * are skipped rather than rendered as a blank glyph.
 */
function withOverrides(style: Block, overrides: Record<string, string>) {
  const base = block(style);
  return (text: string) => Array.from(text).map((char) => overrides[char] ?? base(char)).join("");
}

function perCharacter(map: Record<string, string>) {
  return (text: string) => Array.from(text).map((char) => map[char] ?? char).join("");
}

const SCRIPT_OVERRIDES = { B: "ℬ", E: "ℰ", F: "ℱ", H: "ℋ", I: "ℐ", L: "ℒ", M: "ℳ", R: "ℛ", e: "ℯ", g: "ℊ", o: "ℴ" };
const FRAKTUR_OVERRIDES = { C: "ℭ", H: "ℌ", I: "ℑ", R: "ℜ", Z: "ℨ" };
const DOUBLE_STRUCK_OVERRIDES = { C: "ℂ", H: "ℍ", N: "ℕ", P: "ℙ", Q: "ℚ", R: "ℝ", Z: "ℤ" };
const ITALIC_OVERRIDES = { h: "ℎ" };

const SMALL_CAPS: Record<string, string> = {
  a: "ᴀ", b: "ʙ", c: "ᴄ", d: "ᴅ", e: "ᴇ", f: "ꜰ", g: "ɢ", h: "ʜ", i: "ɪ", j: "ᴊ",
  k: "ᴋ", l: "ʟ", m: "ᴍ", n: "ɴ", o: "ᴏ", p: "ᴘ", q: "ǫ", r: "ʀ", s: "ꜱ", t: "ᴛ",
  u: "ᴜ", v: "ᴠ", w: "ᴡ", x: "x", y: "ʏ", z: "ᴢ",
};

const UPSIDE_DOWN: Record<string, string> = {
  a: "ɐ", b: "q", c: "ɔ", d: "p", e: "ǝ", f: "ɟ", g: "ƃ", h: "ɥ", i: "ᴉ", j: "ɾ",
  k: "ʞ", l: "l", m: "ɯ", n: "u", o: "o", p: "d", q: "b", r: "ɹ", s: "s", t: "ʇ",
  u: "n", v: "ʌ", w: "ʍ", x: "x", y: "ʎ", z: "z", ".": "˙", ",": "'", "'": ",", "?": "¿",
  "!": "¡", "(": ")", ")": "(", "[": "]", "]": "[", "{": "}", "}": "{", "<": ">", ">": "<",
};

const upsideDown = perCharacter(UPSIDE_DOWN);

/** Adds a combining mark to every visible character, the way strikethrough text works. */
function combining(mark: string) {
  return (text: string) =>
    Array.from(text)
      .map((char) => (char === "\n" || char === " " ? char : char + mark))
      .join("");
}

export const FONT_STYLES: FontStyle[] = [
  {
    id: "gothic",
    label: "Gothic",
    sample: "Dark Academia",
    convert: block({ upper: 0x1d56c, lower: 0x1d586 }),
  },
  {
    id: "fraktur",
    label: "Fraktur",
    sample: "Dark Academia",
    convert: withOverrides({ upper: 0x1d504, lower: 0x1d51e }, FRAKTUR_OVERRIDES),
  },
  {
    id: "cursive",
    label: "Cursive",
    sample: "Dark Academia",
    convert: block({ upper: 0x1d4d0, lower: 0x1d4ea }),
  },
  {
    id: "script",
    label: "Script",
    sample: "Dark Academia",
    convert: withOverrides({ upper: 0x1d49c, lower: 0x1d4b6 }, SCRIPT_OVERRIDES),
  },
  {
    id: "bold",
    label: "Bold",
    sample: "Dark Academia",
    convert: block({ upper: 0x1d400, lower: 0x1d41a, digits: 0x1d7ce }),
  },
  {
    id: "italic",
    label: "Italic",
    sample: "Dark Academia",
    convert: withOverrides({ upper: 0x1d434, lower: 0x1d44e }, ITALIC_OVERRIDES),
  },
  {
    id: "bold-italic",
    label: "Bold Italic",
    sample: "Dark Academia",
    convert: block({ upper: 0x1d468, lower: 0x1d482 }),
  },
  {
    id: "double-struck",
    label: "Double-struck",
    sample: "Dark Academia",
    convert: withOverrides({ upper: 0x1d538, lower: 0x1d552, digits: 0x1d7d8 }, DOUBLE_STRUCK_OVERRIDES),
  },
  {
    id: "sans",
    label: "Sans",
    sample: "Dark Academia",
    convert: block({ upper: 0x1d5a0, lower: 0x1d5ba }),
  },
  {
    id: "sans-bold",
    label: "Sans Bold",
    sample: "Dark Academia",
    convert: block({ upper: 0x1d5d4, lower: 0x1d5ee }),
  },
  {
    id: "sans-italic",
    label: "Sans Italic",
    sample: "Dark Academia",
    convert: block({ upper: 0x1d608, lower: 0x1d622 }),
  },
  {
    id: "monospace",
    label: "Monospace",
    sample: "Dark Academia",
    convert: block({ upper: 0x1d670, lower: 0x1d68a, digits: 0x1d7f6 }),
  },
  {
    id: "small-caps",
    label: "Small Caps",
    sample: "Dark Academia",
    convert: (text) => perCharacter(SMALL_CAPS)(text.toLowerCase()),
  },
  {
    id: "fullwidth",
    label: "Fullwidth",
    sample: "Dark Academia",
    convert: block({ upper: 0xff21, lower: 0xff41, digits: 0xff10 }),
  },
  {
    id: "circled",
    label: "Circled",
    sample: "Dark Academia",
    convert: (text) =>
      Array.from(text)
        .map((char) => {
          const code = char.codePointAt(0) ?? 0;
          if (code >= 65 && code <= 90) return String.fromCodePoint(0x24b6 + code - 65);
          if (code >= 97 && code <= 122) return String.fromCodePoint(0x24d0 + code - 97);
          if (code === 48) return "⓪";
          if (code >= 49 && code <= 57) return String.fromCodePoint(0x2460 + code - 49);
          return char;
        })
        .join(""),
  },
  {
    id: "squared",
    label: "Squared",
    sample: "Dark Academia",
    convert: (text) =>
      Array.from(text.toUpperCase())
        .map((char) => {
          const code = char.codePointAt(0) ?? 0;
          if (code >= 65 && code <= 90) return String.fromCodePoint(0x1f130 + code - 65);
          return char;
        })
        .join(""),
  },
  {
    id: "negative-circled",
    label: "Negative Circled",
    sample: "Dark Academia",
    convert: (text) =>
      Array.from(text.toUpperCase())
        .map((char) => {
          const code = char.codePointAt(0) ?? 0;
          if (code >= 65 && code <= 90) return String.fromCodePoint(0x1f150 + code - 65);
          return char;
        })
        .join(""),
  },
  {
    id: "negative-squared",
    label: "Negative Squared",
    sample: "Dark Academia",
    convert: (text) =>
      Array.from(text.toUpperCase())
        .map((char) => {
          const code = char.codePointAt(0) ?? 0;
          if (code >= 65 && code <= 90) return String.fromCodePoint(0x1f170 + code - 65);
          return char;
        })
        .join(""),
  },
  {
    id: "strikethrough",
    label: "Strikethrough",
    sample: "Dark Academia",
    convert: combining("\u0336"),
  },
  {
    id: "underline",
    label: "Underline",
    sample: "Dark Academia",
    convert: combining("\u0332"),
  },
  {
    id: "upside-down",
    label: "Upside Down",
    sample: "Dark Academia",
    convert: (text) => Array.from(upsideDown(text)).reverse().join(""),
  },
];

export const FONT_STYLE_IDS = FONT_STYLES.map((style) => style.id);

export function fontStyle(id: string | undefined): FontStyle | undefined {
  return FONT_STYLES.find((style) => style.id === id);
}

/** Applies a case option then a style, so "small caps" of typed text is predictable. */
export function transform(text: string, styleId: string | undefined, casing: TextCase = "as-typed"): string {
  const applyCase =
    casing === "upper" ? (value: string) => value.toUpperCase()
      : casing === "lower" ? (value: string) => value.toLowerCase()
        : (value: string) => value;
  const style = fontStyle(styleId);
  return style ? style.convert(applyCase(text)) : applyCase(text);
}

/** Decorative dividers people can copy straight into a status or profile. */
export const DIVIDERS: string[] = [
  "╭──────────────╮",
  "✦ ───────── ✦",
  "⋆｡°✩°｡⋆",
  "⋆⋅☆⋅⋆",
  "༺☆༻",
  "⊹₊ ⋆ ⋆ ₊⊹",
  "─── ⋆⋅☆⋅⋆ ───",
  "☾ ⋆*･ﾟ:⋆*･ﾟ",
  "✧･ﾟ: *✧･ﾟ:*",
  "₊˚⊹♡",
  "➳➳➳",
  "⌁⌁⌁⌁⌁",
  "▸▸▸",
  "◈ ◈ ◈",
  "•──────•°•❀•°•──────•",
  "𝔡𝔦𝔳𝔦𝔡𝔢𝔯",
];

/** Standalone symbols for decorating text. */
export const SYMBOLS: string[] = [
  "✦", "✧", "✩", "✮", "✵", "✶", "❀", "❥", "☾", "☽", "♡", "♰", "⚔", "⛧",
  "☠", "✞", "✟", "⚜", "🕸", "🖤", "🦋", "🌙", "🕯", "⚡", "☕", "🎧", "💿", "🖋",
];

/** Wraps text in a chosen divider, giving people ready-made "combinations". */
export function decorate(text: string, divider: string | undefined): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return divider ? `${divider}\n${trimmed}\n${divider}` : trimmed;
}

/** Suggests a URL-safe handle from a Discord name. */
export function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
  return slug.length >= 3 ? slug : `zora_${slug}`.slice(0, 24).replace(/_+$/, "") || "zora_user";
}
