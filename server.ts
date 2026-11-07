// bb-plugin-rate-limits — the backend entry.
//
// Two data sources feed one display, both targeting the model the user is
// actually working with:
//
//   1. bb provider events — bridges (Claude Code, Codex, ACP, …) publish
//      `provider/rateLimits/updated` thread events while turns run. The
//      plugin listens for thread activity, reads each thread's newest
//      rate-limit events over the SDK, and keeps the latest state per
//      provider (state is account-scoped, so entries are shared across
//      threads).
//   2. endpoint probe — bb never sees the HTTP responses an ACP agent
//      process makes, so numeric OpenAI-compatible `x-ratelimit-*` headers
//      are captured by probing the endpoint the active model resolves to:
//      the model's provider prefix against a table of well-known providers
//      (Scaleway, OpenRouter, OpenAI, …), two optional settings, and the
//      provider's standard environment variable. No other tool's config
//      files are read.
//
// Both reach the frontend over RPC (the context segment above the composer
// and the Rate limits page), refresh open surfaces through a realtime
// signal, and are printed by `bb rate-limits status`.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { formatEntryLines, probeDetailLines } from "./format";
import {
  applyRateLimitRows,
  newestRequestMarkerAt,
  parseEntryList,
  parseProbeSnapshot,
  parseRateLimitRows,
  probeHasValues,
  probeSnapshotFromHeaders,
  probeSnapshotSchema,
  rateLimitEntrySchema,
  resolutionHints,
  resolveEndpoint,
  sortEntries,
  type EndpointResolution,
  type ProbeSnapshot,
  type RateLimitEntry,
} from "./shared";

/** Guidance for an endpoint that cannot be probed yet. */
const hintSchema = z
  .object({
    short: z.string().nullable(),
    long: z.string().nullable(),
  })
  .strict();

export const rpcContract = defineRpcContract({
  /** Every tracked provider's latest rate-limit state, plus the probe. */
  entries: {
    input: z.null(),
    output: z.object({
      entries: z.array(rateLimitEntrySchema),
      probe: probeSnapshotSchema.nullable(),
      probeHint: hintSchema.nullable(),
    }),
  },
  /** Rate-limit state for one thread, for the context row above its composer. */
  segment: {
    input: z
      .object({
        threadId: z.string().min(1),
        /** The thread's currently selected model, when the composer reports one. */
        model: z.string().nullable().optional(),
      })
      .strict(),
    output: z.object({
      providerId: z.string().nullable(),
      entry: rateLimitEntrySchema.nullable(),
      probe: probeSnapshotSchema.nullable(),
      probeHint: hintSchema.nullable(),
      /** True while a probe is under way. */
      probePending: z.boolean(),
    }),
  },
});

/** Realtime channel the frontend listens on; refreshes every surface. */
const RATE_LIMITS_CHANGED = "rate-limits-changed";
/** kv keys. */
const KV_ENTRIES = "entries";
const KV_PROBE = "probe";
const KV_ACTIVE_MODEL = "active-model";
/** How many recent threads the reconcile sweep covers. */
const RECONCILE_THREAD_LIMIT = 40;
/** Newest rate-limit events read per live thread notification. */
const LIVE_INGEST_LIMIT = 10;
/** Newest rate-limit events read per thread during a reconcile sweep. */
const RECONCILE_INGEST_LIMIT = 3;
/** Pause between reconcile sweeps; recovers events missed while unloaded. */
const RECONCILE_INTERVAL_MS = 10 * 60_000;
/** Timeout for one probe request. */
const PROBE_TIMEOUT_MS = 15_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A sleep that wakes on abort, so services stop inside bb's window. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
      { once: true },
    );
  });
}

const CLI_USAGE = [
  "Rate limits for the model you are working with: provider state",
  "observed in bb threads, plus numeric x-ratelimit values probed from",
  "the endpoint that model resolves to.",
  "",
  "Usage:",
  "  bb rate-limits status [--json]               latest state",
  "  bb rate-limits probe [--model <id>] [--json]  probe the endpoint now",
].join("\n");

const CLI_EMPTY = [
  "No provider rate limits observed yet.",
  "Run a turn in a thread; providers that report rate limits",
  "(Claude Code, Codex, ACP bridges) appear here.",
].join("\n");

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const settings = bb.settings.define({
    baseUrl: {
      type: "string",
      label: "Endpoint base URL",
      default: "",
    },
    apiKey: {
      type: "string",
      label: "API key",
      secret: true,
    },
  });

  // Latest rate-limit state per provider, seeded from the previous run.
  const entries = new Map<string, RateLimitEntry>();
  for (const entry of parseEntryList(await bb.storage.kv.get(KV_ENTRIES))) {
    entries.set(entry.providerId, entry);
  }
  // Latest probe snapshot, seeded the same way.
  let probe: ProbeSnapshot | null = parseProbeSnapshot(
    await bb.storage.kv.get(KV_PROBE),
  );
  // The most recent model a thread reported as active; the snapshot's own
  // model is the best seed when the store is empty.
  let lastActiveModel: string | null =
    ((await bb.storage.kv.get(KV_ACTIVE_MODEL)) as string | undefined) ??
    probe?.model ??
    null;

  // Serialize kv writes so bursts never interleave; never skip one.
  let persistChain: Promise<void> = Promise.resolve();
  function persist(key: string, value: unknown): Promise<void> {
    persistChain = persistChain
      .then(() => bb.storage.kv.set(key, value))
      .catch((error: unknown) => {
        bb.log.warn(`failed to persist ${key}: ${errorMessage(error)}`);
      });
    return persistChain;
  }

  /**
   * The most recent request-completion instant seen (a completed `turn/…` or
   * `item/…` — each item is one spent provider request). A newer one makes
   * the probe due again; nothing here is time-based.
   */
  let lastRequestMarkerAt = 0;

  /**
   * Read a thread's newest events and merge them into the store.
   */
  async function ingestThread(threadId: string, limit: number): Promise<void> {
    const rows = await bb.sdk.threads.events.list({
      threadId,
      // The server filters by type; parse defensively at the boundary anyway.
      // Request completions ride along so one read captures both signals.
      types: ["provider/rateLimits/updated", "turn/completed", "item/completed"],
      order: "desc",
      limit: String(limit),
    });
    const { changed, refreshed } = applyRateLimitRows(
      entries,
      parseRateLimitRows(rows),
    );
    if (changed.length > 0) {
      bb.realtime.publish(RATE_LIMITS_CHANGED, {
        providers: changed.map((entry) => entry.providerId),
      });
    }
    if (changed.length > 0 || refreshed) {
      await persist(KV_ENTRIES, [...entries.values()]);
    }
    const markerAt = newestRequestMarkerAt(rows);
    if (markerAt !== null && markerAt > lastRequestMarkerAt) {
      lastRequestMarkerAt = markerAt;
    }
  }

  // --- endpoint probe ------------------------------------------------------

  let probeInFlight: Promise<ProbeSnapshot | null> | null = null;

  function failedSnapshot(model: string, message: string): ProbeSnapshot {
    return {
      model,
      limitRequests: null,
      remainingRequests: null,
      resetRequestsAtMs: null,
      limitTokens: null,
      remainingTokens: null,
      resetTokensAtMs: null,
      observedAt: Date.now(),
      error: message,
    };
  }

  /**
   * Decide whether a model is worth probing and where. Purely event-driven:
   * the probe is due when there is no snapshot for the active model yet, when
   * the snapshot is for a different model, or when a request completed after
   * the snapshot was taken — never on a timer.
   */
  async function probeDecision(
    model: string | null,
    force: boolean,
  ): Promise<{ run: boolean; resolution: EndpointResolution }> {
    const { baseUrl, apiKey } = await settings.get();
    const resolution = resolveEndpoint({
      model,
      baseUrlSetting: baseUrl,
      apiKeySetting: apiKey,
      env: (name) => process.env[name],
    });
    if (resolution.kind !== "endpoint" || model === null || model === "") {
      return { run: false, resolution };
    }
    if (force) return { run: true, resolution };
    const due =
      probe === null ||
      probe.model !== model ||
      probe.observedAt < lastRequestMarkerAt;
    return { run: due, resolution };
  }

  /** Probe the endpoint one model resolves to. Single-flight: callers share it. */
  async function runProbe(
    model: string,
    resolution: EndpointResolution,
  ): Promise<ProbeSnapshot | null> {
    if (resolution.kind !== "endpoint") return null;
    if (probeInFlight !== null) return probeInFlight;
    const flight = (probeInFlight = (async () => {
      try {
        const response = await fetch(`${resolution.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${resolution.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: resolution.apiModel,
            messages: [{ role: "user", content: "1" }],
            max_tokens: 1,
          }),
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        // Rate-limit headers often ride on error responses too (429s), so
        // parse headers before judging the status.
        const snapshot = probeSnapshotFromHeaders(
          (name) => response.headers.get(name),
          Date.now(),
          model,
        );
        if (!response.ok && !probeHasValues(snapshot)) {
          return failedSnapshot(model, `HTTP ${response.status}`);
        }
        // Drain the body so the connection is reusable.
        await response.text().catch(() => undefined);
        return snapshot;
      } catch (error) {
        return failedSnapshot(model, errorMessage(error));
      }
    })());
    // Clear the single-flight slot the moment the request settles — before
    // the persist/publish tail below runs — so a probe kicked right after a
    // completed one starts a fresh request instead of joining a finished
    // flight and never fetching.
    void flight.then(
      () => {
        probeInFlight = null;
      },
      () => {
        probeInFlight = null;
      },
    );
    const snapshot = await flight;
    if (snapshot !== null) {
      probe = snapshot;
      await persist(KV_PROBE, snapshot);
      bb.realtime.publish(RATE_LIMITS_CHANGED, { probe: true });
    }
    return snapshot;
  }

  /** Start a probe in the background; marks it pending immediately. */
  function kickProbe(model: string, resolution: EndpointResolution): void {
    void runProbe(model, resolution).catch((error) => {
      bb.log.warn(`probe failed: ${errorMessage(error)}`);
    });
  }

  /** Probe when worthwhile; used by thread activity and service triggers. */
  async function maybeProbe(
    model: string | null,
    force = false,
  ): Promise<void> {
    if (model === null || model === "") return;
    const decision = await probeDecision(model, force);
    if (decision.run) kickProbe(model, decision.resolution);
  }

  bb.rpc.register(rpcContract, {
    entries: async () => {
      const { resolution } = await probeDecision(lastActiveModel, false);
      return {
        entries: sortEntries([...entries.values()]),
        probe,
        probeHint: resolutionHints(resolution),
      };
    },
    segment: async ({ threadId, model }) => {
      let providerId: string | null = null;
      try {
        providerId = (await bb.sdk.threads.get({ threadId })).providerId;
      } catch (error) {
        bb.log.warn(
          `segment: failed to read thread ${threadId}: ${errorMessage(error)}`,
        );
      }
      const activeModel =
        model === undefined || model === null || model === ""
          ? lastActiveModel
          : model;
      if (model !== undefined && model !== null && model !== lastActiveModel) {
        lastActiveModel = model;
        void persist(KV_ACTIVE_MODEL, model);
      }
      // Decide before answering so `probePending` is accurate; the probe
      // itself runs in the background and realtime brings the numbers.
      const decision = await probeDecision(activeModel, false);
      if (decision.run && activeModel !== null) {
        kickProbe(activeModel, decision.resolution);
      }
      return {
        providerId,
        entry: providerId === null ? null : entries.get(providerId) ?? null,
        probe,
        probeHint: resolutionHints(decision.resolution),
        probePending: probeInFlight !== null,
      };
    },
  });

  // Thread activity is announced at most once per second per thread, and
  // rate-limit updates arrive as thread events: this is the live capture.
  // Probing rides the same signal with no timers: when a request of the
  // active thread completes (a `turn/completed` or `item/completed` row),
  // the snapshot is older than that request and the probe fires.
  bb.events.on("experimental_thread.events", async ({ thread }) => {
    if (thread.deletedAt !== null) return;
    try {
      await ingestThread(thread.id, LIVE_INGEST_LIMIT);
    } catch (error) {
      bb.log.warn(
        `ingest failed for thread ${thread.id}: ${errorMessage(error)}`,
      );
    }
    await maybeProbe(lastActiveModel).catch((error) => {
      bb.log.warn(`probe failed: ${errorMessage(error)}`);
    });
  });

  /** Sweep recent threads so a restart reloads state and closes gaps. */
  async function reconcile(): Promise<void> {
    const threads = await bb.sdk.threads.list({
      limit: RECONCILE_THREAD_LIMIT,
    });
    for (const thread of threads) {
      try {
        await ingestThread(thread.id, RECONCILE_INGEST_LIMIT);
      } catch (error) {
        bb.log.warn(
          `reconcile failed for thread ${thread.id}: ${errorMessage(error)}`,
        );
      }
    }
  }

  bb.background.service("reconcile", {
    async start(signal) {
      const sweep = async () => {
        try {
          await reconcile();
        } catch (error) {
          bb.log.warn(`reconcile sweep failed: ${errorMessage(error)}`);
        }
        // Catches markers missed while the plugin was not loaded; a fresh
        // snapshot stays untouched — no timers, no periodic probing.
        await maybeProbe(lastActiveModel).catch(() => undefined);
      };
      await sweep();
      while (!signal.aborted) {
        await sleep(RECONCILE_INTERVAL_MS, signal);
        if (signal.aborted) break;
        await sweep();
      }
    },
  });

  // Settings changes: probe immediately when the endpoint became usable,
  // clear the stale snapshot when it no longer resolves.
  settings.onChange((next, previous) => {
    if (next.baseUrl === previous.baseUrl && next.apiKey === previous.apiKey) {
      return;
    }
    void (async () => {
      const decision = await probeDecision(lastActiveModel, true);
      if (decision.run && lastActiveModel !== null) {
        kickProbe(lastActiveModel, decision.resolution);
      } else if (decision.resolution.kind !== "endpoint" && probe !== null) {
        probe = null;
        await persist(KV_PROBE, null);
        bb.realtime.publish(RATE_LIMITS_CHANGED, { probe: false });
      }
    })().catch((error) => {
      bb.log.warn(`settings change handling failed: ${errorMessage(error)}`);
    });
  });

  bb.cli.register({
    name: "rate-limits",
    summary: "Show rate limits for the model you are working with",
    commands: [
      {
        name: "status",
        summary: "Latest rate limits per provider",
        usage: "bb rate-limits status [--json]",
      },
      {
        name: "probe",
        summary: "Probe the endpoint for a model now",
        usage: "bb rate-limits probe [--model <id>] [--json]",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const args = argv.filter((arg) => arg !== "--json");
      const modelIndex = args.indexOf("--model");
      const modelOverride =
        modelIndex !== -1 ? args[modelIndex + 1] : undefined;
      if (modelIndex !== -1) args.splice(modelIndex, 2);
      const [command] = args;
      if (
        command !== undefined &&
        command !== "status" &&
        command !== "probe" &&
        command !== "help" &&
        command !== "--help"
      ) {
        return {
          exitCode: 1,
          stderr: `Unknown command ${command}.\n\n${CLI_USAGE}`,
        };
      }
      if (command === "help" || command === "--help") {
        return { exitCode: 0, stdout: CLI_USAGE };
      }

      if (command === "probe") {
        const model = modelOverride ?? lastActiveModel;
        if (model === null || model === undefined || model === "") {
          return {
            exitCode: 1,
            stderr:
              "No active model yet — open a thread or pass --model <id>.",
          };
        }
        if (modelOverride !== undefined) {
          lastActiveModel = modelOverride;
          void persist(KV_ACTIVE_MODEL, modelOverride);
        }
        const decision = await probeDecision(model, true);
        const snapshot = decision.run
          ? await runProbe(model, decision.resolution)
          : null;
        if (snapshot === null) {
          const hint = resolutionHints(decision.resolution);
          return {
            exitCode: 1,
            stderr:
              hint?.long ??
              "No endpoint for this model — see `bb rate-limits help`.",
          };
        }
        return {
          exitCode: 0,
          stdout: json
            ? JSON.stringify({ probe: snapshot })
            : probeDetailLines(snapshot, Date.now()).join("\n"),
        };
      }

      const now = Date.now();
      const list = sortEntries([...entries.values()]);
      const { resolution } = await probeDecision(lastActiveModel, false);
      const hint = resolutionHints(resolution);
      if (json) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            entries: list,
            probe,
            probeHint: hint,
          }),
        };
      }
      const blocks: string[] = [];
      if (probe !== null) {
        blocks.push(probeDetailLines(probe, now).join("\n"));
      }
      if (hint?.long != null) blocks.push(hint.long);
      blocks.push(
        list.length === 0
          ? CLI_EMPTY
          : list
              .map((entry) => formatEntryLines(entry, now).join("\n"))
              .join("\n\n"),
      );
      return { exitCode: 0, stdout: blocks.join("\n\n") };
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
