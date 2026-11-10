import { createFileRoute } from "@tanstack/react-router";
import { ChevronDown, FolderHeart, Image, Save, Settings2, SlidersHorizontal, Sparkles, Timer } from "lucide-react";
import { StudioNav } from "@/components/StudioNav";
import { PresetLibrary } from "@/components/PresetLibrary";
import { Button } from "@/components/ui/button";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ACTIVITY_TYPES,
  PRESETS,
  verbFor,
  buildActivityPayload,
  normalizeHex,
  swatchPath,
  type PresenceDraft,
  type TimestampMode,
} from "@/lib/presence";
import {
  connectToDiscord,
  getAccessToken,
  isInsideDiscord,
  publishActivity,
  reapplyAfterResume,
  resetActivity,
  subscribeConnection,
  type ConnectionState,
} from "@/lib/discord-client";
import {
  deleteSavedPreset,
  listSavedPresets,
  saveSavedPreset,
  type SavedPreset,
} from "@/lib/presets.functions";
import { extractUrlMetadata } from "@/lib/url-metadata";
import {
  getDiscordLinkUrl,
  getServerPresenceStatus,
  startServerPresence,
  stopServerPresence,
  updateServerPresence,
  type Json,
  type ServerPresenceStatus,
} from "@/lib/server-presence.functions";
import { PUBLIC_SITE_ORIGIN } from "@/lib/site";
import { ImagePicker } from "@/components/ImagePicker";
import { ActivityBridgePanel } from "@/components/ActivityBridgePanel";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Zora Studio — Discord Presence Creator" },
      {
        name: "description",
        content:
          "Design a custom Discord rich presence with presets, artwork, timers and live preview, then push it to your profile from inside the Activity.",
      },
      { property: "og:title", content: "Zora Studio — Discord Presence Creator" },
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

/** Quick-pick colours for the status accent. */
const COLOUR_SWATCHES = ["#4ade80", "#22d3ee", "#a78bfa", "#fbbf24", "#fb7185", "#f472b6"];

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

/**
 * Turns a raw OAuth failure reason into something a person can act on.
 *
 * Discord's OAuth edge sits behind Cloudflare, so when their origin DNS fails
 * the browser arrives at our callback with a bare Cloudflare page text like
 * "error code: 1016" instead of a real OAuth error — retrying usually fixes it.
 */
function humanizeLinkReason(reason: string | null): string {
  const raw = (reason ?? "").trim();
  const lower = raw.toLowerCase();
  if (lower.includes("1016") || lower.includes("origin dns")) {
    return "Discord's sign-in service hit a temporary network error (Cloudflare 1016). Try the Link button again — this usually clears on its own.";
  }
  if (lower.includes("invalid oauth2 redirect_uri") || lower.includes("redirect_uri")) {
    return `Discord rejected the callback URL. The portal must list ${PUBLIC_SITE_ORIGIN}/api/public/discord/callback under OAuth2 → Redirects.`;
  }
  if (lower.includes("invalid oauth2 state")) {
    return "The sign-in link expired (state mismatch). Press the Link button again for a fresh one.";
  }
  if (lower.includes("access_denied")) {
    return "Authorization was declined on Discord's consent screen. Approve the requested permissions when prompted.";
  }
  return raw ? `Discord linking failed: ${raw}` : "Discord linking failed (unknown error).";
}

/** Human label for the worker states the heartbeat endpoint accepts. */
function serverWorkerLabel(state: string): string {
  switch (state) {
    case "running":
      return "Presence live via worker";
    case "connecting":
      return "Worker connecting…";
    case "cleared":
      return "Worker standing by";
    case "error":
      return "Worker error";
    default:
      return "No worker activity yet";
  }
}

/** "45s", "12m", "3h" — a raw second count gets unreadable on an overnight session. */
function seenAgo(seconds: number): string {
  if (seconds < 120) return `${seconds}s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

function PresenceStudio() {
  const [presetId, setPresetId] = useState("music");
  const [workspace, setWorkspace] = useState<"creator" | "presets" | "settings">("creator");
  const [editorTab, setEditorTab] = useState<"text" | "artwork" | "timing">("text");
  const [draft, setDraft] = useState<PresenceDraft>(
    () => ({ ...PRESETS[0]?.draft } as PresenceDraft),
  );
  const [connected, setConnected] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [inDiscord, setInDiscord] = useState(true);
  const [live, setLive] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle", message: "" });

  // Saved presets (personal ones stored in Supabase)
  const [savedPresets, setSavedPresets] = useState<SavedPreset[]>([]);
  const [savedLoading, setSavedLoading] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [urlInput, setUrlInput] = useState("");
  const [urlLoading, setUrlLoading] = useState(false);

  // Server presence (drive the Linux worker): link status + worker heartbeat.
  const [sp, setSp] = useState<ServerPresenceStatus | null>(null);
  const [spBusy, setSpBusy] = useState(false);

  // The account is reachable from either surface: the Activity SDK, or the
  // linked-account session this browser holds.
  const canUseAccount = connected || !!sp?.linked;

  const refreshServerPresence = useCallback(async () => {
    try {
      setSp(await getServerPresenceStatus());
    } catch {
      /* non-fatal: the panel keeps showing its last known state */
    }
  }, []);

  // Poll worker liveness; refresh immediately when the tab regains focus.
  useEffect(() => {
    void refreshServerPresence();
    const timer = window.setInterval(() => void refreshServerPresence(), 10_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshServerPresence();
    };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshServerPresence]);

  // The OAuth callback redirects back here with ?link=ok|error.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const link = params.get("link");
    if (link !== "ok" && link !== "error") return;
    window.history.replaceState(null, "", window.location.pathname);
    if (link === "ok") {
      setStatus({ kind: "ok", message: "Discord account linked. Server presence is available." });
      void refreshServerPresence();
    } else {
      setStatus({
        kind: "error",
        message: humanizeLinkReason(params.get("reason")),
      });
    }
  }, [refreshServerPresence]);

  useEffect(() => {
    setInDiscord(isInsideDiscord());
  }, []);

  // Keep connection state in sync
  useEffect(() => {
    return subscribeConnection((next) => {
      setConnectionState(next);
      if (next === "disconnected") {
        setConnected(false);
        setLive(false);
      }
    });
  }, []);

  // Re-apply activity when the page becomes visible again (e.g. after switching to Spotify)
  useEffect(() => {
    if (!connected) return;

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void reapplyAfterResume().then((ok) => {
          if (ok) {
            setLive(true);
            setStatus({ kind: "ok", message: "Status restored after returning." });
          }
        });
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    // Also handle pageshow for bfcache / iOS cases
    window.addEventListener("pageshow", onVisibility);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onVisibility);
    };
  }, [connected]);

  // Load saved presets once the account is reachable, via the Activity SDK or
  // the browser session cookie.
  useEffect(() => {
    if (!canUseAccount) return;
    const token = getAccessToken();

    setSavedLoading(true);
    listSavedPresets({ data: token ? { accessToken: token } : {} })
      .then((res) => setSavedPresets(res.presets ?? []))
      .catch(() => {
        /* non-fatal – user can still use built-in presets */
      })
      .finally(() => setSavedLoading(false));
  }, [canUseAccount]);

  const activePreset = useMemo(
    () => PRESETS.find((p) => p.id === presetId) ?? PRESETS[0],
    [presetId],
  );

  // A hex colour typed by the user overrides the preset's own accent, tints
  // the whole dashboard background, and becomes the profile artwork when no
  // photo is chosen.
  const draftColor = normalizeHex(draft.color);
  const accent = draftColor ?? activePreset?.accent ?? "var(--primary)";

  // When a status is live the preview timer counts from the instant Discord was
  // given, so it reads the same as the profile instead of restarting.
  const activityStart = useMemo(() => {
    const start = (sp?.activity as { timestamps?: { start?: unknown } } | null)?.timestamps?.start;
    return typeof start === "number" ? start : null;
  }, [sp]);

  const workerLive = sp?.desiredState === "running" && sp.workerState === "running";
  const pill =
    connectionState === "reconnecting"
      ? { tone: "warn" as const, label: "Reconnecting..." }
      : live
        ? { tone: "on" as const, label: "Live on your profile" }
        : workerLive
          ? { tone: "on" as const, label: "Live on your profile (worker)" }
          : { tone: "off" as const, label: "Not active" };

  const set = <K extends keyof PresenceDraft>(key: K, value: PresenceDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setLive(false);
  };

  const choosePreset = (id: string) => {
    const preset = PRESETS.find((p) => p.id === id);
    if (!preset) return;
    setPresetId(id);
    setEditingId(null);
    setDraft({ ...preset.draft });
    setSaveName("");
    setWorkspace("creator");
    setLive(false);
  };

  const applySavedPreset = (preset: SavedPreset) => {
    setPresetId("custom");
    setEditingId(preset.id);
    setDraft({ ...preset.draft });
    setSaveName(preset.name);
    setWorkspace("creator");
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
        message: describeError(error, "Could not update your presence."),
      });
    }
  };

  const handleClear = async () => {
    setStatus({ kind: "busy", message: "Clearing…" });
    try {
      await resetActivity();
      setLive(false);
      setStatus({ kind: "ok", message: "Rich Presence cleared." });
    } catch (error) {
      setStatus({
        kind: "error",
        message: describeError(error, "Could not clear your presence."),
      });
    }
  };

  const handleSavePreset = async () => {
    if (!canUseAccount) {
      setStatus({ kind: "error", message: "Link your Discord account first." });
      return;
    }
    const token = getAccessToken();
    const name = saveName.trim() || "My preset";
    setStatus({ kind: "busy", message: editingId ? "Updating preset…" : "Saving preset…" });
    try {
      const { preset } = await saveSavedPreset({
        data: {
          ...(token ? { accessToken: token } : {}),
          ...(editingId ? { id: editingId } : {}),
          name,
          emoji: "✨",
          accent: draftColor ?? "oklch(0.8 0.13 180)",
          draft,
        },
      });
      setSavedPresets((prev) => {
        const others = prev.filter((p) => p.id !== preset.id);
        return [...others, preset];
      });
      setEditingId(preset.id);
      setSaveName(preset.name);
      setStatus({ kind: "ok", message: `Saved “${preset.name}”.` });
    } catch (error) {
      setStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "Could not save preset.",
      });
    }
  };

  const handleDuplicatePreset = async (preset: SavedPreset) => {
    const token = getAccessToken();
    setStatus({ kind: "busy", message: "Duplicating…" });
    try {
      const { preset: copy } = await saveSavedPreset({
        data: {
          ...(token ? { accessToken: token } : {}),
          name: `${preset.name} (copy)`,
          emoji: preset.emoji,
          accent: preset.accent,
          draft: preset.draft,
        },
      });
      setSavedPresets((prev) => [...prev, copy]);
      setStatus({ kind: "ok", message: `Duplicated as “${copy.name}”.` });
    } catch (error) {
      setStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "Could not duplicate.",
      });
    }
  };

  const handleDeletePreset = async (id: string) => {
    const token = getAccessToken();
    setStatus({ kind: "busy", message: "Deleting…" });
    try {
      await deleteSavedPreset({ data: { ...(token ? { accessToken: token } : {}), id } });
      setSavedPresets((prev) => prev.filter((p) => p.id !== id));
      if (editingId === id) {
        setEditingId(null);
        setSaveName("");
      }
      setStatus({ kind: "ok", message: "Preset deleted." });
    } catch (error) {
      setStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "Could not delete.",
      });
    }
  };

  // ---- URL metadata extraction ----

  const handleExtractUrl = async () => {
    if (!urlInput.trim()) return;
    setUrlLoading(true);
    try {
      const { title, description, imageUrl, service } = await extractUrlMetadata({
        data: { url: urlInput.trim() },
      });
      setDraft((d) => ({
        ...d,
        details: title || d.details,
        state: description || d.state,
        largeImage: imageUrl || d.largeImage,
      }));
      setStatus({ kind: "ok", message: `Filled from ${service}. Every field is still editable.` });
      setUrlInput("");
    } catch (error) {
      setStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "Couldn't read that URL.",
      });
    } finally {
      setUrlLoading(false);
    }
  };

  // ---- Server presence (Linux worker control plane) ----

  /** JSON-safe activity; the server function prunes it to the fields Discord accepts. */
  const buildServerActivity = () => buildActivityPayload(draft) as Record<string, Json>;

  const handleLinkDiscord = async () => {
    // Discord rejects an OAuth redirect started inside the Activity iframe, so
    // the button is hidden there. This guard keeps any future caller from
    // sending the browser to that dead end.
    if (isInsideDiscord()) {
      setStatus({
        kind: "error",
        message: `Discord blocks account linking inside an Activity. Open ${PUBLIC_SITE_ORIGIN} in your browser and link from there.`,
      });
      return;
    }
    setSpBusy(true);
    try {
      const { url } = await getDiscordLinkUrl();
      window.location.href = url;
    } catch (error) {
      setSpBusy(false);
      setStatus({
        kind: "error",
        message: describeError(error, "Could not start Discord linking."),
      });
    }
  };

  const handleServerStart = async () => {
    setSpBusy(true);
    try {
      await startServerPresence({ data: { activity: buildServerActivity() } });
      await refreshServerPresence();
      setStatus({ kind: "ok", message: "Go-live requested — the worker is applying it now." });
    } catch (error) {
      setStatus({
        kind: "error",
        message: describeError(error, "Could not start server presence."),
      });
    } finally {
      setSpBusy(false);
    }
  };

  const handleServerUpdate = async () => {
    setSpBusy(true);
    try {
      await updateServerPresence({ data: { activity: buildServerActivity() } });
      await refreshServerPresence();
      setStatus({
        kind: "ok",
        message: "Update sent — the worker will pick it up within seconds.",
      });
    } catch (error) {
      setStatus({
        kind: "error",
        message: describeError(error, "Could not update server presence."),
      });
    } finally {
      setSpBusy(false);
    }
  };

  const handleServerStop = async () => {
    setSpBusy(true);
    try {
      await stopServerPresence();
      await refreshServerPresence();
      setStatus({ kind: "ok", message: "Stop requested — the worker is clearing your presence." });
    } catch (error) {
      setStatus({
        kind: "error",
        message: describeError(error, "Could not stop server presence."),
      });
    } finally {
      setSpBusy(false);
    }
  };

  return (
    <main className="studio-shell min-h-screen px-4 pb-10 pt-5 sm:px-8">
      <div className="mx-auto max-w-6xl">
        <StudioNav />
        <div className="flex items-center justify-between gap-3 py-7">
          <div><p className="mb-1 text-xs font-medium text-muted-foreground">YOUR SPACE, YOUR STATUS</p><h1 className="text-3xl font-semibold">Presence studio<span className="text-primary">.</span></h1></div>
          <span className={`inline-flex shrink-0 items-center gap-2 text-xs ${pill.tone === "on" ? "text-primary" : "text-muted-foreground"}`}><span className={`size-2 rounded-full ${pill.tone === "on" ? "bg-primary" : "bg-muted-foreground"}`} />{pill.tone === "on" ? "Live" : pill.tone === "warn" ? "Reconnecting" : "Offline"}</span>
        </div>
        <nav aria-label="Studio sections" className="flex gap-1 border-b border-border">{([
          ["creator", "Creator", Sparkles], ["presets", "Presets", FolderHeart], ["settings", "Settings", Settings2],
        ] as const).map(([id, label, Icon]) => <Button key={id} variant="ghost" aria-current={workspace === id ? "page" : undefined} className={`h-12 flex-1 rounded-none border-b-2 sm:flex-none sm:px-6 ${workspace === id ? "border-primary text-primary" : "border-transparent text-muted-foreground"}`} onClick={() => setWorkspace(id)}><Icon />{label}{id === "presets" && savedPresets.length > 0 && <span className="text-xs">{savedPresets.length}</span>}</Button>)}</nav>
        {status.message && <p role={status.kind === "error" ? "alert" : "status"} className={`mt-4 break-words rounded-lg border border-border px-4 py-3 text-sm ${status.kind === "error" ? "text-destructive" : "text-primary"}`}>{status.message}</p>}
        <div hidden={workspace !== "presets"}><PresetLibrary saved={savedPresets} loading={savedLoading} linked={canUseAccount} busy={status.kind === "busy"} selectedId={editingId} templateId={presetId} onApply={applySavedPreset} onTemplate={choosePreset} onDuplicate={preset => void handleDuplicatePreset(preset)} onDelete={id => void handleDeletePreset(id)} onConnect={() => setWorkspace("settings")} /></div>
        <div hidden={workspace !== "settings"} className="py-6"><h2 className="text-2xl font-semibold">Settings</h2>        {/* Server presence: link + worker-driven Rich Presence */}
        <section className="connection-section py-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">Discord connection</h2>
              <p className="mt-1 max-w-xl text-sm text-muted-foreground">
                
              </p>
            </div>
            {sp?.linked && sp.username && (
              <span className="inline-flex items-center gap-2 rounded-full border border-border bg-secondary px-3 py-1.5 text-xs font-medium text-muted-foreground">
                Linked as {sp.username}
              </span>
            )}
          </div>

          {!sp ? (
            <p className="mt-4 text-sm text-muted-foreground">Checking link status…</p>
          ) : !sp.linked ? (
            inDiscord ? (
              /*
               * Inside the Activity the page is served from Discord's proxy host, so
               * Discord refuses the OAuth redirect ("Invalid OAuth2 redirect_uri").
               * Offering the button there only led people to a Discord error screen.
               */
              <div className="mt-4 rounded-xl border border-border bg-background/60 p-3">
                <p className="text-sm font-medium">Link from a browser tab to go live</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Discord blocks account linking inside an Activity, so this button only appears
                  outside Discord. Open <code className="break-all">{PUBLIC_SITE_ORIGIN}</code> in
                  your browser and use “Link Discord account” there — once. The worker keeps your
                  status running from then on, wherever you are.
                </p>
              </div>
            ) : (
              <div className="mt-4 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
                <Button
                  type="button"
                  onClick={() => void handleLinkDiscord()}
                  disabled={spBusy}
                  className="min-h-11 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
                >
                  Link Discord account
                </Button>

              </div>
            )
          ) : (
            <div className="mt-4 space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                {sp.desiredState === "running" ? (
                  <>
                    <Button
                      type="button"
                      onClick={() => void handleServerUpdate()}
                      disabled={spBusy}
                      className="min-h-11 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
                    >
                      Update status
                    </Button>
                    <Button
                      type="button"
                      onClick={() => void handleServerStop()}
                      disabled={spBusy}
                      className="min-h-11 rounded-xl border border-border bg-secondary px-4 py-2.5 text-sm font-semibold transition-colors hover:bg-accent disabled:opacity-60"
                    >
                      Stop
                    </Button>
                  </>
                ) : (
                  <Button
                    type="button"
                    onClick={() => void handleServerStart()}
                    disabled={spBusy}
                    className="min-h-11 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
                  >
                    Go live
                  </Button>
                )}

              </div>

              <div className="rounded-xl border border-border bg-background/60 p-3">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                  <span className="inline-flex items-center gap-2 font-medium">
                    <span
                      className={`size-2 rounded-full ${
                        sp.workerState === "running"
                          ? "animate-pulse bg-primary"
                          : sp.workerState === "connecting"
                            ? "animate-pulse bg-warning"
                            : sp.workerState === "error"
                              ? "bg-destructive"
                              : "bg-muted-foreground"
                      }`}
                    />
                    {serverWorkerLabel(sp.workerState)}
                  </span>
                  {sp.workerSeenSecondsAgo != null && (
                    <span className="text-xs text-muted-foreground">
                      Worker seen {seenAgo(sp.workerSeenSecondsAgo)} ago
                    </span>
                  )}
                </div>
                {sp.desiredState === "running" &&
                  !workerLive &&
                  (sp.workerSeenSecondsAgo == null || sp.workerSeenSecondsAgo > 90) && (
                    <p className="mt-1 text-xs text-warning">
                      The worker has gone quiet. It reconnects and re-publishes this status on its
                      own once it is reachable again — nothing to reset.
                    </p>
                  )}
                {sp.workerMessage && (
                  <p
                    className={`mt-1 break-words text-xs ${
                      sp.workerState === "error" ? "text-destructive" : "text-muted-foreground"
                    }`}
                  >
                    {sp.workerMessage}
                  </p>
                )}
              </div>
            </div>
          )}
        </section>

<details className="mt-5 border-t border-border pt-5"><summary className="cursor-pointer text-base font-semibold">Activity sharing</summary><ActivityBridgePanel /></details></div>
        <div hidden={workspace !== "creator"} className="creator-layout grid gap-8 py-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <section className="editor-section min-w-0 lg:border-r lg:border-border lg:pr-8">
            <div className="flex items-center justify-between"><h2 className="text-xl font-semibold">{editingId ? saveName || "Edit preset" : "Create a status"}</h2><span className="text-xs text-muted-foreground">{activePreset?.name}</span></div>
            <div className="editor-tabs mt-5 flex border-b border-border" role="tablist" aria-label="Status fields">{([
              ["text", "Text", SlidersHorizontal], ["artwork", "Artwork", Image], ["timing", "Timing", Timer],
            ] as const).map(([id, label, Icon]) => <Button key={id} role="tab" aria-selected={editorTab === id} variant="ghost" className={`flex-1 rounded-none border-b-2 py-5 ${editorTab === id ? "border-primary text-primary" : "border-transparent text-muted-foreground"}`} onClick={() => setEditorTab(id)}><Icon />{label}</Button>)}</div>

            <div className="mt-5 space-y-5">
              <div hidden={editorTab !== "text"}>
              <details className="border-b border-border pb-4">
                <summary className="flex cursor-pointer items-center justify-between text-sm text-muted-foreground">Fill from a link<ChevronDown className="size-4" /></summary>
                <div className="pt-3">
                <Label>Quick fill from URL</Label>
                <div className="flex items-center gap-2">
                  <input
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handleExtractUrl();
                    }}
                    placeholder="https://youtube.com/watch?v=..."
                    className="field min-w-0 flex-1 focus:field-focus"
                    disabled={urlLoading}
                  />
                  <Button
                    type="button"
                    onClick={() => void handleExtractUrl()}
                    disabled={urlLoading || !urlInput.trim()}
                    className="min-h-11 rounded-xl border border-border bg-secondary px-4 py-2 text-sm font-semibold transition-colors hover:bg-accent disabled:opacity-60"
                  >
                    {urlLoading ? "Extracting…" : "Extract"}
                  </Button>
                </div>
                </div>
              </details>

              <div className="mt-5">
                <Label>Activity type</Label>
                <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {ACTIVITY_TYPES.map((t) => (
                    <Button
                      key={t.value}
                      onClick={() => set("type", t.value)}
                      className={`rounded-lg border px-3 py-2 text-sm transition-colors ${
                        draft.type === t.value
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border bg-input text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {t.label}
                    </Button>
                  ))}
                </div>
              </div>

              <Field
                label="Details"
                value={draft.details}
                onChange={(v) => set("details", v)}
                placeholder="🎵 Listening to Music"
                max={128}
              />

              <Field
                label="State"
                value={draft.state}
                onChange={(v) => set("state", v)}
                placeholder="On repeat, all night"
                max={128}
              />

              </div>
              <div hidden={editorTab !== "artwork"}>
              <div>
                <Label>Status colour</Label>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input
                    value={draft.color ?? ""}
                    onChange={(e) => set("color", e.target.value)}
                    placeholder="#4ade80"
                    maxLength={7}
                    aria-label="Status colour" className="field w-32 focus:field-focus"
                  />
                  <span
                    aria-hidden
                    className="size-9 shrink-0 rounded-lg border border-border"
                    style={{ backgroundColor: draftColor ?? "transparent" }}
                  />
                  {COLOUR_SWATCHES.map((hex) => (
                    <Button
                      key={hex}
                      type="button"
                      title={hex} aria-label={`Choose colour ${hex}`}
                      onClick={() => set("color", hex)}
                      className="size-7 rounded-md border border-border transition-transform hover:scale-110"
                      style={{ backgroundColor: hex }}
                    />
                  ))}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {draft.color && !draftColor
                    ? "Use a hex code like #4ade80."
                    : "Discord has no colour setting for presence, so the colour tints the studio and, when you leave the photos empty, becomes the artwork on your profile."}
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <ImagePicker
                  label="Large image"
                  value={draft.largeImage}
                  onChange={(v) => set("largeImage", v)}
                />
                <Field
                  label="Large image hover text"
                  value={draft.largeText}
                  onChange={(v) => set("largeText", v)}
                  placeholder="Now playing"
                />
                <ImagePicker
                  label="Small image"
                  value={draft.smallImage}
                  onChange={(v) => set("smallImage", v)}
                />
                <Field
                  label="Small image hover text"
                  value={draft.smallText}
                  onChange={(v) => set("smallText", v)}
                  placeholder="Vinyl mode"
                />
              </div>

              </div>
              <div hidden={editorTab !== "timing"}>
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
                    <Button
                      key={mode}
                      onClick={() => set("timestampMode", mode)}
                      className={`rounded-lg border px-3 py-2 text-sm transition-colors ${
                        draft.timestampMode === mode
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border bg-input text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
                {draft.timestampMode === "remaining" && (
                  <div className="mt-3 flex items-center gap-3">
                    <input
                      aria-label="Duration in minutes" type="number"
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
                    aria-label="Party current" value={draft.partyCurrent}
                    onChange={(e) => set("partyCurrent", Number(e.target.value))}
                    className="field w-24 focus:field-focus"
                  />
                  <span className="text-sm text-muted-foreground">of</span>
                  <input
                    type="number"
                    min={0}
                    aria-label="Party maximum" value={draft.partyMax}
                    onChange={(e) => set("partyMax", Number(e.target.value))}
                    className="field w-24 focus:field-focus"
                  />
                </div>
              </div>
              </div>
            </div>
            <div className="mt-7 border-t border-border pt-5">
              <label className="block text-sm font-medium" htmlFor="preset-name">Preset name</label>
              <div className="mt-2 flex gap-2"><input id="preset-name" value={saveName} onChange={e => setSaveName(e.target.value)} placeholder="Name your preset" maxLength={60} className="field min-w-0 flex-1 focus:field-focus" /><Button variant="secondary" className="h-11" disabled={!canUseAccount || status.kind === "busy"} onClick={() => void handleSavePreset()}><Save />{editingId ? "Update" : "Save"}</Button></div>
              {!canUseAccount && <Button variant="link" className="mt-1 px-0 text-xs" onClick={() => setWorkspace("settings")}>Link Discord to save presets</Button>}
              {editingId && <Button variant="ghost" className="mt-2 text-xs" onClick={() => { setEditingId(null); setSaveName(""); }}>Save a new copy instead</Button>}
            </div>
          </section>

          <section className="preview-section min-w-0 space-y-5">
            <div className="preview-tool rounded-lg border border-border bg-card p-5">
              <div className="flex items-center justify-between"><h2 className="text-sm font-semibold">Discord preview</h2><span className="text-xs text-muted-foreground">{workerLive || live ? "Live" : "Draft"}</span></div>
              <PresenceCard draft={draft} accent={accent} liveStart={activityStart} />
            </div>

                    {/* Server presence: link + worker-driven Rich Presence */}
        <section className="connection-section py-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">Discord connection</h2>
              <p className="mt-1 max-w-xl text-sm text-muted-foreground">
                
              </p>
            </div>
            {sp?.linked && sp.username && (
              <span className="inline-flex items-center gap-2 rounded-full border border-border bg-secondary px-3 py-1.5 text-xs font-medium text-muted-foreground">
                Linked as {sp.username}
              </span>
            )}
          </div>

          {!sp ? (
            <p className="mt-4 text-sm text-muted-foreground">Checking link status…</p>
          ) : !sp.linked ? (
            inDiscord ? (
              /*
               * Inside the Activity the page is served from Discord's proxy host, so
               * Discord refuses the OAuth redirect ("Invalid OAuth2 redirect_uri").
               * Offering the button there only led people to a Discord error screen.
               */
              <div className="mt-4 rounded-xl border border-border bg-background/60 p-3">
                <p className="text-sm font-medium">Link from a browser tab to go live</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Discord blocks account linking inside an Activity, so this button only appears
                  outside Discord. Open <code className="break-all">{PUBLIC_SITE_ORIGIN}</code> in
                  your browser and use “Link Discord account” there — once. The worker keeps your
                  status running from then on, wherever you are.
                </p>
              </div>
            ) : (
              <div className="mt-4 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
                <Button
                  type="button"
                  onClick={() => void handleLinkDiscord()}
                  disabled={spBusy}
                  className="min-h-11 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
                >
                  Link Discord account
                </Button>

              </div>
            )
          ) : (
            <div className="mt-4 space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                {sp.desiredState === "running" ? (
                  <>
                    <Button
                      type="button"
                      onClick={() => void handleServerUpdate()}
                      disabled={spBusy}
                      className="min-h-11 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
                    >
                      Update status
                    </Button>
                    <Button
                      type="button"
                      onClick={() => void handleServerStop()}
                      disabled={spBusy}
                      className="min-h-11 rounded-xl border border-border bg-secondary px-4 py-2.5 text-sm font-semibold transition-colors hover:bg-accent disabled:opacity-60"
                    >
                      Stop
                    </Button>
                  </>
                ) : (
                  <Button
                    type="button"
                    onClick={() => void handleServerStart()}
                    disabled={spBusy}
                    className="min-h-11 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
                  >
                    Go live
                  </Button>
                )}

              </div>

              <div className="rounded-xl border border-border bg-background/60 p-3">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                  <span className="inline-flex items-center gap-2 font-medium">
                    <span
                      className={`size-2 rounded-full ${
                        sp.workerState === "running"
                          ? "animate-pulse bg-primary"
                          : sp.workerState === "connecting"
                            ? "animate-pulse bg-warning"
                            : sp.workerState === "error"
                              ? "bg-destructive"
                              : "bg-muted-foreground"
                      }`}
                    />
                    {serverWorkerLabel(sp.workerState)}
                  </span>
                  {sp.workerSeenSecondsAgo != null && (
                    <span className="text-xs text-muted-foreground">
                      Worker seen {seenAgo(sp.workerSeenSecondsAgo)} ago
                    </span>
                  )}
                </div>
                {sp.desiredState === "running" &&
                  !workerLive &&
                  (sp.workerSeenSecondsAgo == null || sp.workerSeenSecondsAgo > 90) && (
                    <p className="mt-1 text-xs text-warning">
                      The worker has gone quiet. It reconnects and re-publishes this status on its
                      own once it is reachable again — nothing to reset.
                    </p>
                  )}
                {sp.workerMessage && (
                  <p
                    className={`mt-1 break-words text-xs ${
                      sp.workerState === "error" ? "text-destructive" : "text-muted-foreground"
                    }`}
                  >
                    {sp.workerMessage}
                  </p>
                )}
              </div>
            </div>
          )}
        </section>


            <div className="border-t border-border pt-5">
              <div className="flex flex-col gap-3">
                {!inDiscord ? (
                  <details className="text-sm text-muted-foreground"><summary className="cursor-pointer">Activity connection</summary><p className="mt-2 text-xs">Activity controls are available when Zora is open inside Discord.</p></details>
                ) : !connected ? (
                  <Button
                    onClick={handleConnect}
                    disabled={status.kind === "busy"}
                    className="w-full rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
                  >
                    Connect to Discord
                  </Button>
                ) : (
                  <>
                    <Button
                      onClick={handleActivate}
                      disabled={status.kind === "busy"}
                      className="w-full rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
                    >
                      Activate this status
                    </Button>
                    <Button
                      onClick={handleClear}
                      disabled={status.kind === "busy"}
                      className="w-full rounded-xl border border-border bg-secondary px-4 py-3 text-sm font-semibold transition-colors hover:bg-accent disabled:opacity-60"
                    >
                      Clear
                    </Button>
                  </>
                )}

              </div>
            </div>

            <details className="border-t border-border pt-4 text-xs text-muted-foreground">
              <summary className="cursor-pointer text-sm font-medium">Discord limitations</summary>
              <ul className="mt-3 space-y-2">
                <li>
                  <strong className="text-foreground">The header has two parts.</strong> The verb —
                  Listening to, Playing, Watching — comes from Activity type above. The name shown
                  beside it is your Discord application's name: rename it in the{" "}
                  <a
                    className="underline hover:text-foreground"
                    href="https://discord.com/developers/applications"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Developer Portal
                  </a>
                  , because Discord exposes no API for it.
                </li>
                <li>
                  <strong className="text-foreground">Buttons aren't available</strong> to Discord
                  Activities — only to desktop apps.
                </li>
                <li>
                  With <strong className="text-foreground">Server presence</strong> the status
                  outlives the Activity: the worker keeps it up until you press Stop.
                </li>
              </ul>
            </details>
          </section>
        </div>
      </div>
    </main>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-sm font-medium text-muted-foreground">
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

/** mm:ss, or h:mm:ss past an hour — the shape Discord renders a timer in. */
function formatClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const pad = (n: number) => String(n).padStart(2, "0");
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}`
    : `${minutes}:${pad(seconds % 60)}`;
}

function PresenceCard({
  draft,
  accent,
  liveStart,
}: {
  draft: PresenceDraft;
  accent: string;
  liveStart: number | null;
}) {
  const verb = verbFor(draft.type);
  const color = normalizeHex(draft.color);
  // Whatever Discord will actually fetch: your photo, else the colour swatch.
  // Fetched from this same origin so the preview renders before it is published.
  const artwork = draft.largeImage.trim() || (color ? swatchPath(color) : "");
  const ticking = draft.timestampMode !== "none";
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!ticking) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [ticking]);

  const elapsed = liveStart ? (now - liveStart) / 1000 : 0;
  const timer =
    draft.timestampMode === "elapsed"
      ? `${formatClock(elapsed)} elapsed`
      : draft.timestampMode === "remaining"
        ? `${formatClock(draft.durationMinutes * 60)} left`
        : null;
  const party =
    draft.partyMax > 0 && draft.partyCurrent > 0
      ? ` (${draft.partyCurrent} of ${draft.partyMax})`
      : "";

  return (
    <div className="mt-4 border-t border-border pt-5">
      <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
        {verb}
      </p>
      <div className="mt-3 flex gap-3">
        <div className="relative shrink-0">
          <div
            className="flex size-16 items-center justify-center overflow-hidden rounded-xl border border-border text-2xl"
            style={{ backgroundColor: `color-mix(in oklch, ${accent} 22%, transparent)` }}
          >
            {artwork ? (
              <img
                src={artwork}
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
          <p className="truncate text-sm font-semibold">𝒁𝒐𝒓𝒂 𝑺𝒕𝒖𝒅𝒊𝒐 ✦</p>
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
          {timer && (
            <p className="text-xs text-muted-foreground/80">
              {timer}
              {draft.timestampMode === "elapsed" && !liveStart ? " · starts when you go live" : ""}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
