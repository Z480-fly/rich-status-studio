import { useRef, useState } from "react";
import { fileToResizedDataUrl } from "@/lib/image";
import { uploadPresenceImage } from "@/lib/presets.functions";
import { getAccessToken } from "@/lib/discord-client";

export function ImagePicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [localPreview, setLocalPreview] = useState("");

  const preview = localPreview || value;

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setError("");
    setBusy(true);
    const previousValue = value;
    try {
      const dataUrl = await fileToResizedDataUrl(file);
      setLocalPreview(dataUrl);

      const accessToken = getAccessToken();
      if (!accessToken) {
        throw new Error("Connect to Discord first — photos are stored against your account.");
      }

      const { url } = await uploadPresenceImage({ data: { accessToken, dataUrl } });
      onChange(url);
      setLocalPreview("");
    } catch (e) {
      setLocalPreview("");
      onChange(previousValue);
      setError(e instanceof Error ? e.message : "That photo couldn't be uploaded.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="block">
      <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
        {label}
      </span>

      <div className="mt-2 flex items-start gap-3">
        <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border bg-input text-xl">
          {preview ? (
            <img src={preview} alt="" className="size-full object-cover" />
          ) : (
            <span aria-hidden>🖼️</span>
          )}
        </div>

        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={busy}
              className="min-h-11 rounded-lg border border-border bg-secondary px-3 py-2 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-60"
            >
              {busy ? "Uploading…" : preview ? "Replace photo" : "Choose from Photos"}
            </button>
            {preview && (
              <button
                type="button"
                onClick={() => {
                  onChange("");
                  setLocalPreview("");
                  setError("");
                }}
                disabled={busy}
                className="min-h-11 rounded-lg border border-border px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
              >
                Remove
              </button>
            )}
          </div>

          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => void handleFile(e.target.files?.[0])}
          />

          <input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="…or paste an image URL"
            inputMode="url"
            className="field min-h-11 truncate focus:field-focus"
          />

          {error && <p className="break-words text-xs text-destructive">{error}</p>}
        </div>
      </div>
    </div>
  );
}
