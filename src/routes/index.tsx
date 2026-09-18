import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  ACTIVITY_TYPES,
  PRESETS,
  buildActivityPayload,
  emptyDraft,
  type PresenceDraft,
  type TimestampMode,
} from "@/lib/presence";
import {
  connectToDiscord,
  isInsideDiscord,
  publishActivity,
  resetActivity,
} from "@/lib/discord-client";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Presence Studio — Custom Discord Rich Presence" },
      {
        name: "description",
        content:
          "Design a custom Discord rich presence with presets, artwork, timers and live preview, then push it to your profile from inside the Activity.",
      },
      { property: "og:title", content: "Presence Studio — Custom Discord Rich Presence" },
      {
        property: "og:description",
        content:
          "Pick a preset, tweak every line of your Discord status, and activate it live from the Activity.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: PresenceStudio,
});

type Status = { kind: "idle" | "busy" | "ok" | "error"; message: string };

/** Surfaces the real Discord error text, even when the SDK throws non-Error values. */
function describeError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  if (error && typeof error === "object") {
    const e = error as Record<string, unknown>;
    const msg = e["message"] ?? e["error_description"] ?? e["error"] ?? e["code"];
    if (typeof msg === "string" && msg) return msg;
    try {
      const json = JSON.stringify(error);
      if (json && json !== "{}" && json !== "null") return json;
    } catch {
      /* fall through */
    }
  }
  return fallback;
}

function PresenceStudio() {
  const [presetId, setPresetId] = useState("music");
  const [draft, setDraft] = useState<PresenceDraft>(
    () => PRESETS.find((p) => p.id === "music")!.draft,
  );
  const [connected, setConnected] = useState(false);
  const [inDiscord, setInDiscord] = useState(true);
  const [live, setLive] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle", message: "" });

  useEffect(() => {
    setInDiscord(isInsideDiscord());
  }, []);

  const activePreset = useMemo(
    () => PRESETS.find((p) => p.id === presetId) ?? PRESETS[0]!,
    [presetId],
  );

  const set = <K extends keyof PresenceDraft>(key: K, value: PresenceDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setLive(false);
  };

  const choosePreset = (id: string) => {
    const preset = PRESETS.find((p) => p.id === id);
    if (!preset) return;
    setPresetId(id);
    setDraft(id === "custom" ? { ...emptyDraft, timestampMode: "none" } : { ...preset.draft });
    setLive(false);
  };

  const handleConnect = async () => {
    setStatus({ kind: "busy", message: "Asking Discord for permission…" });
    try {
      const { username } = await connectToDiscord();
      setConnected(true);
      setStatus({ kind: "ok", message: `Connected as ${username}.` });
    } catch (error) {
      setStatus({
        kind: "error",
        message: describeError(error, "Could not connect to Discord."),
      });
    }
  };

  const handleActivate = async () => {
    setStatus({ kind: "busy", message: "Updating your presence…" });
    try {
      await publishActivity(buildActivityPayload(draft));
      setLive(true);
      setStatus({ kind: "ok", message: "Your profile is showing this right now." });
    } catch (error) {
      setStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "Could not update your presence.",
      });
    }
  };

  const handleClear = async () => {
    setStatus({ kind: "busy", message: "Clearing…" });
    try {
      await resetActivity();
      setLive(false);
      setStatus({ kind: "ok", message: "Cleared back to the plain Activity presence." });
    } catch (error) {
      setStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "Could not clear your presence.",
      });
    }
  };

  return (
    <main className="min-h-screen px-4 py-8 sm:px-8 lg:px-12">
      <div className="mx-auto max-w-6xl">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.25em] text-primary">
              Presence Studio
            </p>
            <h1 className="mt-2 text-3xl font-bold sm:text-4xl">Build your status</h1>
            <p className="mt-2 max-w-xl text-sm text-muted-foreground">
              Pick a preset, rewrite every line, then push it live to your Discord profile.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <span
              className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium ${
                live
                  ? "border-primary/50 bg-primary/10 text-primary"
                  : "border-border bg-secondary text-muted-foreground"
              }`}
            >
              <span
                className={`size-2 rounded-full ${live ? "animate-pulse bg-primary" : "bg-muted-foreground"}`}
              />
              {live ? "Live on your profile" : "Not active"}
            </span>
          </div>
        </header>

        {!inDiscord && (
          <div className="mt-6 rounded-2xl border border-border bg-secondary/60 p-4 text-sm text-muted-foreground">
            You're viewing this in a normal browser tab, so nothing can reach your profile here.
            Everything below works as a designer — launch it as an Activity inside a Discord voice
            channel to actually go live.
          </div>
        )}

        <section className="mt-8">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
            Presets
          </h2>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {PRESETS.map((preset) => {
              const selected = preset.id === presetId;
              return (
                <button
                  key={preset.id}
                  onClick={() => choosePreset(preset.id)}
                  className={`group flex items-center gap-2 rounded-xl border px-3 py-3 text-left transition-all ${
                    selected
                      ? "border-primary bg-primary/10 shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary)_18%,transparent)]"
                      : "border-border bg-card/70 hover:border-primary/50 hover:bg-card"
                  }`}
                >
                  <span className="text-lg">{preset.emoji}</span>
                  <span className="text-sm font-medium">{preset.name}</span>
                </button>
              );
            })}
          </div>
        </section>

        <div className="mt-8 grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
          <section className="panel p-5 sm:p-6">
            <h2 className="text-lg font-semibold">Customize</h2>

            <div className="mt-5 space-y-5">
              <div>
                <Label>Activity type</Label>
                <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {ACTIVITY_TYPES.map((t) => (
                    <button
                      key={t.value}
                      onClick={() => set("type", t.value)}
                      className={`rounded-lg border px-3 py-2 text-sm transition-colors ${
                        draft.type === t.value
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border bg-input text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              <Field
                label="Details (first line)"
                hint="Where your emoji + headline goes, e.g. 🎵 Listening to Music"
                value={draft.details}
                onChange={(v) => set("details", v)}
                placeholder="🎵 Listening to Music"
                max={128}
              />

              <Field
                label="State (second line)"
                value={draft.state}
                onChange={(v) => set("state", v)}
                placeholder="On repeat, all night"
                max={128}
              />

              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Large image"
                  hint="Image URL or an asset name from your app"
                  value={draft.largeImage}
                  onChange={(v) => set("largeImage", v)}
                  placeholder="https://…/cover.png"
                />
                <Field
                  label="Large image hover text"
                  value={draft.largeText}
                  onChange={(v) => set("largeText", v)}
                  placeholder="Now playing"
                />
                <Field
                  label="Small image"
                  value={draft.smallImage}
                  onChange={(v) => set("smallImage", v)}
                  placeholder="https://…/badge.png"
                />
                <Field
                  label="Small image hover text"
                  value={draft.smallText}
                  onChange={(v) => set("smallText", v)}
                  placeholder="Vinyl mode"
                />
              </div>

              <div>
                <Label>Timer</Label>
                <div className="mt-2 flex flex-wrap gap-2">
                  {(
                    [
                      ["none", "No timer"],
                      ["elapsed", "Count up"],
                      ["remaining", "Count down"],
                    ] as [TimestampMode, string][]
                  ).map(([mode, label]) => (
                    <button
                      key={mode}
                      onClick={() => set("timestampMode", mode)}
                      className={`rounded-lg border px-3 py-2 text-sm transition-colors ${
                        draft.timestampMode === mode
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border bg-input text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {draft.timestampMode === "remaining" && (
                  <div className="mt-3 flex items-center gap-3">
                    <input
                      type="number"
                      min={1}
                      max={1440}
                      value={draft.durationMinutes}
                      onChange={(e) => set("durationMinutes", Number(e.target.value))}
                      className="field w-28 focus:field-focus"
                    />
                    <span className="text-sm text-muted-foreground">minutes left</span>
                  </div>
                )}
              </div>

              <div>
                <Label>Party size (optional)</Label>
                <div className="mt-2 flex items-center gap-3">
                  <input
                    type="number"
                    min={0}
                    value={draft.partyCurrent}
                    onChange={(e) => set("partyCurrent", Number(e.target.value))}
                    className="field w-24 focus:field-focus"
                  />
                  <span className="text-sm text-muted-foreground">of</span>
                  <input
                    type="number"
                    min={0}
                    value={draft.partyMax}
                    onChange={(e) => set("partyMax", Number(e.target.value))}
                    className="field w-24 focus:field-focus"
                  />
                </div>
              </div>
            </div>
          </section>

          <section className="space-y-5">
            <div className="panel p-5 sm:p-6">
              <h2 className="text-lg font-semibold">Live preview</h2>
              <PresenceCard draft={draft} accent={activePreset.accent} />
            </div>

            <div className="panel p-5 sm:p-6">
              <div className="flex flex-col gap-3">
                {!connected ? (
                  <button
                    onClick={handleConnect}
                    disabled={status.kind === "busy"}
                    className="w-full rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
                  >
                    Connect to Discord
                  </button>
                ) : (
                  <>
                    <button
                      onClick={handleActivate}
                      disabled={status.kind === "busy"}
                      className="w-full rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
                    >
                      Activate this status
                    </button>
                    <button
                      onClick={handleClear}
                      disabled={status.kind === "busy"}
                      className="w-full rounded-xl border border-border bg-secondary px-4 py-3 text-sm font-semibold transition-colors hover:bg-accent disabled:opacity-60"
                    >
                      Clear
                    </button>
                  </>
                )}

                {status.message && (
                  <p
                    className={`text-sm ${
                      status.kind === "error" ? "text-destructive" : "text-muted-foreground"
                    }`}
                  >
                    {status.message}
                  </p>
                )}
              </div>
            </div>

            <div className="panel p-5 text-sm text-muted-foreground sm:p-6">
              <h3 className="text-sm font-semibold text-foreground">What Discord allows</h3>
              <ul className="mt-3 space-y-2">
                <li>
                  <strong className="text-foreground">The bold title line is fixed.</strong> Discord
                  always shows this app's own name there, so the preset name lives in Details
                  instead.
                </li>
                <li>
                  <strong className="text-foreground">Buttons aren't available</strong> to Discord
                  Activities — only to desktop apps.
                </li>
                <li>
                  Your status lasts while the Activity is open, and disappears when you leave.
                </li>
              </ul>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
      {children}
    </span>
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
  placeholder,
  max,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  max?: number;
}) {
  return (
    <label className="block">
      <Label>{label}</Label>
      <input
        value={value}
        maxLength={max}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="field mt-2 focus:field-focus"
      />
      {hint && <span className="mt-1 block text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

function PresenceCard({ draft, accent }: { draft: PresenceDraft; accent: string }) {
  const verb = ACTIVITY_TYPES.find((t) => t.value === draft.type)?.verb ?? "Playing";
  const timer =
    draft.timestampMode === "elapsed"
      ? "00:00 elapsed"
      : draft.timestampMode === "remaining"
        ? `${draft.durationMinutes}:00 left`
        : null;
  const party =
    draft.partyMax > 0 && draft.partyCurrent > 0
      ? ` (${draft.partyCurrent} of ${draft.partyMax})`
      : "";

  return (
    <div className="mt-4 rounded-2xl border border-border bg-background/70 p-4">
      <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
        {verb}
      </p>
      <div className="mt-3 flex gap-3">
        <div className="relative shrink-0">
          <div
            className="flex size-16 items-center justify-center overflow-hidden rounded-xl border border-border text-2xl"
            style={{ backgroundColor: `color-mix(in oklch, ${accent} 22%, transparent)` }}
          >
            {draft.largeImage ? (
              <img
                src={draft.largeImage}
                alt=""
                className="size-full object-cover"
                onError={(e) => {
                  e.currentTarget.style.display = "none";
                }}
              />
            ) : (
              <span>🖼️</span>
            )}
          </div>
          {draft.smallImage && (
            <img
              src={draft.smallImage}
              alt=""
              className="absolute -bottom-1 -right-1 size-6 rounded-full border-2 border-background object-cover"
            />
          )}
        </div>

        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">Your Discord app name</p>
          <p className="truncate text-sm text-muted-foreground">
            {draft.details || <span className="italic opacity-60">Details line</span>}
          </p>
          <p className="truncate text-sm text-muted-foreground">
            {draft.state ? (
              `${draft.state}${party}`
            ) : (
              <span className="italic opacity-60">State line</span>
            )}
          </p>
          {timer && <p className="text-xs text-muted-foreground/80">{timer}</p>}
        </div>
      </div>
    </div>
  );
}
