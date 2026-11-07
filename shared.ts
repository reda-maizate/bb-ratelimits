// bb-plugin-rate-limits — schemas, types, and pure tracking logic.
//
// bb providers (Claude Code, Codex, ACP bridges, …) report their rate-limit
// state to the server as `provider/rateLimits/updated` thread events. This
// module turns those events into one entry per provider and merges them,
// newest observation first. It also resolves which OpenAI-compatible
// endpoint to probe for the active model (well-known providers, two optional
// settings, standard environment variables) and parses the `x-ratelimit-*`
// headers of the probe response. Everything here is pure so the unit tests
// can drive it without a bb server.
import { z } from "zod";

export const rateLimitStatusSchema = z.enum([
  "allowed",
  "warning",
  "blocked",
  "unknown",
]);
export type RateLimitStatus = z.infer<typeof rateLimitStatusSchema>;

export const rateLimitKindSchema = z.enum([
  "subscription-window",
  "credits",
  "spend-control",
  "unknown",
]);
export type RateLimitKind = z.infer<typeof rateLimitKindSchema>;

export const rateLimitOverageStatusSchema = z.enum([
  "allowed",
  "warning",
  "rejected",
  "unavailable",
]);

/** One rate-limit window a provider reported (e.g. a 5h or 7d window). */
export const rateLimitWindowSchema = z
  .object({
    providerKey: z.string().nullable(),
    label: z.string().nullable(),
    status: rateLimitStatusSchema,
    resetsAtMs: z.number().int().nullable(),
  })
  .strict();
export type RateLimitWindow = z.infer<typeof rateLimitWindowSchema>;

/** The `rateLimits` payload of a `provider/rateLimits/updated` event. */
export const providerRateLimitPayloadSchema = z
  .object({
    providerId: z.string().min(1),
    status: rateLimitStatusSchema,
    kind: rateLimitKindSchema,
    windows: z.array(rateLimitWindowSchema),
    reachedReason: z.string().nullable(),
    overageStatus: rateLimitOverageStatusSchema.nullable(),
    overageReason: z.string().nullable(),
  })
  .strict();
export type ProviderRateLimitPayload = z.infer<
  typeof providerRateLimitPayloadSchema
>;

/** Latest known rate limits for one provider, captured from a thread event. */
export const rateLimitEntrySchema = z
  .object({
    ...providerRateLimitPayloadSchema.shape,
    /** Epoch ms of the source `provider/rateLimits/updated` event. */
    observedAt: z.number().int(),
    /** Thread where the source event was seen. */
    threadId: z.string(),
  })
  .strict();
export type RateLimitEntry = z.infer<typeof rateLimitEntrySchema>;

/** Validate an unknown value (kv seed, RPC boundary) as an entry list. */
export function parseEntryList(value: unknown): RateLimitEntry[] {
  const parsed = z.array(rateLimitEntrySchema).safeParse(value);
  return parsed.success ? parsed.data : [];
}

const rateLimitRowSchema = z.object({
  type: z.literal("provider/rateLimits/updated"),
  threadId: z.string(),
  createdAt: z.number().int(),
  // Strip mode drops the row's extra keys (id, scope, seq, providerThreadId)
  // and keeps exactly the payload this plugin reads.
  data: z.object({ rateLimits: providerRateLimitPayloadSchema }),
});

/**
 * Parse `provider/rateLimits/updated` rows from `threads.events.list`. The
 * list can mix event types (a `turn/completed` rides along), so each row is
 * validated on its own: a malformed or foreign row never discards its
 * neighbors.
 */
export function parseRateLimitRows(value: unknown): RateLimitEventRow[] {
  if (!Array.isArray(value)) return [];
  const rows: RateLimitEventRow[] = [];
  for (const row of value) {
    const parsed = rateLimitRowSchema.safeParse(row);
    if (parsed.success) rows.push(parsed.data);
  }
  return rows;
}

/**
 * The newest request-completion instant among event rows, if any — the
 * newest `turn/completed` or `item/completed`. Each completed item means the
 * account just spent a request, so its arrival is the signal to refresh the
 * probe's numbers. Purely event-driven: no timers involved.
 */
export function newestRequestMarkerAt(value: unknown): number | null {
  if (!Array.isArray(value)) return null;
  let newest: number | null = null;
  for (const row of value) {
    if (typeof row !== "object" || row === null) continue;
    const candidate = row as { type?: unknown; createdAt?: unknown };
    if (
      candidate.type !== "turn/completed" &&
      candidate.type !== "item/completed"
    ) {
      continue;
    }
    if (typeof candidate.createdAt !== "number") continue;
    if (newest === null || candidate.createdAt > newest) {
      newest = candidate.createdAt;
    }
  }
  return newest;
}

/**
 * Structural shape of one `provider/rateLimits/updated` row as
 * `bb.sdk.threads.events.list` returns it. Only the fields this plugin reads.
 */
export interface RateLimitEventRow {
  type: string;
  threadId: string;
  createdAt: number;
  data: { rateLimits: ProviderRateLimitPayload };
}

/** Build an entry from a `provider/rateLimits/updated` event row. */
export function entryFromRow(row: RateLimitEventRow): RateLimitEntry {
  return {
    ...row.data.rateLimits,
    observedAt: row.createdAt,
    threadId: row.threadId,
  };
}

/** Canonical state of an entry, ignoring when and where it was observed. */
function stateKey(entry: RateLimitEntry): string {
  const { observedAt: _observedAt, threadId: _threadId, ...state } = entry;
  return JSON.stringify(state);
}

export interface ApplyResult {
  /** Entries whose state changed — worth broadcasting and persisting. */
  changed: RateLimitEntry[];
  /** True when an identical state was re-observed more recently. */
  refreshed: boolean;
}

/**
 * Merge event rows into the per-provider store. Rows may arrive in any
 * order and mention several providers; for each provider the newest
 * observation wins, and an observation older than what the store already
 * holds never regresses it.
 */
export function applyRateLimitRows(
  store: Map<string, RateLimitEntry>,
  rows: readonly RateLimitEventRow[],
): ApplyResult {
  const changed: RateLimitEntry[] = [];
  let refreshed = false;
  const ordered = [...rows].sort((a, b) => b.createdAt - a.createdAt);
  for (const row of ordered) {
    const entry = entryFromRow(row);
    const current = store.get(entry.providerId);
    if (current !== undefined && entry.observedAt < current.observedAt) {
      continue; // stale: the store already holds a newer observation
    }
    if (current !== undefined && stateKey(current) === stateKey(entry)) {
      if (entry.observedAt > current.observedAt) {
        store.set(entry.providerId, entry);
        refreshed = true;
      }
      continue; // same state, nothing to broadcast
    }
    store.set(entry.providerId, entry);
    changed.push(entry);
  }
  return { changed, refreshed };
}

/** Entries, most recently observed first. */
export function sortEntries(entries: readonly RateLimitEntry[]): RateLimitEntry[] {
  return [...entries].sort((a, b) => b.observedAt - a.observedAt);
}

/** Fixture helper for tests and stories. */
export function makeRateLimitPayload(
  overrides: Partial<ProviderRateLimitPayload> = {},
): ProviderRateLimitPayload {
  return {
    providerId: "claude-code",
    status: "allowed",
    kind: "subscription-window",
    windows: [],
    reachedReason: null,
    overageStatus: null,
    overageReason: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Endpoint resolution: generic, minimal-configuration probe targeting.
//
// bb model ids for ACP-backed providers are namespaced (`scaleway/glm-5.3` —
// provider name, then the API model id). The segment reports the thread's
// active model; the endpoint and key are resolved from a table of well-known
// OpenAI-compatible providers plus two optional settings and the provider's
// standard environment variable. Nothing reads other tools' config files.
// ---------------------------------------------------------------------------

/** A well-known OpenAI-compatible endpoint. */
export interface ProviderProfile {
  baseUrl: string;
  /** Environment variables checked (in order) when no key setting is set. */
  envVars: string[];
  label: string;
}

/** Built-in provider shortcuts, keyed by the name users give the provider. */
export const PROVIDER_PROFILES: Record<string, ProviderProfile> = {
  scaleway: {
    baseUrl: "https://api.scaleway.ai/v1",
    envVars: ["SCALEWAY_API_KEY", "SCW_API_KEY", "SCW_SECRET_KEY"],
    label: "Scaleway",
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    envVars: ["OPENAI_API_KEY"],
    label: "OpenAI",
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    envVars: ["OPENROUTER_API_KEY"],
    label: "OpenRouter",
  },
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    envVars: ["GROQ_API_KEY"],
    label: "Groq",
  },
  mistral: {
    baseUrl: "https://api.mistral.ai/v1",
    envVars: ["MISTRAL_API_KEY"],
    label: "Mistral",
  },
  together: {
    baseUrl: "https://api.together.xyz/v1",
    envVars: ["TOGETHER_API_KEY"],
    label: "Together",
  },
  cerebras: {
    baseUrl: "https://api.cerebras.ai/v1",
    envVars: ["CEREBRAS_API_KEY"],
    label: "Cerebras",
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com/v1",
    envVars: ["DEEPSEEK_API_KEY"],
    label: "DeepSeek",
  },
  xai: {
    baseUrl: "https://api.x.ai/v1",
    envVars: ["XAI_API_KEY"],
    label: "xAI",
  },
  perplexity: {
    baseUrl: "https://api.perplexity.ai",
    envVars: ["PERPLEXITY_API_KEY"],
    label: "Perplexity",
  },
  fireworks: {
    baseUrl: "https://api.fireworks.ai/inference/v1",
    envVars: ["FIREWORKS_API_KEY"],
    label: "Fireworks",
  },
};

/** Environment fallback for custom base URLs. */
const GENERIC_ENV_VARS = ["RATE_LIMITS_API_KEY"];

/** What `resolveEndpoint` decided. */
export type EndpointResolution =
  | {
      kind: "endpoint";
      baseUrl: string;
      apiKey: string;
      /** Model id to send the API (namespaced bb ids lose their prefix). */
      apiModel: string;
      /** Matched provider shortcut, or null for a custom URL. */
      profileKey: string | null;
      label: string;
    }
  | { kind: "missing-key"; baseUrl: string; envVars: string[]; label: string }
  | { kind: "no-model" }
  | { kind: "unknown-provider"; providerName: string }
  | { kind: "unconfigured" };

/** The provider-name prefix of a namespaced bb model id, if any. */
function modelPrefix(model: string): string | null {
  const slash = model.indexOf("/");
  return slash === -1 ? null : model.slice(0, slash);
}

/**
 * Resolve where to probe and with what credentials for one model:
 *
 *  - the `baseUrl` setting wins (a shortcut name or a full URL),
 *  - else the model's provider prefix, when it names a known provider,
 *  - the key comes from the `apiKey` setting, else the provider's standard
 *    environment variable, else `RATE_LIMITS_API_KEY` for custom URLs.
 */
export function resolveEndpoint(args: {
  model: string | null;
  baseUrlSetting: string;
  apiKeySetting: string | undefined;
  env: (name: string) => string | undefined;
}): EndpointResolution {
  const model = args.model;
  if (model === null || model === "") return { kind: "no-model" };
  const setting = args.baseUrlSetting.trim();
  const prefix = modelPrefix(model);

  let baseUrl: string;
  let profileKey: string | null = null;
  let envVars: string[] = GENERIC_ENV_VARS;
  let label = "custom endpoint";

  if (setting !== "") {
    const profile = PROVIDER_PROFILES[setting.toLowerCase()];
    if (profile !== undefined) {
      baseUrl = profile.baseUrl;
      profileKey = setting.toLowerCase();
      envVars = profile.envVars;
      label = profile.label;
    } else if (/^https?:\/\//i.test(setting)) {
      baseUrl = setting.replace(/\/+$/, "");
    } else {
      return { kind: "unknown-provider", providerName: setting };
    }
  } else if (prefix !== null) {
    const profile = PROVIDER_PROFILES[prefix.toLowerCase()];
    if (profile === undefined) {
      return { kind: "unknown-provider", providerName: prefix };
    }
    baseUrl = profile.baseUrl;
    profileKey = prefix.toLowerCase();
    envVars = profile.envVars;
    label = profile.label;
  } else {
    // No endpoint hint at all: CLI-bridge models report via provider events.
    return { kind: "unconfigured" };
  }

  // A namespaced id means the suffix is what the API expects.
  const apiModel =
    prefix !== null && PROVIDER_PROFILES[prefix.toLowerCase()] !== undefined
      ? model.slice(prefix.length + 1)
      : model;

  const apiKeySetting = args.apiKeySetting;
  const apiKey =
    apiKeySetting !== undefined && apiKeySetting !== ""
      ? apiKeySetting
      : (envVars.map((name) => args.env(name)).find(
          (value) => value !== undefined && value !== "",
        ) ?? null);
  if (apiKey === null) {
    return { kind: "missing-key", baseUrl, envVars, label };
  }
  return { kind: "endpoint", baseUrl, apiKey, apiModel, profileKey, label };
}

/** User-facing guidance for a resolution that cannot probe. */
export function resolutionHints(
  resolution: EndpointResolution,
): { short: string | null; long: string | null } | null {
  switch (resolution.kind) {
    case "endpoint":
      return null;
    case "missing-key":
      return {
        short: `no API key set for ${resolution.label}`,
        long:
          `${resolution.label} endpoint detected. Set the key with ` +
          `\`bb plugin config rate-limits set apiKey <key>\`, or export ` +
          `${resolution.envVars.join(" or ")} for the BB server.`,
      };
    case "unknown-provider":
      return {
        short: `unknown provider "${resolution.providerName}"`,
        long:
          `Set the endpoint with ` +
          `\`bb plugin config rate-limits set baseUrl <https://…/v1>\`, ` +
          `or name the provider after a known one: ` +
          `${Object.keys(PROVIDER_PROFILES).join(", ")}.`,
      };
    default:
      return null;
  }
}

/** `scaleway/glm-5.3` → `glm-5.3`; unknown or bare ids pass through. */
export function modelShortName(model: string | null): string | null {
  if (model === null) return null;
  const prefix = modelPrefix(model);
  if (prefix !== null && PROVIDER_PROFILES[prefix.toLowerCase()] !== undefined) {
    return model.slice(prefix.length + 1);
  }
  return model;
}

// ---------------------------------------------------------------------------
// Numeric probe snapshots: OpenAI-compatible x-ratelimit-* headers.
//
// bb never sees the HTTP responses an ACP or bridge agent process makes, so
// numeric limits are captured by probing the resolved endpoint directly and
// reading its response headers — the same six headers Scaleway's Generative
// APIs (and other OpenAI-compatible providers) send.
// ---------------------------------------------------------------------------

/** Numeric rate limits read from one probe response. */
export const probeSnapshotSchema = z
  .object({
    /** bb model id the probe targeted (`scaleway/glm-5.3`). */
    model: z.string().nullable(),
    limitRequests: z.number().int().nullable(),
    remainingRequests: z.number().int().nullable(),
    /** Epoch ms when the request window resets (observedAt + duration). */
    resetRequestsAtMs: z.number().int().nullable(),
    limitTokens: z.number().int().nullable(),
    remainingTokens: z.number().int().nullable(),
    /** Epoch ms when the token window resets (observedAt + duration). */
    resetTokensAtMs: z.number().int().nullable(),
    /** Epoch ms when the probe response was observed. */
    observedAt: z.number().int(),
    /** Fetch or HTTP failure text; null on success. */
    error: z.string().nullable(),
  })
  .strict();
export type ProbeSnapshot = z.infer<typeof probeSnapshotSchema>;

/** Validate an unknown value (kv seed, RPC boundary) as a probe snapshot. */
export function parseProbeSnapshot(value: unknown): ProbeSnapshot | null {
  const parsed = probeSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Parse a numeric rate-limit header (`"600"`) into a number, or null. */
export function parseHeaderInt(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  // Strict: a whole integer only, so stray values like "8s" stay null
  // instead of silently parsing as 8.
  if (!/^-?\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Parse a duration header (`"8s522ms"`, `"1m"`, `"2h"`) into milliseconds.
 * Bare numbers (`"120"`) are treated as seconds; anything unparseable is
 * null.
 */
export function parseDurationMs(value: string | null): number | null {
  if (value === null) return null;
  let total = 0;
  let matched = false;
  for (const match of value.matchAll(/(\d+)(ms|s|m|h)/g)) {
    matched = true;
    const amount = Number.parseInt(match[1]!, 10);
    const scale =
      match[2] === "ms"
        ? 1
        : match[2] === "s"
          ? 1_000
          : match[2] === "m"
            ? 60_000
            : 3_600_000;
    total += amount * scale;
  }
  if (matched) return total;
  const seconds = Number.parseInt(value, 10);
  return Number.isNaN(seconds) ? null : seconds * 1_000;
}

/** True when a snapshot carries at least one numeric limit. */
export function probeHasValues(snapshot: ProbeSnapshot): boolean {
  return (
    snapshot.limitRequests !== null ||
    snapshot.remainingRequests !== null ||
    snapshot.resetRequestsAtMs !== null ||
    snapshot.limitTokens !== null ||
    snapshot.remainingTokens !== null ||
    snapshot.resetTokensAtMs !== null
  );
}

/**
 * Read a probe snapshot from a response's rate-limit headers. Reset headers
 * are durations ("8s522ms"), so they are anchored to `observedAt` as
 * absolute instants. Headers missing from the response stay null; the
 * caller sets `error` separately for failed requests.
 */
export function probeSnapshotFromHeaders(
  header: (name: string) => string | null,
  observedAt: number,
  model: string,
): ProbeSnapshot {
  const requestsResetMs = parseDurationMs(header("x-ratelimit-reset-requests"));
  const tokensResetMs = parseDurationMs(header("x-ratelimit-reset-tokens"));
  return {
    model,
    limitRequests: parseHeaderInt(header("x-ratelimit-limit-requests")),
    remainingRequests: parseHeaderInt(header("x-ratelimit-remaining-requests")),
    resetRequestsAtMs:
      requestsResetMs === null ? null : observedAt + requestsResetMs,
    limitTokens: parseHeaderInt(header("x-ratelimit-limit-tokens")),
    remainingTokens: parseHeaderInt(header("x-ratelimit-remaining-tokens")),
    resetTokensAtMs: tokensResetMs === null ? null : observedAt + tokensResetMs,
    observedAt,
    error: null,
  };
}

const STATUS_RANK: Record<RateLimitStatus, number> = {
  allowed: 0,
  unknown: 1,
  warning: 2,
  blocked: 3,
};

/** The worse of two statuses, for combining probe and provider state. */
export function worseStatus(a: RateLimitStatus, b: RateLimitStatus): RateLimitStatus {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

/** A probe's overall status, derived from its numbers. */
export function probeStatusOf(snapshot: ProbeSnapshot): RateLimitStatus {
  const ratios: number[] = [];
  const exhausted: boolean[] = [];
  for (const [limit, remaining] of [
    [snapshot.limitRequests, snapshot.remainingRequests],
    [snapshot.limitTokens, snapshot.remainingTokens],
  ] as const) {
    if (limit !== null && remaining !== null) {
      if (limit <= 0) continue;
      ratios.push(remaining / limit);
      exhausted.push(remaining <= 0);
    }
  }
  if (exhausted.some(Boolean)) return "blocked";
  if (ratios.some((ratio) => ratio < 0.2)) return "warning";
  if (ratios.length === 0) return "unknown";
  return "allowed";
}

/** Fixture helper for probe snapshots. */
export function makeProbeSnapshot(
  overrides: Partial<ProbeSnapshot> = {},
): ProbeSnapshot {
  return {
    model: "scaleway/glm-5.3",
    limitRequests: 600,
    remainingRequests: 599,
    resetRequestsAtMs: 9_520,
    limitTokens: 1_000_000,
    remainingTokens: 858_000,
    resetTokensAtMs: 91_000,
    observedAt: 1_000,
    error: null,
    ...overrides,
  };
}

/** Fixture helper: a rate-limit event row like `threads.events.list` returns. */
export function makeRateLimitRow(
  overrides: Partial<RateLimitEventRow> = {},
): RateLimitEventRow {
  const payload = overrides.data?.rateLimits ?? makeRateLimitPayload();
  return {
    type: "provider/rateLimits/updated",
    threadId: "th_1",
    createdAt: 1_000,
    ...overrides,
    data: { rateLimits: payload },
  };
}
