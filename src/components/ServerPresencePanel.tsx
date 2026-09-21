import { useCallback, useEffect, useRef, useState } from "react";
import type { PresenceDraft } from "@/lib/presence";
import { buildActivityPayload } from "@/lib/presence";
import {
  getDiscordLinkUrl,
  getServerPresenceStatus,
  startServerPresence,
  stopServerPresence,
  updateServerPresence,
  type Json,
  type ServerPresenceStatus,
} from "@/lib/server-presence.functions";

/**
 * Controller UI for the server-side ("keep it running after I leave") presence.
 *
 * The browser never touches OAuth secrets here — it only asks the server for a
 * Discord authorize link and writes the desired state. The Linux worker picks
 * that state up through /api/public/worker/poll and drives the real presence.
 */

const POLL_MS = 15_000;

type Status = { kind: "idle" | "busy" | "ok" | "error"; message: string };

function asRecord(value: Json | null): Record<string, Json> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, Json>;
}

function str(value: Json | undefined): string {
  return typeof value === "string" ? value : "";
}

const TYPE_VERBS: Record<number, string> = {
  0: "Playing",
  1: "Streaming",
  2: "Listening to",
  3: "Watching",
  5: "Competing in",
};

/** Human summary of the stored activity, e.g. "Playing — 🎵 Listening to Music". */
export function describeActivity(activity: Json | null): string | null {
  const record = asRecord(activity);
  if (!record) return null;
  const type = typeof record["type"] === "number" ? record["type"] : 0;
  const verb = TYPE_VERBS[type] ?? "Playing";
  const details = str(record["details"]);
  const state = str(record["state"]);
  const headline = details || state || "Custom activity";
  return `${verb} — ${headline}`;
}

const WORKER_STATE_STYLES: Record<string, { dot: string; label: string }> = {
  running: { dot: "bg-primary animate-pulse", label: "Live on your profile" },
  connecting: { dot: "bg-amber-500 animate-pulse", label: "Worker connecting…" },
  cleared: { dot: "bg-muted-foreground", label: "Cleared" },
  error: { dot: "bg-destructive", label: "Worker error" },
  idle: { dot: "bg-muted-foreground", label: "Idle" },
};

function seenLabel(secondsAgo: number | null): string | null {
  if (secondsAgo == null) return null;
  if (secondsAgo < 15) return "just now";
  if (secondsAgo < 90) return `${secondsAgo}s ago`;
  const minutes = Math.round(secondsAgo / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

export function ServerPresencePanel({ draft }: { draft: PresenceDraft }) {
  const [status, setStatus] = useState<ServerPresenceStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Status>({ kind: "idle", message: "" });
  const [showJson, setShowJson] = useState(false);
  const [customJson, setCustomJson] = useState("");
  const [seenTick, setSeenTick] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Surface the OAuth callback result (?link=ok|error) and clean the URL.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const link = params.get("link");
    if (!link) return;
    if (link === "ok") {
      setMessage({ kind: "ok", message: "Discord account linked. You can start server presence now." });
    } else {
      const reason = params.get("reason");
      setMessage({
        kind: "error",
        message: reason ? `Discord linking failed: ${reason}` : "Discord linking failed.",
      });
    }
    params.delete("link");
    params.delete("reason");
    const query = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await getServerPresenceStatus();
      if (mounted.current) setStatus(next);
    } catch {
      /* transient network/server errors — the next poll will retry */
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const poll = setInterval(() => {
      setSeenTick((t) => t + 1);
      void refresh();
    }, POLL_MS);
    return () => clearInterval(poll);
  }, [refresh]);

  const begin = (text: string) => {
    setBusy(true);
    setMessage({ kind: "busy", message: text });
  };

  const finish = (kind: "ok" | "error", text: string) => {
    setBusy(false);
    setMessage({ kind, message: text });
  };

  const describe = (error: unknown, fallback: string): string => {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === "string" && error) return error;
    return fallback;
  };

  const payloadFromDraft = () => {
    // buildActivityPayload only emits strings/numbers/arrays — Json-compatible by construction.
    return buildActivityPayload(draft) as unknown as Record<string, Json>;
  };

  const handleLink = async () => {
    begin("Asking Discord for a link…");
    try {
      const { url } = await getDiscordLinkUrl();
      window.location.href = url; // full navigation: Discord redirects back to /api/public/discord/callback
    } catch (error) {
      finish("error", describe(error, "Could not start Discord linking."));
    }
  };

  const handleStart = async () => {
    begin("Publishing to the worker…");
    try {
      await startServerPresence({ data: { activity: payloadFromDraft() } });
      await refresh();
      finish("ok", "Requested. The worker will apply it within seconds.");
    } catch (error) {
      finish("error", describe(error, "Could not start server presence."));
    }
  };

  const handleUpdate = async () => {
    begin("Updating…");
    try {
      await updateServerPresence({ data: { activity: payloadFromDraft() } });
      await refresh();
      finish("ok", "Update queued.");
    } catch (error) {
      finish("error", describe(error, "Could not update presence."));
    }
  };

  const handleCustomJson = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(customJson);
    } catch {
      finish("error", "That isn't valid JSON.");
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      finish("error", "The activity must be a JSON object.");
      return;
    }
    begin("Applying custom activity…");
    try {
      await updateServerPresence({ data: { activity: parsed as Record<string, Json> } });
      await refresh();
      finish("ok", "Custom activity queued.");
    } catch (error) {
      finish("error", describe(error, "Could not apply the custom activity."));
    }
  };

  const handleStop = async () => {
    begin("Stopping…");
    try {
      await stopServerPresence();
      await refresh();
      finish("ok", "Stopped. The worker will clear your profile shortly.");
    } catch (error) {
      finish("error", describe(error, "Could not stop presence."));
    }
  };

  const openCustomJson = () => {
    const payload = asRecord(status?.activity ?? null);
    setCustomJson(JSON.stringify(payload ?? payloadFromDraft(), null, 2));
    setShowJson(true);
  };

  const linked = !!status?.linked;
  const running = status?.desiredState === "running";
  const worker = status?.workerState ?? "idle";
  const style = WORKER_STATE_STYLES[worker] ?? WORKER_STATE_STYLES["idle"]!;
  const seen = seenLabel(status?.workerSeenSecondsAgo ?? null);
  const activityLine = describeActivity(status?.activity ?? null);

  return (
    <section className="panel p-5 sm:p-6" data-refresh={seenTick}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Server presence</h2>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">
            Link your Discord account once, then run a status straight from this page — it keeps
            running on our server even after you close the app.
          </p>
        </div>
        <span
          className={`inline-flex items-center gap-2 rounded-full border border-border bg-secondary px-3 py-1.5 text-xs font-medium text-muted-foreground`}
        >
          <span className={`size-2 rounded-full ${style.dot}`} />
          {loading ? "Checking…" : style.label}
        </span>
      </div>

      {message.message && (
        <p
          className={`mt-3 text-sm ${
            message.kind === "error"
              ? "text-destructive"
              : message.kind === "ok"
                ? "text-primary"
                : "text-muted-foreground"
          }`}
        >
          {message.message}
        </p>
      )}

      {loading ? (
        <p className="mt-4 text-sm text-muted-foreground">Checking your Discord link…</p>
      ) : !linked ? (
        <div className="mt-4">
          <button
            type="button"
            onClick={() => void handleLink()}
            disabled={busy}
            className="w-full rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60 sm:w-auto"
          >
            Link Discord account
          </button>
          <p className="mt-2 text-xs text-muted-foreground">
            Official Discord OAuth2. You'll be asked to authorize this app with the Social SDK
            presence scope.
          </p>
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <div className="grid gap-2 text-sm sm:grid-cols-2">
            <p className="text-muted-foreground">
              <span className="font-medium text-foreground">{status?.username ?? "Your account"}</span>
              {" · "}
              {running ? (
                <>
                  want: <span className="text-primary">running</span>
                </>
              ) : (
                <>want: stopped</>
              )}
            </p>
            <p className="text-muted-foreground">
              Worker: <span className="font-medium text-foreground">{worker}</span>
              {seen && <> · seen {seen}</>}
            </p>
          </div>

          {running && activityLine && (
            <p className="text-sm text-muted-foreground">
              Now: <span className="text-foreground">{activityLine}</span>
              {status?.workerMessage && <> · {status.workerMessage}</>}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            {running ? (
              <button
                type="button"
                onClick={() => void handleUpdate()}
                disabled={busy}
                className="min-h-11 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                Push current preset
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void handleStart()}
                disabled={busy}
                className="min-h-11 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                Start from current preset
              </button>
            )}
            <button
              type="button"
              onClick={openCustomJson}
              disabled={busy}
              className="min-h-11 rounded-xl border border-border bg-secondary px-4 py-2.5 text-sm font-semibold transition-colors hover:bg-accent disabled:opacity-60"
            >
              Custom JSON…
            </button>
            {running && (
              <button
                type="button"
                onClick={() => void handleStop()}
                disabled={busy}
                className="min-h-11 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-2.5 text-sm font-semibold text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-60"
              >
                Stop
              </button>
            )}
          </div>

          {showJson && (
            <div className="rounded-xl border border-border bg-background/70 p-3">
              <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                Raw activity (fields Discord honours: name, type, details, state, timestamps,
                assets, party)
              </p>
              <textarea
                value={customJson}
                onChange={(e) => setCustomJson(e.target.value)}
                rows={10}
                spellCheck={false}
                className="field mt-2 w-full font-mono text-xs focus:field-focus"
              />
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => void handleCustomJson()}
                  disabled={busy}
                  className="min-h-10 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
                >
                  Apply
                </button>
                <button
                  type="button"
                  onClick={() => setShowJson(false)}
                  className="min-h-10 rounded-lg border border-border bg-secondary px-4 py-2 text-sm font-semibold transition-colors hover:bg-accent"
                >
                  Close
                </button>
              </div>
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            Requires the Linux worker to be running and connected with the shared secret. Worker
            problems show up here as state/error lines.
          </p>
        </div>
      )}
    </section>
  );
}
