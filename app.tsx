// bb-plugin-rate-limits — the frontend entry.
//
// Two surfaces over one RPC contract:
//   • a context-row segment above every open thread's composer showing the
//     rate limits of the model the user is working with — numeric probe
//     values for the active model, plus the thread provider's latest
//     event-reported state (expandable for details),
//   • a "Rate limits" page listing the probe and every tracked provider.
// A realtime signal from the server refreshes both whenever new state lands.
import { useCallback, useEffect, useState } from "react";

import {
  definePluginApp,
  useComposer,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

import {
  formatClock,
  formatCount,
  formatRelative,
  kindLabel,
  mostUrgentWindow,
  probeSummaryLine,
  windowDisplayName,
} from "./format";
import type { rpcContract } from "./server";
import {
  modelShortName,
  worseStatus,
  probeStatusOf,
  type ProbeSnapshot,
  type RateLimitEntry,
  type RateLimitStatus,
} from "./shared";

/** Realtime channel server.ts publishes after every store change. */
const RATE_LIMITS_CHANGED = "rate-limits-changed";

/** Guidance for an endpoint that cannot be probed yet. */
interface ProbeHint {
  short: string | null;
  long: string | null;
}

/** What the `segment` RPC returns for a thread. */
interface SegmentState {
  providerId: string | null;
  entry: RateLimitEntry | null;
  probe: ProbeSnapshot | null;
  probeHint: ProbeHint | null;
  probePending: boolean;
}

/** What the `entries` RPC returns for the page. */
interface EntriesState {
  entries: RateLimitEntry[];
  probe: ProbeSnapshot | null;
  probeHint: ProbeHint | null;
}

/** Re-render every `intervalMs` so relative countdowns stay fresh. */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

const STATUS_DOT_CLASS: Record<RateLimitStatus, string> = {
  allowed: "bg-emerald-500",
  warning: "bg-amber-500",
  blocked: "bg-red-500",
  unknown: "bg-muted-foreground",
};

function StatusDot({ status }: { status: RateLimitStatus }) {
  return (
    <span
      className={cn("inline-block size-1.5 shrink-0 rounded-full", STATUS_DOT_CLASS[status])}
      aria-label={status}
      role="img"
    />
  );
}

function StatusBadge({ status }: { status: RateLimitStatus }) {
  const tone =
    status === "allowed"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
      : status === "warning"
        ? "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
        : status === "blocked"
          ? "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400"
          : "border-border bg-muted text-muted-foreground";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium capitalize",
        tone,
      )}
    >
      {status}
    </span>
  );
}

function reportError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** All tracked providers' entries plus the probe; refreshed on realtime. */
function useRateLimitEntries(): {
  data: EntriesState | null;
  error: string | null;
} {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<EntriesState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("entries").then(
      (result) => {
        setData({
          entries: result.entries,
          probe: result.probe ?? null,
          probeHint: result.probeHint ?? null,
        });
        setError(null);
      },
      (cause) => setError(reportError(cause)),
    );
  }, [rpc]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime(RATE_LIMITS_CHANGED, refetch);
  return { data, error };
}

/** The rate-limit state for one thread, for its currently selected model. */
function useThreadSegment(
  threadId: string,
  model: string | null,
): {
  state: SegmentState | null;
  error: string | null;
} {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<SegmentState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("segment", { threadId, model: model ?? null }).then(
      (result) => {
        // Normalize so an RPC result that drifts from the contract still
        // renders instead of crashing on a missing field.
        setState({
          providerId: result.providerId ?? null,
          entry: result.entry ?? null,
          probe: result.probe ?? null,
          probeHint: result.probeHint ?? null,
          probePending: result.probePending ?? false,
        });
        setError(null);
      },
      (cause) => setError(reportError(cause)),
    );
  }, [rpc, threadId, model]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime(RATE_LIMITS_CHANGED, refetch);
  return { state, error };
}

/** True when the snapshot is for the active model (or either is unknown). */
function probeMatchesModel(
  probe: ProbeSnapshot,
  activeModel: string | null,
): boolean {
  return (
    activeModel === null ||
    probe.model === null ||
    probe.model === activeModel
  );
}

/** One status for the dot: the worse of probe and provider state. "Unknown"
 * only when nothing reported at all — a healthy probe must not lose to it. */
function combinedStatus(
  state: SegmentState,
  activeModel: string | null,
): RateLimitStatus {
  const parts: RateLimitStatus[] = [];
  if (state.probe !== null && probeMatchesModel(state.probe, activeModel)) {
    parts.push(probeStatusOf(state.probe));
  }
  if (state.entry !== null) parts.push(state.entry.status);
  if (parts.length === 0) return "unknown";
  return parts.reduce((worst, next) => worseStatus(worst, next));
}

/**
 * The compact summary text, in priority order: numeric probe values for the
 * active model, the provider's event-reported state, a pending probe note,
 * then configuration guidance. Null hides the segment.
 */
function segmentText(
  state: SegmentState,
  activeModel: string | null,
  now: number,
): string | null {
  const probeLine =
    state.probe !== null && probeMatchesModel(state.probe, activeModel)
      ? probeSummaryLine(state.probe, now)
      : null;
  if (probeLine !== null) return probeLine;
  if (state.entry !== null) return entryText(state.entry, now);
  if (state.probePending) {
    const model = modelShortName(activeModel);
    return model === null ? "probing…" : `probing ${model}…`;
  }
  return state.probeHint?.short ?? null;
}

function entryText(entry: RateLimitEntry, now: number): string {
  const urgent = mostUrgentWindow(entry, now);
  if (urgent === null) return entry.status;
  const reset =
    urgent.resetsAtMs === null
      ? windowDisplayName(urgent)
      : `${windowDisplayName(urgent)} resets ${formatRelative(urgent.resetsAtMs, now)}`;
  return `${entry.status} · ${reset}`;
}

/** The compact, always-visible part of the context-row segment. */
function SegmentSummary(props: {
  threadId: string;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  // The composer's selection is the source of truth for "the model the user
  // is currently using"; it re-renders this segment when the picker changes.
  const selection = useComposer().selection;
  const activeModel = selection?.model ?? null;
  const { state } = useThreadSegment(props.threadId, activeModel);
  const now = useNow();
  const text = state === null ? null : segmentText(state, activeModel, now);
  if (text === null) return null;
  return (
    <button
      type="button"
      onClick={props.onToggle}
      aria-expanded={props.isExpanded}
      className="inline-flex min-w-0 items-center gap-1.5 rounded text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <Icon name="Gauge" className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="shrink-0">Rate limits</span>
      <StatusDot
        status={state === null ? "unknown" : combinedStatus(state, activeModel)}
      />
      <span className="truncate">{text}</span>
    </button>
  );
}

function WindowRow({
  label,
  status,
  resetsAtMs,
  now,
}: {
  label: string;
  status: RateLimitStatus;
  resetsAtMs: number | null;
  now: number;
}) {
  return (
    <li className="flex items-center justify-between gap-3 py-1">
      <span className="flex min-w-0 items-center gap-2">
        <StatusDot status={status} />
        <span className="truncate">{label}</span>
      </span>
      <span className="shrink-0 text-muted-foreground">
        {resetsAtMs === null
          ? "no reset reported"
          : `${formatRelative(resetsAtMs, now)} · ${formatClock(resetsAtMs)}`}
      </span>
    </li>
  );
}

/** One request/token line of the endpoint probe. */
function ProbeMetricRow({
  label,
  remaining,
  limit,
  resetsAtMs,
  now,
}: {
  label: string;
  remaining: number | null;
  limit: number | null;
  resetsAtMs: number | null;
  now: number;
}) {
  const value =
    remaining !== null && limit !== null
      ? `${formatCount(remaining)}/${formatCount(limit)}`
      : formatCount(remaining ?? limit);
  return (
    <li className="flex items-center justify-between gap-3 py-1">
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate">{label}</span>
      </span>
      <span className="shrink-0 text-muted-foreground">
        {value}
        {resetsAtMs === null
          ? ""
          : ` · resets ${formatRelative(resetsAtMs, now)} (${formatClock(resetsAtMs)})`}
      </span>
    </li>
  );
}

/** The endpoint probe block: numeric limits from the configured API. */
function ProbeDetails({ probe, now }: { probe: ProbeSnapshot; now: number }) {
  const status = probeStatusOf(probe);
  const model = modelShortName(probe.model) ?? probe.model;
  return (
    <div className="pt-1">
      <div className="flex flex-wrap items-center justify-between gap-2 pb-1">
        <span className="flex items-center gap-2 font-medium">
          <Icon name="Zap" className="size-3.5" aria-hidden="true" />
          {model === null ? "Endpoint probe" : `Endpoint probe · ${model}`}
        </span>
        <span className="text-muted-foreground">
          <StatusDot status={status} /> {status} · updated{" "}
          {formatRelative(probe.observedAt, now)}
        </span>
      </div>
      {probe.error !== null ? (
        <p className="py-1 text-red-600 dark:text-red-400">{probe.error}</p>
      ) : (
        <ul className="divide-y divide-border">
          <ProbeMetricRow
            label="Requests"
            remaining={probe.remainingRequests}
            limit={probe.limitRequests}
            resetsAtMs={probe.resetRequestsAtMs}
            now={now}
          />
          <ProbeMetricRow
            label="Tokens"
            remaining={probe.remainingTokens}
            limit={probe.limitTokens}
            resetsAtMs={probe.resetTokensAtMs}
            now={now}
          />
        </ul>
      )}
    </div>
  );
}

/** The provider events block: windows bb's bridges reported. */
function EntryDetails({ entry, now }: { entry: RateLimitEntry; now: number }) {
  return (
    <div className="pt-1">
      <div className="flex flex-wrap items-center justify-between gap-2 pb-1">
        <span className="flex items-center gap-2 font-medium">
          <Icon name="Gauge" className="size-3.5" aria-hidden="true" />
          {entry.providerId}
        </span>
        <span className="text-muted-foreground">
          {kindLabel(entry.kind)} · updated {formatRelative(entry.observedAt, now)}
        </span>
      </div>
      {entry.windows.length === 0 ? (
        <p className="py-1 text-muted-foreground">No windows reported.</p>
      ) : (
        <ul className="divide-y divide-border">
          {entry.windows.map((window) => (
            <WindowRow
              key={`${window.providerKey ?? ""}|${window.label ?? ""}`}
              label={windowDisplayName(window)}
              status={window.status}
              resetsAtMs={window.resetsAtMs}
              now={now}
            />
          ))}
        </ul>
      )}
      {entry.reachedReason === null ? null : (
        <p className="pt-1 text-amber-600 dark:text-amber-400">
          {entry.reachedReason}
        </p>
      )}
      {entry.overageStatus !== null && entry.overageStatus !== "allowed" ? (
        <p className="pt-1 text-muted-foreground">
          Overage: {entry.overageStatus}
          {entry.overageReason === null ? "" : ` — ${entry.overageReason}`}
        </p>
      ) : null}
    </div>
  );
}

/** The expanded part of the segment: probe numbers and provider windows. */
function SegmentDetails(props: { threadId: string; isExpanded: boolean }) {
  const selection = useComposer().selection;
  const activeModel = selection?.model ?? null;
  const { state } = useThreadSegment(props.threadId, activeModel);
  const now = useNow();
  if (!props.isExpanded || state === null) return null;
  const showProbe =
    state.probe !== null && probeMatchesModel(state.probe, activeModel);
  return (
    <div className="w-full space-y-2 rounded-lg border border-border bg-card px-3 py-2 text-xs">
      {showProbe ? <ProbeDetails probe={state.probe!} now={now} /> : null}
      {state.entry === null ? null : <EntryDetails entry={state.entry} now={now} />}
      {state.probePending && !showProbe ? (
        <p className="pt-1 text-muted-foreground">
          Probing {modelShortName(activeModel) ?? "the active model"}…
        </p>
      ) : null}
      {state.probeHint?.long != null ? (
        <p className="pt-1 text-muted-foreground">{state.probeHint.long}</p>
      ) : null}
    </div>
  );
}

/** Visible when the summary would show anything (numbers, state, or guidance). */
function useSegmentVisible({ threadId }: { threadId: string }): boolean {
  const selection = useComposer().selection;
  const activeModel = selection?.model ?? null;
  const { state } = useThreadSegment(threadId, activeModel);
  const now = useNow();
  return state !== null && segmentText(state, activeModel, now) !== null;
}

function ProviderCard({ entry }: { entry: RateLimitEntry }) {
  const now = useNow();
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Icon name="Gauge" className="size-4 text-muted-foreground" aria-hidden="true" />
            {entry.providerId}
          </CardTitle>
          <StatusBadge status={entry.status} />
        </div>
        <p className="text-xs text-muted-foreground">
          {kindLabel(entry.kind)} · updated {formatRelative(entry.observedAt, now)}
        </p>
      </CardHeader>
      <CardContent className="text-sm">
        {entry.windows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No windows reported.</p>
        ) : (
          <ul className="divide-y divide-border">
            {entry.windows.map((window) => (
              <WindowRow
                key={`${window.providerKey ?? ""}|${window.label ?? ""}`}
                label={windowDisplayName(window)}
                status={window.status}
                resetsAtMs={window.resetsAtMs}
                now={now}
              />
            ))}
          </ul>
        )}
        {entry.reachedReason === null ? null : (
          <p className="pt-2 text-sm text-amber-600 dark:text-amber-400">
            {entry.reachedReason}
          </p>
        )}
        {entry.overageStatus !== null && entry.overageStatus !== "allowed" ? (
          <p className="pt-2 text-sm text-muted-foreground">
            Overage: {entry.overageStatus}
            {entry.overageReason === null ? "" : ` — ${entry.overageReason}`}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

function RateLimitsPage() {
  const { data, error } = useRateLimitEntries();
  const entries = data?.entries ?? null;
  const probe = data?.probe ?? null;
  const hint = data?.probeHint ?? null;
  const now = useNow();
  const probeModel = probe === null ? null : modelShortName(probe.model);
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl px-4 pb-4 pt-3 md:px-5 md:pt-4">
        <p className="text-sm text-muted-foreground">
          Numeric limits for the model you are working with, probed from the
          endpoint it resolves to, plus the latest rate limits each provider
          reported in bb threads. Agents can read them with{" "}
          <code>bb rate-limits status</code>.
        </p>
        {error === null ? null : (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="mt-4 space-y-3">
          {entries === null && probe === null && hint === null ? (
            <EmptyState>Loading rate limits…</EmptyState>
          ) : (
            <>
              {probe === null ? null : (
                <Card>
                  <CardHeader className="pb-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <CardTitle className="flex items-center gap-2 text-sm">
                        <Icon
                          name="Zap"
                          className="size-4 text-muted-foreground"
                          aria-hidden="true"
                        />
                        {probeModel === null
                          ? "Endpoint probe"
                          : `Endpoint probe · ${probeModel}`}
                      </CardTitle>
                      <StatusBadge status={probeStatusOf(probe)} />
                    </div>
                  </CardHeader>
                  <CardContent className="text-sm">
                    {probe.error !== null ? (
                      <p className="text-sm text-red-600 dark:text-red-400">
                        {probe.error}
                      </p>
                    ) : (
                      <ul className="divide-y divide-border">
                        <ProbeMetricRow
                          label="Requests"
                          remaining={probe.remainingRequests}
                          limit={probe.limitRequests}
                          resetsAtMs={probe.resetRequestsAtMs}
                          now={now}
                        />
                        <ProbeMetricRow
                          label="Tokens"
                          remaining={probe.remainingTokens}
                          limit={probe.limitTokens}
                          resetsAtMs={probe.resetTokensAtMs}
                          now={now}
                        />
                      </ul>
                    )}
                  </CardContent>
                </Card>
              )}
              {entries !== null && entries.length > 0
                ? entries.map((entry) => (
                    <ProviderCard key={entry.providerId} entry={entry} />
                  ))
                : null}
              {hint?.long != null && probe === null ? (
                <EmptyState>{hint.long}</EmptyState>
              ) : null}
              {entries !== null &&
              entries.length === 0 &&
              probe === null &&
              hint === null ? (
                <EmptyState>
                  No provider rate limits observed yet. Run a turn in a
                  thread; providers that report rate limits (Claude Code,
                  Codex, ACP bridges) appear here.
                </EmptyState>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadContextSegment({
    id: "rate-limits",
    title: "Rate limits",
    // bb's groups sort "1_thread" and "3_git"; this one sits between them.
    group: "2_provider",
    summary: SegmentSummary,
    details: SegmentDetails,
    useVisible: useSegmentVisible,
  });
  app.slots.navPanel({
    id: "rate-limits",
    title: "Rate limits",
    icon: "Gauge",
    path: "rate-limits",
    component: RateLimitsPage,
  });
});
