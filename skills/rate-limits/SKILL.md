---
name: rate-limits
description: Show rate limits for the model you are working with — provider states reported in bb threads plus numeric x-ratelimit values probed from the endpoint that model resolves to. Use when the user asks about rate limits, usage windows, resets, remaining requests or tokens, or why a provider is blocked.
---

# Rate limits

`bb rate-limits status` prints the latest rate-limit state each provider has
reported to bb, captured automatically from every thread turn, plus the
numeric limits probed for the active model:

```
$ bb rate-limits status
Endpoint probe · scaleway/glm-5.3 · updated 8s ago
  requests: 599/600, resets in 8.5s
  tokens: 858K/1M, resets in 1m30s

claude-code  warning · Subscription window
  5h window: warning, resets in 12m
  weekly window: allowed, resets in 3d4h

codex  allowed · Subscription window
  weekly window: allowed, resets in 2d
```

Add `--json` for machine-readable output:
`{ "entries": [...], "probe": {...}, "probeHint": {...} }`.

`bb rate-limits probe [--model <id>] [--json]` forces a fresh probe now
(probing is otherwise purely event-driven: it fires after every request the
active thread completes, and when the user switches models). If it cannot
probe, its message says exactly what to set:
usually `bb plugin config rate-limits set apiKey <key>`, the provider's
standard environment variable, or `bb plugin config rate-limits set baseUrl
<https://…/v1>`.

## Reading the output

Each provider reports one entry with:

- `status` — overall: `allowed`, `warning`, `blocked`, or `unknown`.
- `kind` — what limits it: `subscription-window`, `credits`,
  `spend-control`, or `unknown`.
- `windows[]` — each limit window's `label`, `status`, and `resetsAtMs`
  (epoch ms; null when the provider did not report a reset).
- `reachedReason` — the provider's own text when a limit was reached.
- `overageStatus` / `overageReason` — overage behavior when reported.
- `observedAt` — epoch ms when the state was last seen.

The `probe` object (when the active model's endpoint resolves) carries the
model it targeted plus the numeric OpenAI-compatible headers:
`limitRequests`/`remainingRequests`/`resetRequestsAtMs` and
`limitTokens`/`remainingTokens`/`resetTokensAtMs` (epoch ms resets; null
when the endpoint did not send that header), `observedAt`, and `error` (null
unless the probe failed — a failed probe means its numbers are unknown, not
zero).

An empty entries list means no provider has reported rate limits yet; run a
turn in a thread first. A missing probe (or a `probeHint`) means the
endpoint for the active model is not resolved yet — follow the hint's
instructions.

## Where the data comes from

Providers publish their rate-limit state as
`provider/rateLimits/updated` thread events while turns run. The plugin
keeps the latest state per provider and refreshes it live; the same data
appears beside a thread's composer and on its Rate limits page. State older
than the newest event never overwrites it, so switching models or providers
cannot regress the display.

Provider events carry no numeric values, so those come from the endpoint
probe: the active model's provider prefix (e.g. `scaleway` in
`scaleway/glm-5.3`) resolves an OpenAI-compatible endpoint from a built-in
provider table (scaleway, openai, openrouter, groq, mistral, together,
cerebras, deepseek, xai, perplexity, fireworks), the key comes from the
`apiKey` setting or the provider's standard environment variable, and the
namespaced model id loses its prefix for the API call. Only the active
model's numbers are shown.
