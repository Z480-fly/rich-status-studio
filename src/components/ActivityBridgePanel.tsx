import { useEffect, useState } from "react";
import {
  ACTIVITY_BRIDGE_APPS,
  createActivityBridgeToken,
  deleteActivityBridgeHistory,
  getActivityBridgeSettings,
  saveActivityBridgeSettings,
  type ActivityBridgeApp,
  type ActivityBridgeSettings,
  type ActivityBridgeVisibility,
} from "@/lib/activity-bridge.functions";
import { PUBLIC_SITE_ORIGIN } from "@/lib/site";

type PanelStatus = { kind: "idle" | "busy" | "ok" | "error"; message: string };

const DEFAULT_SETTINGS: ActivityBridgeSettings = {
  enabled: false,
  visibility: "friends",
  sharedApps: [],
};

export function ActivityBridgePanel() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<PanelStatus>({ kind: "idle", message: "" });
  const [shortcutToken, setShortcutToken] = useState<string | null>(null);

  useEffect(() => {
    getActivityBridgeSettings({ data: undefined })
      .then(setSettings)
      .catch((error) => {
        setStatus({ kind: "error", message: error instanceof Error ? error.message : "Could not load settings." });
      })
      .finally(() => setLoading(false));
  }, []);

  const updateSettings = (next: ActivityBridgeSettings) => {
    setSettings(next);
    setStatus({ kind: "busy", message: "Saving…" });
    void saveActivityBridgeSettings({ data: next })
      .then((saved) => {
        setSettings(saved);
        setStatus({ kind: "ok", message: "Activity sharing settings saved." });
      })
      .catch((error) => {
        setStatus({ kind: "error", message: error instanceof Error ? error.message : "Could not save settings." });
      });
  };

  const toggleApp = (app: ActivityBridgeApp) => {
    const sharedApps = settings.sharedApps.includes(app)
      ? settings.sharedApps.filter((item) => item !== app)
      : [...settings.sharedApps, app];
    updateSettings({ ...settings, sharedApps });
  };

  const generateToken = async () => {
    setStatus({ kind: "busy", message: "Creating a private Shortcut token…" });
    try {
      const result = await createActivityBridgeToken({ data: undefined });
      setShortcutToken(result.token);
      setStatus({ kind: "ok", message: "Token created. Copy it now; it is only shown once." });
    } catch (error) {
      setStatus({ kind: "error", message: error instanceof Error ? error.message : "Could not create token." });
    }
  };

  const deleteHistory = async () => {
    if (!window.confirm("Delete your Activity Bridge history?")) return;
    setStatus({ kind: "busy", message: "Deleting activity history…" });
    try {
      await deleteActivityBridgeHistory({ data: undefined });
      setStatus({ kind: "ok", message: "Activity history deleted." });
    } catch (error) {
      setStatus({ kind: "error", message: error instanceof Error ? error.message : "Could not delete history." });
    }
  };

  return (
    <section className="panel mt-8 p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Activity Bridge</h2>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">
            Let Zora share selected iPhone activity with your Zora friends. This is opt-in and uses
            Apple Shortcuts automations — Zora cannot watch apps silently from a web app.
          </p>
        </div>
        <label className="inline-flex min-h-11 items-center gap-3 rounded-xl border border-border bg-secondary px-3 py-2 text-sm font-semibold">
          <span>{settings.enabled ? "On" : "Off"}</span>
          <input
            type="checkbox"
            checked={settings.enabled}
            disabled={loading || status.kind === "busy"}
            onChange={(event) => updateSettings({ ...settings, enabled: event.target.checked })}
            className="size-5 accent-primary"
          />
        </label>
      </div>

      <div className="mt-5 rounded-xl border border-border bg-background/50 p-4">
        <h3 className="text-sm font-semibold text-foreground">Apps you share</h3>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {ACTIVITY_BRIDGE_APPS.map((app) => (
            <label
              key={app.name}
              className="flex min-h-11 items-center gap-2 rounded-lg border border-border bg-secondary/60 px-3 py-2 text-sm"
            >
              <input
                type="checkbox"
                checked={settings.sharedApps.includes(app.name)}
                disabled={!settings.enabled || loading || status.kind === "busy"}
                onChange={() => toggleApp(app.name)}
                className="size-4 accent-primary"
              />
              <span>{app.emoji}</span>
              <span>{app.name}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="mt-4">
        <h3 className="text-sm font-semibold text-foreground">Who can see it?</h3>
        <div className="mt-2 flex flex-wrap gap-2">
          {(["everyone", "friends", "nobody"] as ActivityBridgeVisibility[]).map((visibility) => (
            <button
              key={visibility}
              type="button"
              disabled={loading || status.kind === "busy"}
              onClick={() => updateSettings({ ...settings, visibility })}
              className={`min-h-11 rounded-xl border px-4 py-2 text-sm font-semibold capitalize ${
                settings.visibility === visibility
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-secondary text-muted-foreground hover:bg-accent"
              }`}
            >
              {visibility}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-5 rounded-xl border border-dashed border-border bg-background/50 p-4 text-sm text-muted-foreground">
        <h3 className="font-semibold text-foreground">Set up iPhone Shortcuts</h3>
        <ol className="mt-2 list-decimal space-y-2 pl-5">
          <li>Turn Activity Bridge on and choose the apps to share.</li>
          <li>Create an App automation in Shortcuts for each selected app.</li>
          <li>Use the app’s “Is Opened” trigger to send an opened event.</li>
          <li>Use “Is Closed” to send a closed event.</li>
          <li>In each automation, use Shortcuts’ “Get Contents of URL” action with the Zora event endpoint.</li>
        </ol>
        <p className="mt-3 text-xs">
          Shortcuts must be configured by you on the iPhone. Zora never installs automations or
          collects app activity unless you enable sharing and send these events.
        </p>
        <button
          type="button"
          onClick={() => void generateToken()}
          disabled={!settings.enabled || status.kind === "busy"}
          className="mt-4 min-h-11 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-60"
        >
          Generate private Shortcut token
        </button>
        {shortcutToken && (
          <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
            <p className="text-xs font-semibold text-foreground">Copy this token into Shortcuts now</p>
            <code className="mt-1 block break-all text-xs text-foreground">{shortcutToken}</code>
            <p className="mt-2 text-xs">It will not be shown again. Generate a new one if it is lost.</p>
            <p className="mt-2 break-all text-xs">
              Endpoint: {PUBLIC_SITE_ORIGIN}/api/public/activity-bridge/event
            </p>
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className={`text-sm ${status.kind === "error" ? "text-destructive" : "text-muted-foreground"}`}>
          {status.message}
        </p>
        <button
          type="button"
          onClick={() => void deleteHistory()}
          disabled={status.kind === "busy"}
          className="min-h-11 rounded-xl border border-destructive/40 px-4 py-2 text-sm font-semibold text-destructive hover:bg-destructive/10 disabled:opacity-60"
        >
          Delete activity history
        </button>
      </div>
    </section>
  );
}
