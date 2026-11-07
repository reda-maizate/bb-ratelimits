// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

import type { RateLimitEntry } from "./shared";
import { makeProbeSnapshot, makeRateLimitPayload } from "./shared";

// Relative to real now so the component's ticking clock agrees with fixtures.
const REAL_NOW = Date.now();

const FIXTURE_ENTRY: RateLimitEntry = {
  ...makeRateLimitPayload({
    providerId: "claude-code",
    status: "warning",
    reachedReason: null,
    windows: [
      {
        providerKey: "5h",
        label: "5h window",
        status: "warning",
        resetsAtMs: REAL_NOW + 12 * 60_000,
      },
      {
        providerKey: "7d",
        label: "7d window",
        status: "allowed",
        resetsAtMs: REAL_NOW + 3 * 24 * 60 * 60_000,
      },
    ],
  }),
  observedAt: REAL_NOW - 30_000,
  threadId: "th_1",
};

const FIXTURE_PROBE = makeProbeSnapshot({
  remainingRequests: 599,
  limitRequests: 600,
  resetRequestsAtMs: REAL_NOW + 8_520,
  remainingTokens: 858_000,
  limitTokens: 1_000_000,
  resetTokensAtMs: REAL_NOW + 90_000,
  observedAt: REAL_NOW - 5_000,
});

const SEGMENT_PROPS = {
  threadId: "th_1",
  projectId: "proj_1",
  environment: null,
  segments: [
    { key: "rate-limits/rate-limits", pluginId: "rate-limits" },
  ],
  isExpanded: false,
  onToggle: () => {},
};

describe("app surfaces", () => {
  it("registers the context segment and the nav panel", async () => {
    const app = await loadPluginApp(() => import("./app"));
    expect(app.navPanels).toHaveLength(1);
    expect(app.navPanels[0]?.title).toBe("Rate limits");
    expect(app.threadContextSegments).toHaveLength(1);
    expect(app.threadContextSegments[0]?.id).toBe("rate-limits");
  });

  it("renders provider cards on the Rate limits page", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      { component: app.navPanels[0]!.component },
      { subPath: "" },
      {
        rpc: {
          entries: () => ({ entries: [FIXTURE_ENTRY] }),
        },
      },
    );
    await slot.findByText("claude-code");
    expect(slot.getByText("5h window")).toBeTruthy();
    expect(slot.getByText("7d window")).toBeTruthy();
    expect(slot.getByText("warning").textContent).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("renders the empty state when nothing was reported", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      { component: app.navPanels[0]!.component },
      { subPath: "" },
      { rpc: { entries: () => ({ entries: [] }) } },
    );
    await slot.findByText(/No provider rate limits observed yet/);
    slot.lifecycle.unmount();
  });

  it("shows the thread's provider in the segment summary", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      { component: app.threadContextSegments[0]!.summary },
      { ...SEGMENT_PROPS, isExpanded: false },
      {
        rpc: {
          segment: () => ({
            providerId: "claude-code",
            entry: FIXTURE_ENTRY,
            probe: null,
            probeHint: null,
            probePending: false,
          }),
        },
      },
    );
    await slot.findByText(/Rate limits/);
    expect(slot.getByText(/warning/).textContent).toContain("warning");
    expect(slot.getByRole("button", { name: /rate limits/i })).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("expands every window with its reset", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const details = app.threadContextSegments[0]!.details;
    expect(details).toBeDefined();
    const slot = renderSlot(
      { component: details! },
      { ...SEGMENT_PROPS, isExpanded: true },
      {
        rpc: {
          segment: () => ({
            providerId: "claude-code",
            entry: FIXTURE_ENTRY,
            probe: null,
            probeHint: null,
            probePending: false,
          }),
        },
      },
    );
    await slot.findByText("5h window");
    // Resets render for both windows, relative + clock.
    expect(slot.getAllByText(/in 12m/).length).toBeGreaterThan(0);
    expect(slot.getAllByText(/in 3d/).length).toBeGreaterThan(0);
    expect(slot.getByText(/updated \d+s ago/)).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("renders nothing in the summary when the provider has no entry", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      { component: app.threadContextSegments[0]!.summary },
      { ...SEGMENT_PROPS, isExpanded: false },
      {
        rpc: {
          segment: () => ({
            providerId: "acp-opencode",
            entry: null,
            probe: null,
            probeHint: null,
            probePending: false,
          }),
        },
      },
    );
    // Give the pending RPC a tick to resolve.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(slot.container.textContent).toBe("");
    slot.lifecycle.unmount();
  });

  it("shows probe numbers in the summary even without a provider entry", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      { component: app.threadContextSegments[0]!.summary },
      { ...SEGMENT_PROPS, isExpanded: false },
      {
        composer: { selection: { model: "scaleway/glm-5.3" } },
        rpc: {
          segment: () => ({
            providerId: "acp-opencode",
            entry: null,
            probe: FIXTURE_PROBE,
            probeHint: null,
            probePending: false,
          }),
        },
      },
    );
    await slot.findByText(/Rate limits/);
    expect(slot.getByText(/599\/600 req/)).toBeTruthy();
    expect(slot.getByText(/858K\/1M tok/)).toBeTruthy();
    expect(slot.getByRole("button", { name: /rate limits/i })).toBeTruthy();
    // The dot reflects the probe's health, not a default unknown.
    expect(slot.getByRole("img", { name: "allowed" })).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("shows a pending note while probing a different model", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      { component: app.threadContextSegments[0]!.summary },
      { ...SEGMENT_PROPS, isExpanded: false },
      {
        composer: { selection: { model: "scaleway/deepseek-v4.1-flash" } },
        rpc: {
          segment: () => ({
            providerId: "acp-opencode",
            entry: null,
            probe: FIXTURE_PROBE,
            probeHint: null,
            probePending: true,
          }),
        },
      },
    );
    await slot.findByText(/Rate limits/);
    // The stale snapshot is for another model, so the summary says a probe
    // for the active one is on its way instead of showing wrong numbers.
    expect(slot.getByText(/probing deepseek-v4\.1-flash…/)).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("shows setup guidance when the endpoint cannot be resolved", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      { component: app.threadContextSegments[0]!.summary },
      { ...SEGMENT_PROPS, isExpanded: false },
      {
        composer: { selection: { model: "scaleway/glm-5.3" } },
        rpc: {
          segment: () => ({
            providerId: "acp-opencode",
            entry: null,
            probe: null,
            probeHint: {
              short: "no API key set for Scaleway",
              long: "Scaleway endpoint detected. Set the key with `bb plugin config rate-limits set apiKey <key>`.",
            },
            probePending: false,
          }),
        },
      },
    );
    await slot.findByText(/Rate limits/);
    expect(slot.getByText(/no API key set for Scaleway/)).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("expands both the probe numbers and the provider windows", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const details = app.threadContextSegments[0]!.details!;
    const slot = renderSlot(
      { component: details },
      { ...SEGMENT_PROPS, isExpanded: true },
      {
        rpc: {
          segment: () => ({
            providerId: "claude-code",
            entry: FIXTURE_ENTRY,
            probe: FIXTURE_PROBE,
            probeHint: null,
            probePending: false,
          }),
        },
      },
    );
    await slot.findByText("Endpoint probe · glm-5.3");
    expect(slot.getAllByText(/858K\/1M/).length).toBeGreaterThan(0);
    expect(slot.getByText("Requests")).toBeTruthy();
    expect(slot.getByText("Tokens")).toBeTruthy();
    expect(slot.getByText("5h window")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("renders the probe card on the Rate limits page", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      { component: app.navPanels[0]!.component },
      { subPath: "" },
      {
        rpc: {
          entries: () => ({
            entries: [],
            probe: FIXTURE_PROBE,
            probeHint: null,
          }),
        },
      },
    );
    await slot.findByText("Endpoint probe · glm-5.3");
    expect(slot.getAllByText(/858K\/1M/).length).toBeGreaterThan(0);
    // The provider empty state stays quiet while probe data is on screen.
    expect(slot.container.textContent).not.toContain(
      "No provider rate limits observed yet",
    );
    slot.lifecycle.unmount();
  });

  it("renders setup guidance on the Rate limits page", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      { component: app.navPanels[0]!.component },
      { subPath: "" },
      {
        rpc: {
          entries: () => ({
            entries: [],
            probe: null,
            probeHint: {
              short: "no API key set for Scaleway",
              long: "Scaleway endpoint detected. Set the key with `bb plugin config rate-limits set apiKey <key>`.",
            },
          }),
        },
      },
    );
    await slot.findByText(/Scaleway endpoint detected/);
    slot.lifecycle.unmount();
  });
});
