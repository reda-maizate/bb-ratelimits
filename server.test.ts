import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createFakePluginHost,
  makeThreadResponse,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";

import plugin from "./server";
import {
  makeRateLimitPayload,
  type ProbeSnapshot,
  type RateLimitEntry,
  type RateLimitStatus,
} from "./shared";

type EntriesOutput = {
  entries: RateLimitEntry[];
  probe: ProbeSnapshot | null;
  probeHint: { short: string | null; long: string | null } | null;
};
type SegmentOutput = {
  providerId: string | null;
  entry: RateLimitEntry | null;
  probe: ProbeSnapshot | null;
  probeHint: { short: string | null; long: string | null } | null;
  probePending: boolean;
};

/** A rate-limit event row as `threads.events.list` returns it. */
function rateRow(overrides: {
  threadId: string;
  createdAt: number;
  providerId?: string;
  status?: RateLimitStatus;
}) {
  return {
    id: `ev_${overrides.createdAt}`,
    scope: { kind: "thread" as const },
    seq: overrides.createdAt,
    type: "provider/rateLimits/updated" as const,
    threadId: overrides.threadId,
    createdAt: overrides.createdAt,
    data: {
      providerThreadId: `pt_${overrides.threadId}`,
      rateLimits: makeRateLimitPayload({
        providerId: overrides.providerId ?? "claude-code",
        ...(overrides.status === undefined ? {} : { status: overrides.status }),
      }),
    },
  };
}

/** A `turn/completed` event row as `threads.events.list` returns it. */
function turnRow(overrides: { threadId: string; createdAt: number }) {
  return {
    id: `ev_${overrides.createdAt}`,
    scope: { kind: "thread" as const },
    seq: overrides.createdAt,
    type: "turn/completed" as const,
    threadId: overrides.threadId,
    createdAt: overrides.createdAt,
    data: {
      clientRequestId: "req_1",
      providerThreadId: null,
      status: "completed" as const,
      threadId: overrides.threadId,
      type: "turn/completed" as const,
    },
  };
}

/** An `item/completed` event row — one spent provider request mid-turn. */
function itemRow(overrides: { threadId: string; createdAt: number }) {
  return {
    id: `ev_${overrides.createdAt}`,
    scope: { kind: "thread" as const },
    seq: overrides.createdAt,
    type: "item/completed" as const,
    threadId: overrides.threadId,
    createdAt: overrides.createdAt,
    data: { threadId: overrides.threadId },
  };
}

/** Poll until a condition holds; fails the test on timeout. */
async function waitFor(
  condition: () => boolean | Promise<boolean>,
  what: string,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function callEntries(host: FakePluginHost): Promise<EntriesOutput> {
  const result = await host.harness.behavior.callRpc("entries");
  return result as EntriesOutput;
}

async function callSegment(
  host: FakePluginHost,
  threadId: string,
  model?: string,
): Promise<SegmentOutput> {
  const result = await host.harness.behavior.callRpc("segment", {
    threadId,
    ...(model === undefined ? {} : { model }),
  });
  return result as SegmentOutput;
}

interface Fixture {
  host: FakePluginHost;
  rowsByThread: Map<string, unknown[]>;
  threads: Map<string, string>; // threadId → providerId
}

interface FixtureOptions {
  settings?: Record<string, string>;
}

async function makeFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const rowsByThread = new Map<string, unknown[]>();
  const threads = new Map<string, string>([
    ["th_1", "claude-code"],
    ["th_2", "codex"],
  ]);
  const host = createFakePluginHost({
    pluginId: "rate-limits",
    settings: options.settings,
    sdk: {
      threads: {
        events: {
          list: async (args: { threadId: string }) =>
            rowsByThread.get(args.threadId) ?? [],
        },
        get: async (args: { threadId: string }) =>
          makeThreadResponse({
            id: args.threadId,
            providerId: threads.get(args.threadId) ?? "claude-code",
          }),
        list: async () =>
          [...threads.keys()].map((id) =>
            makeThreadResponse({ id, providerId: threads.get(id)! }),
          ),
      },
    },
  });
  await plugin(host.bb);
  return { host, rowsByThread, threads };
}

const fixtures: FakePluginHost[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  while (fixtures.length > 0) {
    const host = fixtures.pop()!;
    await host.harness.lifecycle.dispose();
  }
});

async function freshFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const fixture = await makeFixture(options);
  fixtures.push(fixture.host);
  return fixture;
}

/** A fixture whose endpoint probe resolves, with a stubbed fetch. */
async function probingFixture(
  headers: Record<string, string> = {},
  responseStatus = 200,
  settings: Record<string, string> = {},
): Promise<Fixture & { fetchMock: ReturnType<typeof vi.fn> }> {
  const fetchMock = vi.fn(
    async () =>
      new Response("{}", { status: responseStatus, headers }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const fixture = await freshFixture({
    settings: {
      apiKey: "test-key",
      ...settings,
    },
  });
  return { ...fixture, fetchMock };
}

describe("rate-limits plugin", () => {
  it("starts with no entries", async () => {
    const { host } = await freshFixture();
    expect((await callEntries(host)).entries).toEqual([]);
  });

  it("captures rate-limit events from thread activity", async () => {
    const { host, rowsByThread } = await freshFixture();
    rowsByThread.set("th_1", [rateRow({ threadId: "th_1", createdAt: 5_000 })]);

    const { errors } = await host.harness.behavior.emitThreadEvent(
      "experimental_thread.events",
      { thread: makeThreadResponse({ id: "th_1" }), sequence: 5 },
    );
    expect(errors).toEqual([]);

    const { entries } = await callEntries(host);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.providerId).toBe("claude-code");
    expect(entries[0]?.observedAt).toBe(5_000);
    expect(entries[0]?.threadId).toBe("th_1");

    // The ingest read the thread's newest rate-limit events, filtered by type.
    const listArgs = host.harness.inspection.sdk.callsTo(
      "threads.events.list",
    )[0]?.[0] as Record<string, unknown>;
    expect(listArgs.types).toEqual([
      "provider/rateLimits/updated",
      "turn/completed",
      "item/completed",
    ]);
    expect(listArgs.order).toBe("desc");

    // The change was broadcast so open surfaces refetch.
    expect(
      host.harness.inspection.realtimeSignals.some(
        (signal) => signal.channel === "rate-limits-changed",
      ),
    ).toBe(true);
  });

  it("does not broadcast on a identical re-observation", async () => {
    const { host, rowsByThread } = await freshFixture();
    rowsByThread.set("th_1", [rateRow({ threadId: "th_1", createdAt: 5_000 })]);
    await host.harness.behavior.emitThreadEvent("experimental_thread.events", {
      thread: makeThreadResponse({ id: "th_1" }),
      sequence: 5,
    });
    const before = host.harness.inspection.realtimeSignals.length;
    await host.harness.behavior.emitThreadEvent("experimental_thread.events", {
      thread: makeThreadResponse({ id: "th_1" }),
      sequence: 6,
    });
    expect(host.harness.inspection.realtimeSignals.length).toBe(before);
  });

  it("serves the entry for a thread's provider via segment", async () => {
    const { host, rowsByThread } = await freshFixture();
    rowsByThread.set("th_2", [
      rateRow({ threadId: "th_2", createdAt: 5_000, providerId: "codex" }),
    ]);
    await host.harness.behavior.emitThreadEvent("experimental_thread.events", {
      thread: makeThreadResponse({ id: "th_2" }),
      sequence: 3,
    });

    const withData = await callSegment(host, "th_2");
    expect(withData.providerId).toBe("codex");
    expect(withData.entry?.providerId).toBe("codex");

    // th_1 runs claude-code, which has not reported anything yet.
    const withoutData = await callSegment(host, "th_1");
    expect(withoutData.providerId).toBe("claude-code");
    expect(withoutData.entry).toBeNull();
  });

  it("reconciles recent threads on service start", async () => {
    const { host, rowsByThread } = await freshFixture();
    rowsByThread.set("th_1", [rateRow({ threadId: "th_1", createdAt: 5_000 })]);
    rowsByThread.set("th_2", [
      rateRow({ threadId: "th_2", createdAt: 6_000, providerId: "codex" }),
    ]);

    const service = host.harness.behavior.runService("reconcile");
    await waitFor(
      () => host.harness.inspection.sdk.callsTo("threads.list").length >= 1,
      "reconcile sweep",
    );
    await waitFor(
      async () => (await callEntries(host)).entries.length === 2,
      "both providers captured",
    );
    service.controller.abort();
    await service.done;
  });

  it("persists entries so a reload keeps them", async () => {
    const { host, rowsByThread } = await freshFixture();
    rowsByThread.set("th_1", [rateRow({ threadId: "th_1", createdAt: 5_000 })]);
    await host.harness.behavior.emitThreadEvent("experimental_thread.events", {
      thread: makeThreadResponse({ id: "th_1" }),
      sequence: 5,
    });
    expect((await callEntries(host)).entries).toHaveLength(1);

    // reload() runs the factory on a fresh host and returns it; the old
    // host is disposed and its handles go stale.
    const reloaded = await host.harness.lifecycle.reload(plugin);
    fixtures[fixtures.indexOf(host)] = reloaded;
    expect((await callEntries(reloaded)).entries).toHaveLength(1);
  });

  it("prints status text and json from the CLI", async () => {
    const { host, rowsByThread } = await freshFixture();
    rowsByThread.set("th_1", [
      rateRow({ threadId: "th_1", createdAt: 5_000, status: "warning" }),
    ]);
    await host.harness.behavior.emitThreadEvent("experimental_thread.events", {
      thread: makeThreadResponse({ id: "th_1" }),
      sequence: 5,
    });

    const text = await host.harness.behavior.runCli(["status"]);
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("claude-code");
    expect(text.stdout).toContain("warning");

    const json = await host.harness.behavior.runCli(["status", "--json"]);
    expect(json.exitCode).toBe(0);
    const parsed = JSON.parse(json.stdout) as EntriesOutput;
    expect(parsed.entries).toHaveLength(1);

    const empty = await host.harness.behavior.runCli(["nonsense"]);
    expect(empty.exitCode).toBe(1);
  });

  it("renders an empty-state message before any provider reports", async () => {
    const { host } = await freshFixture();
    const result = await host.harness.behavior.runCli(["status"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No provider rate limits observed yet");
  });

  describe("endpoint probe", () => {
    const RATE_HEADERS: Record<string, string> = {
      "x-ratelimit-limit-requests": "600",
      "x-ratelimit-remaining-requests": "599",
      "x-ratelimit-reset-requests": "8s522ms",
      "x-ratelimit-limit-tokens": "1000000",
      "x-ratelimit-remaining-tokens": "858000",
      "x-ratelimit-reset-tokens": "1m30s",
    };

    it("resolves the endpoint from the active model and probes", async () => {
      const { host, fetchMock } = await probingFixture(RATE_HEADERS);

      await callSegment(host, "th_1", "scaleway/glm-5.3");
      await waitFor(
        async () => (await callSegment(host, "th_1")).probe !== null,
        "probe snapshot",
      );
      expect(fetchMock.mock.calls.length).toBe(1);

      // The model's provider prefix resolved the endpoint; the namespaced
      // id was stripped to the API model.
      const [url, request] = fetchMock.mock.calls[0] as [
        string,
        RequestInit & { headers: Record<string, string> },
      ];
      expect(url).toBe("https://api.scaleway.ai/v1/chat/completions");
      expect(request.method).toBe("POST");
      expect(request.headers.authorization).toBe("Bearer test-key");
      expect(JSON.parse(String(request.body))).toEqual({
        model: "glm-5.3",
        messages: [{ role: "user", content: "1" }],
        max_tokens: 1,
      });

      const probe = (await callSegment(host, "th_1", "scaleway/glm-5.3")).probe;
      expect(probe?.model).toBe("scaleway/glm-5.3");
      expect(probe?.error).toBeNull();
      expect(probe?.limitRequests).toBe(600);
      expect(probe?.remainingRequests).toBe(599);
      expect(probe?.limitTokens).toBe(1_000_000);
      expect(probe?.remainingTokens).toBe(858_000);
      // Reset durations anchor to the observation instant.
      expect(probe?.resetRequestsAtMs! - probe?.observedAt!).toBe(8_522);
      expect(probe?.resetTokensAtMs! - probe?.observedAt!).toBe(90_000);

      // The page's RPC carries the probe too, and the change was broadcast.
      expect((await callEntries(host)).probe?.remainingRequests).toBe(599);
      expect(
        host.harness.inspection.realtimeSignals.some(
          (signal) => signal.channel === "rate-limits-changed",
        ),
      ).toBe(true);
    });

    it("falls back to the provider's environment variable", async () => {
      vi.stubEnv("SCALEWAY_API_KEY", "env-key");
      const { host, fetchMock } = await probingFixture(RATE_HEADERS, 200, {
        apiKey: "",
      });

      await callSegment(host, "th_1", "scaleway/glm-5.3");
      await waitFor(
        async () => (await callSegment(host, "th_1")).probe !== null,
        "probe snapshot",
      );
      const [, request] = fetchMock.mock.calls[0] as [
        string,
        RequestInit & { headers: Record<string, string> },
      ];
      expect(request.headers.authorization).toBe("Bearer env-key");
    });

    it("hints instead of probing when the key is missing", async () => {
      const { host, fetchMock } = await probingFixture(RATE_HEADERS, 200, {
        apiKey: "",
      });

      const segment = await callSegment(host, "th_1", "scaleway/glm-5.3");
      expect(segment.probe).toBeNull();
      expect(segment.probePending).toBe(false);
      expect(segment.probeHint?.short).toContain("API key");
      expect(segment.probeHint?.long).toContain(
        "bb plugin config rate-limits set apiKey",
      );
      // Give any stray probe path time to run; none may fire.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(fetchMock.mock.calls.length).toBe(0);
    });

    it("hints for model prefixes that name no known provider", async () => {
      const { host, fetchMock } = await probingFixture(RATE_HEADERS);

      const segment = await callSegment(host, "th_1", "scw/glm-5.3");
      expect(segment.probeHint?.short).toContain("unknown provider");
      expect(segment.probeHint?.long).toContain("baseUrl");
      expect(fetchMock.mock.calls.length).toBe(0);
    });

    it("probes a custom base URL when the setting names one", async () => {
      const { host, fetchMock } = await probingFixture(RATE_HEADERS, 200, {
        baseUrl: "https://api.example.com/v1",
      });

      await callSegment(host, "th_1", "glm-5.3");
      await waitFor(
        async () => (await callSegment(host, "th_1")).probe !== null,
        "probe snapshot",
      );
      const [url, request] = fetchMock.mock.calls[0] as [
        string,
        RequestInit & { headers: Record<string, string> },
      ];
      expect(url).toBe("https://api.example.com/v1/chat/completions");
      // No namespaced model: the id is sent as-is.
      expect(JSON.parse(String(request.body)).model).toBe("glm-5.3");
    });

    it("refreshes immediately when the active model changes", async () => {
      const { host, fetchMock } = await probingFixture(RATE_HEADERS);

      await callSegment(host, "th_1", "scaleway/glm-5.3");
      await waitFor(
        async () => (await callSegment(host, "th_1")).probe !== null,
        "first probe",
      );

      // A different model switches the target without waiting for the
      // cooldown; the new snapshot replaces the old one.
      await callSegment(host, "th_1", "scaleway/deepseek-v4.1-flash");
      await waitFor(
        async () =>
          (await callSegment(host, "th_1")).probe?.model ===
          "scaleway/deepseek-v4.1-flash",
        "second probe",
      );
      expect(fetchMock.mock.calls.length).toBe(2);
      const [, secondRequest] = fetchMock.mock.calls[1] as [
        string,
        RequestInit,
      ];
      expect(JSON.parse(String(secondRequest.body)).model).toBe(
        "deepseek-v4.1-flash",
      );
    });

    it("leaves a fresh snapshot alone while a turn only streams", async () => {
      const { host, fetchMock, rowsByThread } = await probingFixture(
        RATE_HEADERS,
      );

      await callSegment(host, "th_1", "scaleway/glm-5.3");
      await waitFor(
        async () => (await callSegment(host, "th_1")).probe !== null,
        "first probe",
      );
      expect(fetchMock.mock.calls.length).toBe(1);

      // Streaming deltas are not request completions, and the snapshot
      // already covers the active model: nothing is due, and with no
      // timers there is nothing left to fire a probe.
      rowsByThread.set("th_1", [
        {
          id: "ev_delta",
          scope: { kind: "thread" as const },
          seq: 99,
          type: "item/agentMessage/delta" as const,
          threadId: "th_1",
          createdAt: Date.now(),
          data: {},
        },
      ]);
      await host.harness.behavior.emitThreadEvent(
        "experimental_thread.events",
        { thread: makeThreadResponse({ id: "th_1" }), sequence: 5 },
      );
      await callSegment(host, "th_1", "scaleway/glm-5.3");
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(fetchMock.mock.calls.length).toBe(1);
    });

    it("probes after each completed item mid-turn", async () => {
      const { host, fetchMock, rowsByThread } = await probingFixture(
        RATE_HEADERS,
      );

      await callSegment(host, "th_1", "scaleway/glm-5.3");
      await waitFor(
        async () => (await callSegment(host, "th_1")).probe !== null,
        "first probe",
      );
      expect(fetchMock.mock.calls.length).toBe(1);

      // A finished agent message or tool result spent a provider request,
      // even before the turn completes: the probe fires right away. (+1:
      // keep the marker in a strictly later millisecond than the snapshot.)
      rowsByThread.set("th_1", [
        itemRow({ threadId: "th_1", createdAt: Date.now() + 1 }),
      ]);
      await host.harness.behavior.emitThreadEvent(
        "experimental_thread.events",
        { thread: makeThreadResponse({ id: "th_1" }), sequence: 5 },
      );
      await waitFor(
        async () => fetchMock.mock.calls.length === 2,
        "item-triggered probe",
      );
    });

    it("probes right away when a turn completes", async () => {
      const { host, fetchMock, rowsByThread } = await probingFixture(
        RATE_HEADERS,
      );

      await callSegment(host, "th_1", "scaleway/glm-5.3");
      await waitFor(
        async () => (await callSegment(host, "th_1")).probe !== null,
        "first probe",
      );
      expect(fetchMock.mock.calls.length).toBe(1);

      // A completed turn just spent the account's requests: the next
      // activity burst refreshes the numbers immediately — no cooldown
      // exists to wait out. (+1: the snapshot and this marker must not
      // share a millisecond — Date.now() has ms resolution and a real
      // request always completes in a later ms than an earlier probe.)
      rowsByThread.set("th_1", [
        turnRow({ threadId: "th_1", createdAt: Date.now() + 1 }),
      ]);
      await host.harness.behavior.emitThreadEvent(
        "experimental_thread.events",
        { thread: makeThreadResponse({ id: "th_1" }), sequence: 5 },
      );
      await waitFor(
        async () => fetchMock.mock.calls.length === 2,
        "turn-triggered probe",
      );
    });

    it("captures probe failures without breaking anything", async () => {
      const fetchMock = vi.fn(async () => {
        throw new Error("network down");
      });
      vi.stubGlobal("fetch", fetchMock);
      const { host } = await freshFixture({ settings: { apiKey: "test-key" } });

      await callSegment(host, "th_1", "scaleway/glm-5.3");
      await waitFor(
        async () => (await callSegment(host, "th_1")).probe !== null,
        "failure snapshot",
      );
      const probe = (await callSegment(host, "th_1")).probe;
      expect(probe?.error).toContain("network down");
      expect(probe?.remainingRequests).toBeNull();
    });

    it("records an HTTP failure when the endpoint sends no headers", async () => {
      const { host } = await probingFixture({}, 500);

      await callSegment(host, "th_1", "scaleway/glm-5.3");
      await waitFor(
        async () => (await callSegment(host, "th_1")).probe !== null,
        "failure snapshot",
      );
      const probe = (await callSegment(host, "th_1")).probe;
      expect(probe?.error).toBe("HTTP 500");
      expect(probe?.remainingRequests).toBeNull();
    });

    it("keeps numbers from a 429 that carries rate-limit headers", async () => {
      const { host } = await probingFixture(RATE_HEADERS, 429);

      await callSegment(host, "th_1", "scaleway/glm-5.3");
      await waitFor(
        async () => (await callSegment(host, "th_1")).probe !== null,
        "probe snapshot",
      );
      const probe = (await callSegment(host, "th_1")).probe;
      expect(probe?.error).toBeNull();
      expect(probe?.remainingRequests).toBe(599);
    });

    it("CLI probe forces a fresh probe for a model", async () => {
      const { host } = await probingFixture(RATE_HEADERS);

      const text = await host.harness.behavior.runCli([
        "probe",
        "--model",
        "scaleway/glm-5.3",
      ]);
      expect(text.exitCode).toBe(0);
      expect(text.stdout).toContain("Endpoint probe · scaleway/glm-5.3");
      expect(text.stdout).toContain("599/600");
      expect(text.stdout).toContain("858K/1M");

      const json = await host.harness.behavior.runCli([
        "probe",
        "--model",
        "scaleway/glm-5.3",
        "--json",
      ]);
      expect(json.exitCode).toBe(0);
      const parsed = JSON.parse(json.stdout) as { probe: ProbeSnapshot };
      expect(parsed.probe.remainingRequests).toBe(599);
      expect(parsed.probe.model).toBe("scaleway/glm-5.3");
    });

    it("CLI probe exits with guidance when it cannot probe", async () => {
      const noModel = await freshFixture();
      const result = await noModel.host.harness.behavior.runCli(["probe"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("No active model yet");

      const { host } = await probingFixture(RATE_HEADERS, 200, { apiKey: "" });
      const missingKey = await host.harness.behavior.runCli([
        "probe",
        "--model",
        "scaleway/glm-5.3",
      ]);
      expect(missingKey.exitCode).toBe(1);
      expect(missingKey.stderr).toContain(
        "bb plugin config rate-limits set apiKey",
      );
    });

    it("CLI status includes the probe block and its model", async () => {
      const { host } = await probingFixture(RATE_HEADERS);
      await host.harness.behavior.runCli([
        "probe",
        "--model",
        "scaleway/glm-5.3",
      ]);

      const result = await host.harness.behavior.runCli(["status"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Endpoint probe · scaleway/glm-5.3");
      expect(result.stdout).toContain("599/600");
    });

    it("clears the stale snapshot when settings stop resolving", async () => {
      const { host, fetchMock } = await probingFixture(RATE_HEADERS);
      await callSegment(host, "th_1", "scaleway/glm-5.3");
      await waitFor(
        async () => (await callEntries(host)).probe !== null,
        "probe landed",
      );

      await host.harness.behavior.setSettings({ apiKey: "" });
      await waitFor(
        async () => (await callEntries(host)).probe === null,
        "probe cleared",
      );
      expect((await callEntries(host)).probeHint?.short).toContain("API key");
      expect(fetchMock.mock.calls.length).toBe(1);
    });
  });

  it("registers the RPC methods and the CLI command it serves", async () => {
    const { host } = await freshFixture();
    const methods = host.harness.inspection.registrations.rpcMethods;
    expect(methods).toContain("entries");
    expect(methods).toContain("segment");
    const cli = host.harness.inspection.registrations.cli;
    expect(cli?.name).toBe("rate-limits");
  });
});
