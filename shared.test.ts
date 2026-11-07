import { describe, expect, it } from "vitest";

import {
  applyRateLimitRows,
  entryFromRow,
  makeRateLimitPayload,
  makeProbeSnapshot,
  makeRateLimitRow,
  modelShortName,
  newestRequestMarkerAt,
  parseDurationMs,
  parseEntryList,
  parseHeaderInt,
  parseProbeSnapshot,
  parseRateLimitRows,
  probeSnapshotFromHeaders,
  probeStatusOf,
  resolutionHints,
  resolveEndpoint,
  sortEntries,
  worseStatus,
  type RateLimitEntry,
} from "./shared";

const payload = makeRateLimitPayload();

function entry(overrides: Partial<RateLimitEntry> = {}): RateLimitEntry {
  return {
    ...payload,
    observedAt: 1_000,
    threadId: "th_1",
    ...overrides,
  };
}

describe("entryFromRow", () => {
  it("maps an event row to an entry with observation facts", () => {
    const row = makeRateLimitRow({
      threadId: "th_9",
      createdAt: 5_000,
      data: { rateLimits: makeRateLimitPayload({ providerId: "codex" }) },
    });
    expect(entryFromRow(row)).toEqual({
      ...makeRateLimitPayload({ providerId: "codex" }),
      observedAt: 5_000,
      threadId: "th_9",
    });
  });
});

describe("applyRateLimitRows", () => {
  it("adds new providers and reports them changed", () => {
    const store = new Map<string, RateLimitEntry>();
    const result = applyRateLimitRows(store, [
      makeRateLimitRow({ createdAt: 1_000 }),
    ]);
    expect(result.changed.map((e) => e.providerId)).toEqual(["claude-code"]);
    expect(store.get("claude-code")?.observedAt).toBe(1_000);
  });

  it("keeps the newest observation when rows arrive unordered", () => {
    const store = new Map<string, RateLimitEntry>();
    const result = applyRateLimitRows(store, [
      makeRateLimitRow({
        createdAt: 1_000,
        data: {
          rateLimits: makeRateLimitPayload({ status: "allowed" }),
        },
      }),
      makeRateLimitRow({
        createdAt: 2_000,
        data: {
          rateLimits: makeRateLimitPayload({ status: "warning" }),
        },
      }),
    ]);
    // Rows are applied newest first: the 2_000 observation lands, and the
    // older 1_000 row is skipped as stale rather than regressing it.
    expect(result.changed).toHaveLength(1);
    expect(result.changed[0]?.status).toBe("warning");
    expect(store.get("claude-code")?.status).toBe("warning");
    expect(store.get("claude-code")?.observedAt).toBe(2_000);
  });

  it("ignores an older observation than the store already holds", () => {
    const store = new Map<string, RateLimitEntry>([
      ["claude-code", entry({ observedAt: 5_000, status: "warning" })],
    ]);
    const result = applyRateLimitRows(store, [
      makeRateLimitRow({
        createdAt: 2_000,
        data: {
          rateLimits: makeRateLimitPayload({ status: "blocked" }),
        },
      }),
    ]);
    expect(result.changed).toHaveLength(0);
    expect(store.get("claude-code")?.status).toBe("warning");
  });

  it("refreshes recency without a change when the state repeats", () => {
    const store = new Map<string, RateLimitEntry>([
      ["claude-code", entry({ observedAt: 1_000 })],
    ]);
    const result = applyRateLimitRows(store, [
      makeRateLimitRow({ createdAt: 2_000 }),
    ]);
    expect(result.changed).toHaveLength(0);
    expect(result.refreshed).toBe(true);
    expect(store.get("claude-code")?.observedAt).toBe(2_000);
  });

  it("does nothing for an identical re-delivery", () => {
    const store = new Map<string, RateLimitEntry>([
      ["claude-code", entry({ observedAt: 1_000 })],
    ]);
    const result = applyRateLimitRows(store, [
      makeRateLimitRow({ createdAt: 1_000 }),
    ]);
    expect(result.changed).toHaveLength(0);
    expect(result.refreshed).toBe(false);
  });

  it("tracks each provider independently", () => {
    const store = new Map<string, RateLimitEntry>();
    applyRateLimitRows(store, [
      makeRateLimitRow({
        createdAt: 1_000,
        data: { rateLimits: makeRateLimitPayload({ providerId: "claude-code" }) },
      }),
      makeRateLimitRow({
        createdAt: 2_000,
        data: { rateLimits: makeRateLimitPayload({ providerId: "codex" }) },
      }),
    ]);
    expect([...store.keys()].sort()).toEqual(["claude-code", "codex"]);
  });
});

describe("parseEntryList", () => {
  it("accepts a valid list", () => {
    expect(parseEntryList([entry()])).toHaveLength(1);
  });

  it("drops malformed values entirely", () => {
    expect(parseEntryList([{ providerId: "x" }])).toHaveLength(0);
    expect(parseEntryList("nope")).toHaveLength(0);
    expect(parseEntryList(null)).toHaveLength(0);
  });
});

describe("parseRateLimitRows", () => {
  it("keeps rate-limit rows and strips extra row keys", () => {
    const rows = parseRateLimitRows([
      {
        id: "ev_1",
        scope: { kind: "thread" },
        seq: 7,
        type: "provider/rateLimits/updated",
        threadId: "th_1",
        createdAt: 3_000,
        data: { providerThreadId: "pt_1", rateLimits: payload },
      },
    ]);
    expect(rows).toEqual([
      {
        type: "provider/rateLimits/updated",
        threadId: "th_1",
        createdAt: 3_000,
        data: { rateLimits: payload },
      },
    ]);
  });

  it("drops rows of other event types", () => {
    const rows = parseRateLimitRows([
      { type: "thread/started", threadId: "th_1", createdAt: 1, data: {} },
    ]);
    expect(rows).toHaveLength(0);
  });

  it("keeps valid rows when foreign ones ride along in the same list", () => {
    const rows = parseRateLimitRows([
      { type: "turn/completed", threadId: "th_1", createdAt: 2, data: {} },
      makeRateLimitRow({ createdAt: 3_000 }),
      { type: "nonsense", threadId: "th_1", createdAt: 4, data: {} },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.createdAt).toBe(3_000);
  });
});

describe("newestRequestMarkerAt", () => {
  const row = (type: string, createdAt: number) => ({
    type,
    threadId: "th_1",
    createdAt,
    data: {},
  });

  it("finds the newest request completion — items and turns", () => {
    expect(
      newestRequestMarkerAt([
        makeRateLimitRow({ createdAt: 5_000 }),
        row("turn/completed", 2_000),
        row("item/completed", 4_000),
        row("item/completed", 7_000),
      ]),
    ).toBe(7_000);
  });

  it("returns null without a request completion", () => {
    expect(newestRequestMarkerAt([makeRateLimitRow()])).toBeNull();
    // Streaming deltas are not request completions.
    expect(
      newestRequestMarkerAt([row("item/agentMessage/delta", 3_000)]),
    ).toBeNull();
    expect(newestRequestMarkerAt("nope")).toBeNull();
  });
});

describe("sortEntries", () => {
  it("sorts most recently observed first", () => {
    expect(
      sortEntries([
        entry({ providerId: "old", observedAt: 1 }),
        entry({ providerId: "new", observedAt: 9 }),
      ]).map((e) => e.providerId),
    ).toEqual(["new", "old"]);
  });
});

describe("parseHeaderInt", () => {
  it("parses integers and rejects the rest", () => {
    expect(parseHeaderInt("600")).toBe(600);
    expect(parseHeaderInt(" 600 ")).toBe(600); // parseInt tolerates padding
    expect(parseHeaderInt("8s")).toBeNull();
    expect(parseHeaderInt("")).toBeNull();
    expect(parseHeaderInt(null)).toBeNull();
  });
});

describe("parseDurationMs", () => {
  it("parses compound durations like Scaleway sends", () => {
    expect(parseDurationMs("8s522ms")).toBe(8_522);
    expect(parseDurationMs("1m")).toBe(60_000);
    expect(parseDurationMs("2h")).toBe(7_200_000);
  });
  it("treats bare numbers as seconds", () => {
    expect(parseDurationMs("120")).toBe(120_000);
  });
  it("is null for garbage and missing", () => {
    expect(parseDurationMs("soon")).toBeNull();
    expect(parseDurationMs(null)).toBeNull();
  });
});

describe("probeSnapshotFromHeaders", () => {
  it("reads the six OpenAI-compatible x-ratelimit headers", () => {
    const snapshot = probeSnapshotFromHeaders(
      (name) =>
        ({
          "x-ratelimit-limit-requests": "600",
          "x-ratelimit-remaining-requests": "599",
          "x-ratelimit-reset-requests": "8s522ms",
          "x-ratelimit-limit-tokens": "1000000",
          "x-ratelimit-remaining-tokens": "999999",
          "x-ratelimit-reset-tokens": "1m",
        })[name] ?? null,
      5_000,
      "scaleway/glm-5.3",
    );
    // Reset durations ("8s522ms") are anchored to the observation time.
    expect(snapshot).toEqual(makeProbeSnapshot({
      remainingRequests: 599,
      resetRequestsAtMs: 13_522,
      limitTokens: 1_000_000,
      remainingTokens: 999_999,
      resetTokensAtMs: 65_000,
      observedAt: 5_000,
    }));
  });

  it("leaves missing headers null and records no error", () => {
    const snapshot = probeSnapshotFromHeaders(() => null, 5_000, "openai/gpt-5.2");
    expect(snapshot).toEqual({
      model: "openai/gpt-5.2",
      limitRequests: null,
      remainingRequests: null,
      resetRequestsAtMs: null,
      limitTokens: null,
      remainingTokens: null,
      resetTokensAtMs: null,
      observedAt: 5_000,
      error: null,
    });
  });
});

describe("probeStatusOf", () => {
  it("is blocked when a remaining value hits zero", () => {
    expect(probeStatusOf(makeProbeSnapshot({ remainingRequests: 0 }))).toBe("blocked");
    expect(probeStatusOf(makeProbeSnapshot({ remainingTokens: 0 }))).toBe("blocked");
  });

  it("is warning under 20% remaining", () => {
    expect(probeStatusOf(makeProbeSnapshot({ remainingRequests: 100 }))).toBe("warning");
    expect(
      probeStatusOf(makeProbeSnapshot({ remainingRequests: 599, remainingTokens: 150_000 })),
    ).toBe("warning");
  });

  it("is allowed with headroom", () => {
    expect(probeStatusOf(makeProbeSnapshot())).toBe("allowed");
  });

  it("is unknown without numbers", () => {
    const bare = makeProbeSnapshot({
      limitRequests: null,
      remainingRequests: null,
      limitTokens: null,
      remainingTokens: null,
    });
    expect(probeStatusOf(bare)).toBe("unknown");
  });
});

describe("worseStatus", () => {
  it("picks the more severe status", () => {
    expect(worseStatus("allowed", "warning")).toBe("warning");
    expect(worseStatus("blocked", "warning")).toBe("blocked");
    expect(worseStatus("allowed", "allowed")).toBe("allowed");
    expect(worseStatus("unknown", "allowed")).toBe("unknown");
  });
});

describe("parseProbeSnapshot", () => {
  it("accepts a snapshot and rejects garbage", () => {
    expect(parseProbeSnapshot(makeProbeSnapshot())).not.toBeNull();
    expect(parseProbeSnapshot({ observedAt: 1 })).toBeNull();
    expect(parseProbeSnapshot("nope")).toBeNull();
  });
});

describe("resolveEndpoint", () => {
  const noEnv = () => undefined;

  it("resolves the endpoint from the model's provider prefix", () => {
    const result = resolveEndpoint({
      model: "scaleway/glm-5.3",
      baseUrlSetting: "",
      apiKeySetting: "key",
      env: noEnv,
    });
    expect(result).toEqual({
      kind: "endpoint",
      baseUrl: "https://api.scaleway.ai/v1",
      apiKey: "key",
      apiModel: "glm-5.3",
      profileKey: "scaleway",
      label: "Scaleway",
    });
  });

  it("keeps deeper model ids intact (openrouter/anthropic/…)", () => {
    const result = resolveEndpoint({
      model: "openrouter/anthropic/claude-sonnet-4.5",
      baseUrlSetting: "",
      apiKeySetting: "key",
      env: noEnv,
    });
    expect(result).toMatchObject({ apiModel: "anthropic/claude-sonnet-4.5" });
  });

  it("accepts a provider name or a full URL in the baseUrl setting", () => {
    expect(
      resolveEndpoint({
        model: "llama-4-maverick",
        baseUrlSetting: "groq",
        apiKeySetting: "key",
        env: noEnv,
      }),
    ).toMatchObject({ baseUrl: "https://api.groq.com/openai/v1" });
    expect(
      resolveEndpoint({
        model: "glm-5.3",
        baseUrlSetting: "https://api.example.com/v1/",
        apiKeySetting: "key",
        env: noEnv,
      }),
    ).toMatchObject({ baseUrl: "https://api.example.com/v1", apiModel: "glm-5.3" });
  });

  it("falls back to the provider's environment variable", () => {
    expect(
      resolveEndpoint({
        model: "scaleway/glm-5.3",
        baseUrlSetting: "",
        apiKeySetting: undefined,
        env: (name) => (name === "SCW_API_KEY" ? "env-key" : undefined),
      }),
    ).toMatchObject({ apiKey: "env-key" });
    // All of Scaleway's conventional variable names work.
    expect(
      resolveEndpoint({
        model: "scaleway/glm-5.3",
        baseUrlSetting: "",
        apiKeySetting: undefined,
        env: (name) => (name === "SCW_SECRET_KEY" ? "secret-key" : undefined),
      }),
    ).toMatchObject({ apiKey: "secret-key" });
    // Settings win over the environment.
    expect(
      resolveEndpoint({
        model: "scaleway/glm-5.3",
        baseUrlSetting: "",
        apiKeySetting: "setting-key",
        env: () => "env-key",
      }),
    ).toMatchObject({ apiKey: "setting-key" });
  });

  it("reports a missing key, unknown provider, or nothing to infer", () => {
    expect(
      resolveEndpoint({
        model: "scaleway/glm-5.3",
        baseUrlSetting: "",
        apiKeySetting: undefined,
        env: noEnv,
      }).kind,
    ).toBe("missing-key");
    expect(
      resolveEndpoint({
        model: "scw/glm-5.3",
        baseUrlSetting: "",
        apiKeySetting: "key",
        env: noEnv,
      }),
    ).toEqual({ kind: "unknown-provider", providerName: "scw" });
    expect(
      resolveEndpoint({
        model: "claude-sonnet-4-5",
        baseUrlSetting: "",
        apiKeySetting: "key",
        env: noEnv,
      }).kind,
    ).toBe("unconfigured");
    expect(
      resolveEndpoint({
        model: null,
        baseUrlSetting: "",
        apiKeySetting: "key",
        env: noEnv,
      }).kind,
    ).toBe("no-model");
  });
});

describe("resolutionHints", () => {
  it("guides the missing-key and unknown-provider cases", () => {
    const missingKey = resolutionHints({
      kind: "missing-key",
      baseUrl: "https://api.scaleway.ai/v1",
      envVars: ["SCALEWAY_API_KEY", "SCW_API_KEY"],
      label: "Scaleway",
    });
    expect(missingKey?.short).toContain("API key");
    expect(missingKey?.long).toContain("bb plugin config rate-limits set apiKey");

    const unknown = resolutionHints({ kind: "unknown-provider", providerName: "scw" });
    expect(unknown?.long).toContain("baseUrl");

    expect(resolutionHints({ kind: "no-model" })).toBeNull();
    expect(resolutionHints({ kind: "unconfigured" })).toBeNull();
    expect(
      resolutionHints({
        kind: "endpoint",
        baseUrl: "https://api.scaleway.ai/v1",
        apiKey: "k",
        apiModel: "glm-5.3",
        profileKey: "scaleway",
        label: "Scaleway",
      }),
    ).toBeNull();
  });
});

describe("modelShortName", () => {
  it("strips known provider prefixes and keeps the rest", () => {
    expect(modelShortName("scaleway/glm-5.3")).toBe("glm-5.3");
    expect(modelShortName("openrouter/anthropic/claude-sonnet-4.5")).toBe(
      "anthropic/claude-sonnet-4.5",
    );
    expect(modelShortName("scw/glm-5.3")).toBe("scw/glm-5.3");
    expect(modelShortName("claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
    expect(modelShortName(null)).toBeNull();
  });
});
