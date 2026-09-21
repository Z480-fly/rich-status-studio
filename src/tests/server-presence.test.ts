import { describe, expect, it } from "vitest";
import { ACTIVITY_TYPES, PRESETS, buildActivityPayload, emptyDraft, type PresenceDraft } from "@/lib/presence";
import { describeActivity } from "@/components/ServerPresencePanel";

function draft(overrides: Partial<PresenceDraft> = {}): PresenceDraft {
  return { ...emptyDraft, ...overrides };
}

describe("buildActivityPayload", () => {
  it("always sends the activity type, and nothing else for an empty draft", () => {
    // The default draft runs an elapsed timer, so silence it to isolate the type.
    expect(buildActivityPayload(draft({ timestampMode: "none" }))).toEqual({ type: 0 });
  });

  it("sends the type even when every other field is empty", () => {
    const payload = buildActivityPayload(
      draft({ timestampMode: "none", type: 3, details: "", state: "" }),
    );
    expect(payload["type"]).toBe(3);
    expect(Object.keys(payload)).toEqual(["type"]);
  });

  it("sends the custom activity name only when set, trimmed", () => {
    expect("name" in buildActivityPayload(draft({ name: "   " }))).toBe(false);
    expect(buildActivityPayload(draft({ name: "  Zora FM  " }))["name"]).toBe("Zora FM");
  });

  it("keeps the name alongside the rest of the activity", () => {
    const payload = buildActivityPayload(
      draft({ name: "Zora FM", details: "🎵 Listening to Music", type: 2 }),
    );
    expect(payload).toMatchObject({
      name: "Zora FM",
      type: 2,
      details: "🎵 Listening to Music",
    });
  });

  it("includes details and state only when non-empty", () => {
    const payload = buildActivityPayload(draft({ details: "  Hello  ", state: "  " }));
    expect(payload["details"]).toBe("Hello");
    expect("state" in payload).toBe(false);
  });

  it("builds assets only from non-empty fields", () => {
    const payload = buildActivityPayload(
      draft({ largeImage: "https://x/y.png", largeText: "Big", smallText: "Small" }),
    );
    expect(payload["assets"]).toEqual({
      large_image: "https://x/y.png",
      large_text: "Big",
      small_text: "Small",
    });
  });

  it("omits assets entirely when nothing is set", () => {
    expect("assets" in buildActivityPayload(draft())).toBe(false);
  });

  it("count-up timer sets only start", () => {
    const before = Date.now();
    const payload = buildActivityPayload(draft({ timestampMode: "elapsed" })) as {
      timestamps: { start: number; end?: number };
    };
    expect(payload.timestamps.start).toBeGreaterThanOrEqual(before);
    expect(payload.timestamps.end).toBeUndefined();
  });

  it("count-down timer sets start and end", () => {
    const before = Date.now();
    const payload = buildActivityPayload(
      draft({ timestampMode: "remaining", durationMinutes: 30 }),
    ) as { timestamps: { start: number; end: number } };
    expect(payload.timestamps.end - payload.timestamps.start).toBe(30 * 60_000);
    expect(payload.timestamps.start).toBeGreaterThanOrEqual(before);
  });

  it("party size is included only when both values are positive", () => {
    expect("party" in buildActivityPayload(draft({ partyCurrent: 3, partyMax: 0 }))).toBe(false);
    expect("party" in buildActivityPayload(draft({ partyCurrent: 0, partyMax: 5 }))).toBe(false);
    expect(buildActivityPayload(draft({ partyCurrent: 3, partyMax: 5 }))["party"]).toEqual({
      size: [3, 5],
    });
  });

  it("produces Json-compatible values only (strings, numbers, arrays, objects)", () => {
    const payload = buildActivityPayload(
      draft({
        details: "x",
        state: "y",
        largeImage: "https://x/y.png",
        timestampMode: "remaining",
        partyCurrent: 1,
        partyMax: 2,
      }),
    );
    expect(() => JSON.parse(JSON.stringify(payload))).not.toThrow();
    expect(Object.keys(payload).sort()).toEqual(["assets", "details", "party", "state", "timestamps", "type"]);
  });
});

describe("presets", () => {
  it("cover the requested set", () => {
    expect(PRESETS.map((p) => p.id)).toEqual([
      "music",
      "minecraft",
      "youtube",
      "instagram",
      "tiktok",
      "gaming",
      "watching",
      "listening",
      "chilling",
      "custom",
    ]);
  });

  it("all activity types come from the supported list", () => {
    for (const preset of PRESETS) {
      expect(ACTIVITY_TYPES.map((t) => t.value)).toContain(preset.draft.type);
    }
  });
});

describe("describeActivity (panel summary)", () => {
  it("renders the verb and headline", () => {
    expect(
      describeActivity({ type: 2, details: "🎵 Listening to Music" }),
    ).toBe("Listening to — 🎵 Listening to Music");
  });

  it("falls back to state, then a generic label", () => {
    expect(describeActivity({ type: 0, state: "AFK" })).toBe("Playing — AFK");
    expect(describeActivity({ type: 3 })).toBe("Watching — Custom activity");
    expect(describeActivity(null)).toBeNull();
  });
});
