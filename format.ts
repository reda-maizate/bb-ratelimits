// bb-plugin-rate-limits — display formatting shared by the CLI, the thread
// context segment, and the Rate limits page. Pure functions, no zod: safe to
// import from both server.ts and app.tsx.
import type {
  ProbeSnapshot,
  RateLimitEntry,
  RateLimitKind,
  RateLimitStatus,
  RateLimitWindow,
} from "./shared";

/** Compact duration: `522ms`, `8.5s`, `45s`, `12m`, `1m30s`, `23h59m`, `3d4h`. */
export function formatDuration(ms: number): string {
  const total = Math.abs(Math.round(ms));
  if (total === 0) return "0s";
  if (total < 1_000) return `${total}ms`;
  const seconds = total / 1_000;
  if (seconds < 10) return `${Math.round(seconds * 10) / 10}s`;
  const wholeSeconds = Math.round(seconds);
  if (wholeSeconds < 60) return `${wholeSeconds}s`;
  const minutes = Math.floor(wholeSeconds / 60);
  const restSeconds = wholeSeconds % 60;
  if (minutes < 60) return restSeconds === 0 ? `${minutes}m` : `${minutes}m${restSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes === 0 ? `${hours}h` : `${hours}h${restMinutes}m`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}d` : `${days}d${restHours}h`;
}

/** `in 12m` for a future instant, `3m ago` for a past one. */
export function formatRelative(targetMs: number, now: number): string {
  const delta = targetMs - now;
  return delta >= 0 ? `in ${formatDuration(delta)}` : `${formatDuration(-delta)} ago`;
}

/** A window's own name: its label, else its provider key, else a generic one. */
export function windowDisplayName(window: RateLimitWindow): string {
  return window.label ?? window.providerKey ?? "rate-limit window";
}

/** `subscription-window` → `Subscription window`. */
export function kindLabel(kind: RateLimitKind): string {
  switch (kind) {
    case "subscription-window":
      return "Subscription window";
    case "spend-control":
      return "Spend control";
    default:
      return kind.charAt(0).toUpperCase() + kind.slice(1);
  }
}

export type StatusTone = "good" | "warn" | "bad" | "neutral";

/** Semantic color for a status. */
export function statusTone(status: RateLimitStatus): StatusTone {
  switch (status) {
    case "allowed":
      return "good";
    case "warning":
      return "warn";
    case "blocked":
      return "bad";
    default:
      return "neutral";
  }
}

/** The window a compact line should mention: the most urgent one. */
export function mostUrgentWindow(
  entry: RateLimitEntry,
  now: number,
): RateLimitWindow | null {
  if (entry.windows.length === 0) return null;
  const rank: Record<RateLimitStatus, number> = {
    blocked: 0,
    warning: 1,
    unknown: 2,
    allowed: 3,
  };
  const scored = entry.windows.map((window) => {
    const untilReset = window.resetsAtMs === null ? Number.POSITIVE_INFINITY : window.resetsAtMs - now;
    return { window, score: rank[window.status] * 1e12 + untilReset };
  });
  scored.sort((a, b) => a.score - b.score);
  return scored[0]?.window ?? null;
}

/** Local clock time like `14:32` for an absolute instant. */
export function formatClock(targetMs: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(targetMs));
}

/** Compact display for large counts: `858K`, `1M`, `1.3M`. */
export function formatCount(value: number | null): string {
  if (value === null) return "—";
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

/** `remaining/limit` like `599/600`, or the side that is known. */
function fraction(remaining: number | null, limit: number | null): string {
  if (remaining !== null && limit !== null) {
    return `${remaining}/${limit}`;
  }
  return String(remaining ?? limit ?? "—");
}

/**
 * The compact probe line for the context segment, in the spirit of
 * `599/600 req · 858K/1M tok · resets in 8.5s`. Null when the snapshot has
 * nothing to show (no numbers and no error).
 */
export function probeSummaryLine(snapshot: ProbeSnapshot, now: number): string | null {
  if (snapshot.error !== null) return `probe failed (${snapshot.error})`;
  const parts: string[] = [];
  if (
    snapshot.remainingRequests !== null ||
    snapshot.limitRequests !== null
  ) {
    parts.push(`${fraction(snapshot.remainingRequests, snapshot.limitRequests)} req`);
  }
  if (snapshot.remainingTokens !== null || snapshot.limitTokens !== null) {
    parts.push(
      `${formatCount(snapshot.remainingTokens)}/${formatCount(snapshot.limitTokens)} tok`,
    );
  }
  if (parts.length === 0) return null;
  const reset =
    snapshot.resetRequestsAtMs === null
      ? snapshot.resetTokensAtMs
      : snapshot.resetRequestsAtMs;
  if (reset !== null) parts.push(`resets ${formatRelative(reset, now)}`);
  return parts.join(" · ");
}

/** CLI lines for a probe snapshot. */
export function probeDetailLines(
  snapshot: ProbeSnapshot,
  now: number,
): string[] {
  const model = snapshot.model === null ? "" : ` · ${snapshot.model}`;
  const lines = [
    `Endpoint probe${model} · updated ${formatDuration(Math.max(0, now - snapshot.observedAt))} ago`,
  ];
  if (snapshot.error !== null) {
    lines.push(`  error: ${snapshot.error}`);
    return lines;
  }
  const reset = (atMs: number | null) =>
    atMs === null ? "no reset reported" : `resets ${formatRelative(atMs, now)}`;
  lines.push(
    `  requests: ${fraction(snapshot.remainingRequests, snapshot.limitRequests)}, ${reset(snapshot.resetRequestsAtMs)}`,
  );
  lines.push(
    `  tokens: ${formatCount(snapshot.remainingTokens)}/${formatCount(snapshot.limitTokens)}, ${reset(snapshot.resetTokensAtMs)}`,
  );
  return lines;
}

/** One CLI block per entry: provider line plus one line per window. */
export function formatEntryLines(entry: RateLimitEntry, now: number): string[] {
  const lines = [
    `${entry.providerId}  ${entry.status} · ${kindLabel(entry.kind)}`,
  ];
  for (const window of entry.windows) {
    const reset =
      window.resetsAtMs === null
        ? "no reset reported"
        : `resets ${formatRelative(window.resetsAtMs, now)}`;
    lines.push(
      `  ${windowDisplayName(window)}: ${window.status}, ${reset}`,
    );
  }
  if (entry.reachedReason !== null) {
    lines.push(`  reached: ${entry.reachedReason}`);
  }
  if (entry.overageStatus !== null && entry.overageStatus !== "allowed") {
    const reason =
      entry.overageReason === null ? "" : ` — ${entry.overageReason}`;
    lines.push(`  overage: ${entry.overageStatus}${reason}`);
  }
  if (entry.windows.length === 0) {
    lines.push("  no windows reported");
  }
  return lines;
}
