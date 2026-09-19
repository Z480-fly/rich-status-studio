import type { PresenceDraft } from "./presence";

const KEY = "presence-studio:draft";

export interface StoredState {
  presetId: string;
  draft: PresenceDraft;
}

export function loadStoredState(): StoredState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredState;
    if (!parsed?.draft) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveStoredState(state: StoredState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* storage can be full or blocked — the app still works without it */
  }
}
