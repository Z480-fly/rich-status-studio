import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Check, Copy, Sparkles, Star, Trash2, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DIVIDERS, FONT_STYLES, SYMBOLS, decorate, transform, type TextCase } from "@/lib/fonts";

export const Route = createFileRoute("/fonts")({
  head: () => ({
    meta: [
      { title: "Font Studio — Zora" },
      { name: "description", content: "Turn plain text into Unicode fancy lettering, dividers and symbols, then copy it anywhere." },
      { property: "og:title", content: "Zora Font Studio" },
      { property: "og:description", content: "Gothic, cursive, small caps and more — one tap to copy." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: FontStudio,
});

const FAVORITES_KEY = "zora:font-favorites";
const COMBOS_KEY = "zora:font-combos";

interface Combo {
  id: string;
  text: string;
  styleId: string;
  casing: TextCase;
  divider: string;
}

function readList<T>(key: string): T[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function writeList(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode can block storage — the studio still works */
  }
}

const CASES: { id: TextCase; label: string }[] = [
  { id: "as-typed", label: "As typed" },
  { id: "upper", label: "UPPER" },
  { id: "lower", label: "lower" },
];

function FontStudio() {
  const [text, setText] = useState("Dark Academia");
  const [casing, setCasing] = useState<TextCase>("as-typed");
  const [favorites, setFavorites] = useState<string[]>([]);
  const [combos, setCombos] = useState<Combo[]>([]);
  const [copied, setCopied] = useState("");
  const [comboStyle, setComboStyle] = useState("gothic");
  const [comboDivider, setComboDivider] = useState<string>(DIVIDERS[1]!);

  useEffect(() => {
    setFavorites(readList<string>(FAVORITES_KEY));
    setCombos(readList<Combo>(COMBOS_KEY));
  }, []);

  const copy = async (value: string, id: string) => {
    if (!value.trim()) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(id);
    } catch {
      setCopied("");
    }
  };

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(""), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const toggleFavorite = (id: string) => {
    setFavorites((current) => {
      const next = current.includes(id) ? current.filter((item) => item !== id) : [id, ...current];
      writeList(FAVORITES_KEY, next);
      return next;
    });
  };

  const orderedStyles = useMemo(
    () => [...FONT_STYLES].sort((a, b) => Number(favorites.includes(b.id)) - Number(favorites.includes(a.id))),
    [favorites],
  );

  const comboPreview = useMemo(
    () => decorate(transform(text, comboStyle, casing), comboDivider),
    [text, comboStyle, casing, comboDivider],
  );

  const saveCombo = () => {
    if (!text.trim()) return;
    const combo: Combo = { id: Math.random().toString(36).slice(2, 9), text: text.trim().slice(0, 200), styleId: comboStyle, casing, divider: comboDivider };
    setCombos((current) => {
      const next = [combo, ...current].slice(0, 12);
      writeList(COMBOS_KEY, next);
      return next;
    });
  };

  const removeCombo = (id: string) => {
    setCombos((current) => {
      const next = current.filter((combo) => combo.id !== id);
      writeList(COMBOS_KEY, next);
      return next;
    });
  };

  return (
    <main className="safe-area-shell mx-auto min-h-screen max-w-5xl px-4 sm:px-8">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-5">
        <Link to="/" className="font-display text-xl font-semibold">𝒁𝒐𝒓𝒂 𝑺𝒕𝒖𝒅𝒊𝒐 <span className="text-primary">✦</span></Link>
        <nav className="flex items-center gap-2">
          <Button variant="ghost" asChild><Link to="/profile"><Sparkles />My profile</Link></Button>
          <Button variant="ghost" asChild><Link to="/">Studio</Link></Button>
        </nav>
      </header>

      <section className="py-8">
        <p className="text-xs font-semibold uppercase tracking-[0.25em] text-primary">Font Studio</p>
        <h1 className="mt-2 text-3xl font-bold sm:text-4xl">Fancy text, no install</h1>
        <p className="mt-2 max-w-xl text-sm text-muted-foreground">
          These are Unicode characters, not fonts — so they paste into Discord, bios, captions and anywhere else.
          Type once, copy anywhere.
        </p>
      </section>

      <section className="panel p-5 sm:p-6">
        <label htmlFor="font-input" className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">Your text</label>
        <textarea
          id="font-input"
          className="field mt-2 min-h-24 resize-y focus:field-focus"
          value={text}
          maxLength={200}
          rows={2}
          onChange={(event) => setText(event.target.value)}
          placeholder="Type something to style…"
        />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {CASES.map((option) => (
            <Button key={option.id} size="sm" variant={casing === option.id ? "default" : "outline"} onClick={() => setCasing(option.id)}>
              {option.label}
            </Button>
          ))}
          <span className="ml-auto text-xs text-muted-foreground">{text.length}/200</span>
        </div>
      </section>

      <section className="mt-6" aria-label="Styles">
        <div className="flex items-end justify-between gap-3">
          <h2 className="text-xl font-semibold">Styles</h2>
          <p className="text-xs text-muted-foreground">Tap a star to pin a style</p>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {orderedStyles.map((style) => {
            const value = transform(text, style.id, casing);
            const id = `style-${style.id}`;
            return (
              <div key={style.id} className="panel flex flex-col gap-3 p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold uppercase tracking-[0.15em] text-muted-foreground">{style.label}</span>
                  <div className="flex items-center gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={favorites.includes(style.id) ? `Unpin ${style.label}` : `Pin ${style.label}`}
                      title={favorites.includes(style.id) ? "Unpin" : "Pin to top"}
                      onClick={() => toggleFavorite(style.id)}
                    >
                      <Star className={favorites.includes(style.id) ? "fill-primary text-primary" : ""} />
                    </Button>
                    <Button size="icon" variant="ghost" aria-label={`Copy ${style.label}`} title="Copy" onClick={() => void copy(value, id)}>
                      {copied === id ? <Check className="text-primary" /> : <Copy />}
                    </Button>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void copy(value, id)}
                  className="min-h-10 break-words rounded-lg bg-secondary/60 px-3 py-2 text-left text-lg leading-relaxed transition-colors hover:bg-secondary"
                >
                  {value || style.convert(style.sample)}
                </button>
              </div>
            );
          })}
        </div>
      </section>

      <section className="mt-8 panel p-5 sm:p-6" aria-label="Combination builder">
        <div className="flex items-center gap-2">
          <Wand2 className="size-4 text-primary" />
          <h2 className="text-xl font-semibold">Combinations</h2>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">Wrap your text in a divider and save it for later.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="text-xs font-semibold uppercase tracking-[0.15em] text-muted-foreground">Style</span>
            <select className="field mt-2 focus:field-focus" value={comboStyle} onChange={(event) => setComboStyle(event.target.value)}>
              {FONT_STYLES.map((style) => <option key={style.id} value={style.id}>{style.label}</option>)}
            </select>
          </label>
          <label className="text-sm">
            <span className="text-xs font-semibold uppercase tracking-[0.15em] text-muted-foreground">Divider</span>
            <select className="field mt-2 focus:field-focus" value={comboDivider} onChange={(event) => setComboDivider(event.target.value)}>
              {DIVIDERS.map((divider) => <option key={divider} value={divider}>{divider}</option>)}
            </select>
          </label>
        </div>
        <pre className="mt-4 whitespace-pre-wrap break-words rounded-lg bg-secondary/60 p-4 text-sm">{comboPreview || "Type something above."}</pre>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button onClick={() => void copy(comboPreview, "combo-preview")} disabled={!comboPreview}>
            {copied === "combo-preview" ? <Check /> : <Copy />}Copy combination
          </Button>
          <Button variant="outline" onClick={saveCombo} disabled={!text.trim()}>Save combination</Button>
        </div>
        {combos.length > 0 && (
          <ul className="mt-5 flex flex-col gap-2">
            {combos.map((combo) => {
              const value = decorate(transform(combo.text, combo.styleId, combo.casing), combo.divider);
              return (
                <li key={combo.id} className="flex items-start gap-2 rounded-lg border border-border p-3">
                  <pre className="min-w-0 flex-1 whitespace-pre-wrap break-words text-xs">{value}</pre>
                  <Button size="icon" variant="ghost" aria-label="Copy saved combination" onClick={() => void copy(value, `combo-${combo.id}`)}>
                    {copied === `combo-${combo.id}` ? <Check className="text-primary" /> : <Copy />}
                  </Button>
                  <Button size="icon" variant="ghost" aria-label="Delete saved combination" onClick={() => removeCombo(combo.id)}>
                    <Trash2 />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="mt-8" aria-label="Dividers and symbols">
        <h2 className="text-xl font-semibold">Dividers</h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {DIVIDERS.map((divider) => (
            <button
              key={divider}
              type="button"
              onClick={() => void copy(divider, `divider-${divider}`)}
              className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-left text-sm transition-colors hover:bg-secondary"
            >
              <span className="truncate">{divider}</span>
              {copied === `divider-${divider}` ? <Check className="size-3.5 text-primary" /> : <Copy className="size-3.5 opacity-50" />}
            </button>
          ))}
        </div>
        <h2 className="mt-6 text-xl font-semibold">Symbols</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          {SYMBOLS.map((symbol) => (
            <button
              key={symbol}
              type="button"
              onClick={() => void copy(symbol, `symbol-${symbol}`)}
              className="flex size-10 items-center justify-center rounded-lg border border-border text-lg transition-colors hover:bg-secondary"
              aria-label={`Copy ${symbol}`}
            >
              {copied === `symbol-${symbol}` ? <Check className="size-4 text-primary" /> : symbol}
            </button>
          ))}
        </div>
      </section>

      <section className="panel mt-8 flex flex-wrap items-center justify-between gap-3 p-5">
        <div>
          <h2 className="font-semibold">Want this on a profile page?</h2>
          <p className="text-sm text-muted-foreground">Pick a font style in the builder and your whole profile uses it.</p>
        </div>
        <Button asChild><Link to="/profile">Build my profile</Link></Button>
      </section>
    </main>
  );
}
