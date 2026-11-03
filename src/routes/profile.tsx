import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  Eye,
  EyeOff,
  Loader2,
  Palette,
  Plus,
  RefreshCw,
  Save,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ProfileView } from "@/components/ProfileView";
import {
  ACCENT_SWATCHES,
  PROFILE_BACKGROUNDS,
  PROFILE_LAYOUTS,
  SECTION_KINDS,
  emptyProfile,
  emptySection,
  newId,
  type ProfileDraft,
  type ProfileItem,
  type ProfileSection,
  type ProfileTheme,
  type SectionKind,
} from "@/lib/profiles.schema";
import { DIVIDERS, FONT_STYLES } from "@/lib/fonts";
import { getMyProfile, saveMyProfile } from "@/lib/profiles.functions";
import { connectToDiscord, getAccessToken, isInsideDiscord, subscribeConnection } from "@/lib/discord-client";
import { getDiscordLinkUrl } from "@/lib/server-presence.functions";

export const Route = createFileRoute("/profile")({
  head: () => ({
    meta: [
      { title: "Profile builder — Zora" },
      { name: "description", content: "Build a profile page that looks like you: colours, fonts, links, apps and custom sections." },
      { property: "og:title", content: "Zora profile builder" },
      { property: "og:description", content: "One page, your corner of the internet." },
      { property: "og:type", content: "website" },
    ],
  }),
  component: ProfileBuilder,
});

type Status = { kind: "idle" | "saving" | "ok" | "error"; message: string };

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block text-sm">
      <span className="text-xs font-semibold uppercase tracking-[0.15em] text-muted-foreground">{label}</span>
      <div className="mt-2">{children}</div>
      {hint && <span className="mt-1 block text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

function ProfileBuilder() {
  const [token, setToken] = useState<string | undefined>();
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle", message: "" });
  const [tab, setTab] = useState<"edit" | "preview">("edit");
  const [copied, setCopied] = useState(false);
  const initialized = useRef(false);

  const myFn = useServerFn(getMyProfile);
  const saveFn = useServerFn(saveMyProfile);
  const linkFn = useServerFn(getDiscordLinkUrl);

  useEffect(() => {
    setToken(getAccessToken() ?? undefined);
    return subscribeConnection(() => setToken(getAccessToken() ?? undefined));
  }, []);

  const mine = useQuery({
    queryKey: ["profile", "me", token],
    queryFn: () => myFn({ data: token ? { accessToken: token } : {} }),
    retry: false,
  });

  useEffect(() => {
    if (!mine.data?.profile || initialized.current) return;
    initialized.current = true;
    setDraft(mine.data.profile);
  }, [mine.data]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const publicUrl = draft ? `${typeof window === "undefined" ? "" : window.location.origin}/u/${draft.handle}` : "";

  const patch = (value: Partial<ProfileDraft>) => setDraft((current) => (current ? { ...current, ...value } : current));
  const patchTheme = (value: Partial<ProfileTheme>) =>
    setDraft((current) => (current ? { ...current, theme: { ...current.theme, ...value } } : current));
  const patchSection = (id: string, value: Partial<ProfileSection>) =>
    setDraft((current) =>
      current ? { ...current, sections: current.sections.map((section) => (section.id === id ? { ...section, ...value } : section)) } : current,
    );
  const moveSection = (id: string, delta: number) =>
    setDraft((current) => {
      if (!current) return current;
      const index = current.sections.findIndex((section) => section.id === id);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= current.sections.length) return current;
      const sections = [...current.sections];
      const [moved] = sections.splice(index, 1);
      sections.splice(target, 0, moved!);
      return { ...current, sections };
    });
  const removeSection = (id: string) =>
    setDraft((current) => (current ? { ...current, sections: current.sections.filter((section) => section.id !== id) } : current));
  const addSection = (kind: SectionKind) =>
    setDraft((current) => (current ? { ...current, sections: [...current.sections, emptySection(kind)].slice(0, 10) } : current));
  const patchItem = (sectionId: string, itemId: string, value: Partial<ProfileItem>) =>
    patchSection(sectionId, {
      items: (draft?.sections.find((section) => section.id === sectionId)?.items ?? []).map((item) =>
        item.id === itemId ? { ...item, ...value } : item,
      ),
    });
  const addItem = (sectionId: string) => {
    const section = draft?.sections.find((entry) => entry.id === sectionId);
    if (!section || section.items.length >= 20) return;
    patchSection(sectionId, { items: [...section.items, { id: newId("i"), label: "", url: "" }] });
  };
  const removeItem = (sectionId: string, itemId: string) => {
    const section = draft?.sections.find((entry) => entry.id === sectionId);
    if (!section) return;
    patchSection(sectionId, { items: section.items.filter((item) => item.id !== itemId) });
  };

  const save = async () => {
    if (!draft) return;
    setStatus({ kind: "saving", message: "" });
    try {
      const result = await saveFn({ data: { profile: draft, ...(token ? { accessToken: token } : {}) } });
      setDraft(result.profile);
      setStatus({ kind: "ok", message: "Profile saved. Your link is live." });
    } catch (value) {
      setStatus({ kind: "error", message: value instanceof Error ? value.message : "Could not save your profile." });
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(publicUrl);
      setCopied(true);
    } catch {
      setStatus({ kind: "error", message: "Could not copy the link — select it from the address bar instead." });
    }
  };

  const connect = async () => {
    try {
      if (isInsideDiscord()) {
        await connectToDiscord();
        setToken(getAccessToken() ?? undefined);
        await mine.refetch();
      } else {
        const { url } = await linkFn();
        window.location.assign(url);
      }
    } catch (value) {
      setStatus({ kind: "error", message: value instanceof Error ? value.message : "Could not start Discord linking." });
    }
  };

  // A failed request is not the same as an unlinked account: only a null viewer means "link".
  const needsLink = mine.data?.viewer === null;
  const failed = mine.isError;
  const setupPending = failed && /profiles storage is not set up/i.test(mine.error?.message ?? "");
  const loading = mine.isPending || (!draft && !needsLink && !failed);

  return (
    <main className="safe-area-shell mx-auto min-h-screen max-w-7xl px-4 sm:px-8">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-5">
        <Link to="/" className="font-display text-xl font-semibold">𝒁𝒐𝒓𝒂 𝑺𝒕𝒖𝒅𝒊𝒐 <span className="text-primary">✦</span></Link>
        <nav className="flex items-center gap-2">
          <Button variant="ghost" asChild><Link to="/fonts"><Palette />Font Studio</Link></Button>
          <Button variant="ghost" asChild><Link to="/inbox">Inbox</Link></Button>
        </nav>
      </header>

      <div className="flex flex-wrap items-end justify-between gap-4 py-7">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-primary">Profile builder</p>
          <h1 className="mt-2 text-3xl font-bold sm:text-4xl">Your corner of the internet</h1>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            Colours, fonts, decorations, links and sections — arrange it once and share one link.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" className="lg:hidden" onClick={() => setTab(tab === "edit" ? "preview" : "edit")}>
            {tab === "edit" ? <Eye /> : <Palette />}{tab === "edit" ? "Preview" : "Edit"}
          </Button>
          {draft && (
            <Button size="sm" variant="outline" onClick={() => void copyLink()}>
              {copied ? <Check /> : <Copy />}{copied ? "Link copied" : "Copy link"}
            </Button>
          )}
          <Button size="sm" onClick={() => void save()} disabled={!draft || status.kind === "saving"}>
            {status.kind === "saving" ? <Loader2 className="animate-spin" /> : <Save />}Save profile
          </Button>
        </div>
      </div>

      {status.message && (
        <p role="status" className={`mb-4 text-sm ${status.kind === "error" ? "text-destructive" : "text-primary"}`}>{status.message}</p>
      )}

      {failed ? (
        <div className={`panel flex flex-col items-center gap-4 p-10 text-center ${setupPending ? "border-amber-500/40 bg-amber-500/5" : ""}`}>
          <Palette className={`size-10 ${setupPending ? "text-amber-400" : "text-primary"}`} />
          <h2 className="text-xl font-semibold">
            {setupPending ? "Profiles storage is still being set up" : "Couldn't open your profile"}
          </h2>
          <p className="max-w-md text-sm text-muted-foreground">
            {setupPending
              ? "Your Discord account is linked. The builder only needs the profiles table created in Supabase — the pending migration hasn't been applied yet."
              : "Your Discord account is linked, but loading the profile failed. Try again in a moment."}
          </p>
          <p className="max-w-md break-words text-xs text-muted-foreground">{mine.error?.message}</p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button onClick={() => void mine.refetch()} disabled={mine.isFetching}>
              {mine.isFetching ? <Loader2 className="animate-spin" /> : <RefreshCw />}Try again
            </Button>
            <Button variant="ghost" onClick={() => void connect()}>Re-link Discord</Button>
          </div>
        </div>
      ) : needsLink ? (
        <div className="panel flex flex-col items-center gap-4 p-10 text-center">
          <Palette className="size-10 text-primary" />
          <h2 className="text-xl font-semibold">Link Discord to build your profile</h2>
          <p className="max-w-sm text-sm text-muted-foreground">
            Your Discord account is your Zora identity — it names your profile and keeps the link yours.
          </p>
          <Button onClick={() => void connect()}>Link Discord account</Button>
        </div>
      ) : loading ? (
        <p className="py-20 text-center text-muted-foreground">Opening your builder…</p>
      ) : draft ? (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(360px,440px)]">
          <div className={`${tab === "preview" ? "hidden lg:block" : "block"} min-w-0`}>
            <section className="panel p-5">
              <h2 className="text-lg font-semibold">Identity</h2>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Field label="Display name">
                  <input className="field focus:field-focus" value={draft.displayName} maxLength={40} onChange={(event) => patch({ displayName: event.target.value })} />
                </Field>
                <Field label="Handle" hint={`Your page: /u/${draft.handle || "…"}`}>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">/u/</span>
                    <input
                      className="field focus:field-focus"
                      value={draft.handle}
                      maxLength={24}
                      onChange={(event) => patch({ handle: event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "") })}
                    />
                  </div>
                </Field>
              </div>
              <div className="mt-4">
                <Field label="Tagline" hint="A short line under your name.">
                  <input className="field focus:field-focus" value={draft.tagline} maxLength={120} onChange={(event) => patch({ tagline: event.target.value })} placeholder="𝕎𝕖𝕝𝕔𝕠𝕞𝕖 𝕥𝕠 𝕞𝕪 𝕨𝕠𝕣𝕝𝕕." />
                </Field>
              </div>
              <div className="mt-5 flex items-center justify-between rounded-lg border border-border p-3">
                <div>
                  <p className="text-sm font-medium">Published</p>
                  <p className="text-xs text-muted-foreground">Off means only you can open the link.</p>
                </div>
                <Switch checked={draft.published} onCheckedChange={(checked) => patch({ published: checked })} />
              </div>
            </section>

            <section className="panel mt-5 p-5">
              <h2 className="text-lg font-semibold">Look &amp; feel</h2>
              <div className="mt-4">
                <Field label="Accent colour">
                  <div className="flex flex-wrap items-center gap-2">
                    {ACCENT_SWATCHES.map((swatch) => (
                      <button
                        key={swatch}
                        type="button"
                        aria-label={`Accent ${swatch}`}
                        aria-pressed={draft.theme.accent === swatch}
                        onClick={() => patchTheme({ accent: swatch })}
                        className={`size-8 rounded-full border-2 transition-transform hover:scale-110 ${draft.theme.accent === swatch ? "border-foreground" : "border-transparent"}`}
                        style={{ background: swatch }}
                      />
                    ))}
                    <input
                      type="color"
                      aria-label="Custom accent colour"
                      value={draft.theme.accent}
                      onChange={(event) => patchTheme({ accent: event.target.value })}
                      className="size-8 cursor-pointer rounded-full border border-border bg-transparent"
                    />
                  </div>
                </Field>
              </div>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Field label="Background">
                  <select className="field focus:field-focus" value={draft.theme.background} onChange={(event) => patchTheme({ background: event.target.value })}>
                    {PROFILE_BACKGROUNDS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                  </select>
                </Field>
                <Field label="Layout">
                  <select className="field focus:field-focus" value={draft.theme.layout} onChange={(event) => patchTheme({ layout: event.target.value as ProfileTheme["layout"] })}>
                    {PROFILE_LAYOUTS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                  </select>
                </Field>
                <Field label="Font style" hint="Unicode lettering, so it looks the same everywhere.">
                  <select className="field focus:field-focus" value={draft.theme.font} onChange={(event) => patchTheme({ font: event.target.value })}>
                    <option value="">Plain</option>
                    {FONT_STYLES.map((style) => <option key={style.id} value={style.id}>{style.label}</option>)}
                  </select>
                </Field>
                <Field label="Decoration">
                  <select className="field focus:field-focus" value={draft.theme.decoration} onChange={(event) => patchTheme({ decoration: event.target.value })}>
                    <option value="">None</option>
                    {DIVIDERS.map((divider) => <option key={divider} value={divider}>{divider}</option>)}
                  </select>
                </Field>
              </div>
              <div className="mt-4">
                <Field label="Background image" hint="Paste an image link (https://…). It is covered by a dark scrim so text stays readable.">
                  <input
                    className="field focus:field-focus"
                    type="url"
                    inputMode="url"
                    placeholder="https://images.unsplash.com/…"
                    value={draft.theme.backgroundImage}
                    maxLength={300}
                    onChange={(event) => patchTheme({ backgroundImage: event.target.value })}
                  />
                </Field>
              </div>
            </section>

            <section className="mt-5">
              <div className="flex items-end justify-between gap-3">
                <h2 className="text-lg font-semibold">Sections</h2>
                <p className="text-xs text-muted-foreground">Reorder, hide or remove anything</p>
              </div>
              <div className="mt-3 flex flex-col gap-3">
                {draft.sections.map((section, index) => (
                  <article key={section.id} className={`panel p-4 ${section.hidden ? "opacity-70" : ""}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {SECTION_KINDS.find((kind) => kind.id === section.kind)?.label ?? "Section"}
                      </span>
                      <input
                        className="field h-9 min-w-0 flex-1 focus:field-focus"
                        aria-label="Section title"
                        value={section.title}
                        maxLength={40}
                        onChange={(event) => patchSection(section.id, { title: event.target.value })}
                      />
                      <div className="flex items-center gap-1">
                        <Button size="icon" variant="ghost" aria-label="Move section up" disabled={index === 0} onClick={() => moveSection(section.id, -1)}><ArrowUp /></Button>
                        <Button size="icon" variant="ghost" aria-label="Move section down" disabled={index === draft.sections.length - 1} onClick={() => moveSection(section.id, 1)}><ArrowDown /></Button>
                        <Button size="icon" variant="ghost" aria-label={section.hidden ? "Show section" : "Hide section"} onClick={() => patchSection(section.id, { hidden: !section.hidden })}>
                          {section.hidden ? <EyeOff /> : <Eye />}
                        </Button>
                        <Button size="icon" variant="ghost" aria-label="Delete section" onClick={() => removeSection(section.id)}><Trash2 /></Button>
                      </div>
                    </div>

                    {section.kind === "about" || section.kind === "text" ? (
                      <textarea
                        className="field mt-3 min-h-24 resize-y focus:field-focus"
                        aria-label={`${section.title} text`}
                        value={section.body}
                        maxLength={800}
                        rows={3}
                        placeholder="Write something…"
                        onChange={(event) => patchSection(section.id, { body: event.target.value })}
                      />
                    ) : (
                      <div className="mt-3 flex flex-col gap-2">
                        {section.items.map((item) => (
                          <div key={item.id} className="flex flex-wrap items-center gap-2">
                            <input
                              className="field h-9 w-36 shrink-0 focus:field-focus"
                              aria-label="Link label"
                              placeholder="Label"
                              value={item.label}
                              maxLength={40}
                              onChange={(event) => patchItem(section.id, item.id, { label: event.target.value })}
                            />
                            <input
                              className="field h-9 min-w-0 flex-1 focus:field-focus"
                              aria-label="Link URL"
                              placeholder="https://discord.gg/…"
                              value={item.url}
                              maxLength={300}
                              onChange={(event) => patchItem(section.id, item.id, { url: event.target.value })}
                            />
                            <Button size="icon" variant="ghost" aria-label="Remove link" onClick={() => removeItem(section.id, item.id)}><Trash2 /></Button>
                          </div>
                        ))}
                        {section.items.length < 20 && (
                          <Button size="sm" variant="outline" className="self-start" onClick={() => addItem(section.id)}><Plus />Add link</Button>
                        )}
                      </div>
                    )}
                  </article>
                ))}
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                {SECTION_KINDS.map((kind) => (
                  <Button key={kind.id} variant="outline" size="sm" onClick={() => addSection(kind.id)} disabled={draft.sections.length >= 10}>
                    <Plus />{kind.label}
                  </Button>
                ))}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">Up to 10 sections, 20 links each.</p>
            </section>

            <div className="mt-6 flex flex-wrap items-center gap-2 pb-10">
              <Button onClick={() => void save()} disabled={status.kind === "saving"}>
                {status.kind === "saving" ? <Loader2 className="animate-spin" /> : <Save />}Save profile
              </Button>
              <Button variant="outline" asChild><a href={publicUrl} target="_blank" rel="noreferrer">Open public page</a></Button>
              <span className="break-all text-xs text-muted-foreground">{publicUrl}</span>
            </div>
          </div>

          <aside className={`${tab === "preview" ? "block" : "hidden lg:block"} min-w-0`}>
            <div className="sticky top-4 overflow-hidden rounded-2xl border border-border">
              <div className="flex items-center justify-between gap-2 border-b border-border bg-card px-3 py-2">
                <span className="text-xs font-semibold uppercase tracking-[0.15em] text-muted-foreground">Live preview</span>
                {!draft.published && <span className="text-xs text-muted-foreground">Not published</span>}
              </div>
              <div className="max-h-[calc(100dvh-12rem)] overflow-y-auto">
                <ProfileView profile={draft} preview />
              </div>
            </div>
          </aside>
        </div>
      ) : (
        <div className="panel p-8 text-center text-sm text-muted-foreground">
          <p>Starting a fresh profile…</p>
          <Button className="mt-3" variant="outline" onClick={() => setDraft(emptyProfile(mine.data?.viewer?.name ?? "Zora user"))}>Start over</Button>
        </div>
      )}
    </main>
  );
}
