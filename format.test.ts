import { describe, expect, it } from "vitest";

import {
  formatClock,
  formatCount,
  formatDuration,
  formatEntryLines,
  formatRelative,
  kindLabel,
  mostUrgentWindow,
  probeDetailLines,
  probeSummaryLine,
  statusTone,
  windowDisplayName,
} from "./format";
import {
  makeProbeSnapshot,
  makeRateLimitPayload,
  type RateLimitEntry,
  type RateLimitWindow,
} from "./shared";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("formatDuration", () => {
  it("renders compact units", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(522)).toBe("522ms");
    expect(formatDuration(8_520)).toBe("8.5s");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(12 * MINUTE)).toBe("12m");
    expect(formatDuration(90 * MINUTE)).toBe("1h30m");
    expect(formatDuration(23 * HOUR + 59 * MINUTE)).toBe("23h59m");
    expect(formatDuration(3 * DAY)).toBe("3d");
    expect(formatDuration(3 * DAY + 4 * HOUR)).toBe("3d4h");
  });

  it("never renders negative durations", () => {
    expect(formatDuration(-5_000)).toBe("5s");
  });
});

describe("formatRelative", () => {
  const now = 1_000_000;
  it("uses in for the future", () => {
    expect(formatRelative(now + 12 * MINUTE, now)).toBe("in 12m");
  });
  it("uses ago for the past", () => {
    expect(formatRelative(now - 3 * MINUTE, now)).toBe("3m ago");
  });
});

describe("windowDisplayName", () => {
  it("prefers label, then provider key, then a fallback", () => {
    expect(
      windowDisplayName({ providerKey: "k", label: "5h window", status: "allowed", resetsAtMs: null }),
    ).toBe("5h window");
    expect(
      windowDisplayName({ providerKey: "k", label: null, status: "allowed", resetsAtMs: null }),
    ).toBe("k");
    expect(
      windowDisplayName({ providerKey: null, label: null, status: "allowed", resetsAtMs: null }),
    ).toBe("rate-limit window");
  });
});

describe("kindLabel", () => {
  it("humanizes kinds", () => {
    expect(kindLabel("subscription-window")).toBe("Subscription window");
    expect(kindLabel("spend-control")).toBe("Spend control");
    expect(kindLabel("credits")).toBe("Credits");
  });
});

describe("statusTone", () => {
  it("maps statuses to tones", () => {
    expect(statusTone("allowed")).toBe("good");
    expect(statusTone("warning")).toBe("warn");
    expect(statusTone("blocked")).toBe("bad");
    expect(statusTone("unknown")).toBe("neutral");
  });
});

describe("mostUrgentWindow", () => {
  const now = 1_000_000;
  const window = (overrides: Partial<RateLimitWindow>): RateLimitWindow => ({
    providerKey: null,
    label: null,
    status: "allowed",
    resetsAtMs: null,
    ...overrides,
  });

  it("prefers blocked over warning over allowed", () => {
    const entry: RateLimitEntry = {
      ...makeRateLimitPayload(),
      observedAt: now,
      threadId: "th_1",
      windows: [
        window({ label: "allowed window", status: "allowed", resetsAtMs: now + HOUR }),
        window({ label: "blocked window", status: "blocked", resetsAtMs: now + 2 * HOUR }),
        window({ label: "warning window", status: "warning", resetsAtMs: now + 3 * HOUR }),
      ],
    };
    expect(mostUrgentWindow(entry, now)?.label).toBe("blocked window");
  });

  it("among equal statuses prefers the soonest reset", () => {
    const entry: RateLimitEntry = {
      ...makeRateLimitPayload(),
      observedAt: now,
      threadId: "th_1",
      windows: [
        window({ label: "far", status: "warning", resetsAtMs: now + 3 * HOUR }),
        window({ label: "soon", status: "warning", resetsAtMs: now + 10 * MINUTE }),
      ],
    };
    expect(mostUrgentWindow(entry, now)?.label).toBe("soon");
  });

  it("returns null without windows", () => {
    const entry: RateLimitEntry = {
      ...makeRateLimitPayload(),
      observedAt: now,
      threadId: "th_1",
      windows: [],
    };
    expect(mostUrgentWindow(entry, now)).toBeNull();
  });
});

describe("formatClock", () => {
  it("renders a local hour:minute", () => {
    const clock = formatClock(new Date("2026-01-02T14:32:00").getTime());
    expect(clock).toMatch(/^\d{1,2}:\d{2}(\s?[AP]M)?$/i);
  });
});

describe("formatEntryLines", () => {
  const now = 1_000_000;
  it("renders a provider block with windows and reasons", () => {
    const entry: RateLimitEntry = {
      ...makeRateLimitPayload({
        status: "warning",
        reachedReason: "Approaching your 5h limit",
        windows: [
          { providerKey: "5h", label: null, status: "warning", resetsAtMs: now + 12 * MINUTE },
          { providerKey: "7d", label: null, status: "allowed", resetsAtMs: null },
        ],
      }),
      observedAt: now - MINUTE,
      threadId: "th_1",
    };
    const lines = formatEntryLines(entry, now);
    expect(lines[0]).toBe("claude-code  warning · Subscription window");
    expect(lines).toContain("  5h: warning, resets in 12m");
    expect(lines).toContain("  7d: allowed, no reset reported");
    expect(lines).toContain("  reached: Approaching your 5h limit");
  });

  it("notes when no windows were reported", () => {
    const entry: RateLimitEntry = {
      ...makeRateLimitPayload({ windows: [] }),
      observedAt: now,
      threadId: "th_1",
    };
    expect(formatEntryLines(entry, now)).toContain("  no windows reported");
  });
});

describe("formatCount", () => {
  it("renders compact counts", () => {
    expect(formatCount(858_000)).toBe("858K");
    expect(formatCount(1_000_000)).toBe("1M");
    expect(formatCount(1_300_000)).toBe("1.3M");
    expect(formatCount(42)).toBe("42");
    expect(formatCount(null)).toBe("—");
  });
});

describe("probeSummaryLine", () => {
  const now = 1_000_000;
  it("renders the OpenCode-footer style line with numbers", () => {
    expect(
      probeSummaryLine(
        makeProbeSnapshot({
          observedAt: now,
          resetRequestsAtMs: now + 8_520,
          resetTokensAtMs: now + 90_000,
        }),
        now,
      ),
    ).toBe("599/600 req · 858K/1M tok · resets in 8.5s");
  });

  it("omits missing parts", () => {
    expect(
      probeSummaryLine(
        makeProbeSnapshot({
          limitTokens: null,
          remainingTokens: null,
          resetTokensAtMs: null,
          resetRequestsAtMs: null,
          observedAt: now,
        }),
        now,
      ),
    ).toBe("599/600 req");
    expect(
      probeSummaryLine(
        makeProbeSnapshot({
          limitRequests: null,
          remainingRequests: null,
          resetRequestsAtMs: null,
          limitTokens: null,
          remainingTokens: null,
          resetTokensAtMs: null,
          observedAt: now,
        }),
        now,
      ),
    ).toBeNull();
  });

  it("surfaces probe failures", () => {
    expect(
      probeSummaryLine(makeProbeSnapshot({ error: "HTTP 429" }), now),
    ).toBe("probe failed (HTTP 429)");
  });
});

describe("probeDetailLines", () => {
  const now = 1_000_000;
  it("renders requests and tokens with resets", () => {
    const lines = probeDetailLines(
      makeProbeSnapshot({
        observedAt: now - 10_000,
        resetRequestsAtMs: now + 8_520,
        resetTokensAtMs: now + 80_000,
      }),
      now,
    );
    expect(lines[0]).toBe(
      "Endpoint probe · scaleway/glm-5.3 · updated 10s ago",
    );
    expect(lines).toContain(
      "  requests: 599/600, resets in 8.5s",
    );
    expect(lines).toContain(
      "  tokens: 858K/1M, resets in 1m20s",
    );
  });

  it("renders the error alone on failure", () => {
    const lines = probeDetailLines(
      makeProbeSnapshot({ error: "HTTP 500", observedAt: now }),
      now,
    );
    expect(lines).toEqual([
      "Endpoint probe · scaleway/glm-5.3 · updated 0s ago",
      "  error: HTTP 500",
    ]);
  });
});
