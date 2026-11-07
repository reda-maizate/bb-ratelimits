Rate limits for the model you are working with — provider state captured
automatically from every thread turn, plus numeric limits probed from the
endpoint that model resolves to.

## What you get

- A **Rate limits** segment in every open thread's context row (above the
  composer) for the thread's active model: numeric `599/600 req · 858K/1M
  tok` values from the endpoint probe, plus the provider's status and
  windows when its bridge reports them — expandable for details. Switch
  models in the picker and the numbers follow within seconds.
- A **Rate limits** page in the left sidebar listing the probe's
  requests/tokens and every tracked provider's windows.
- `bb rate-limits status [--json]` and `bb rate-limits probe [--model <id>]
  [--json]` commands that print the same data from a terminal, for you or
  for agents.
- Live updates: a provider reports new state or a probe lands, and every
  open surface refreshes through a realtime signal.

## How it works

bb's provider bridges (Claude Code, Codex, ACP, …) publish rate-limit state
as `provider/rateLimits/updated` thread events while turns run. The plugin
listens for thread activity, reads each thread's newest rate-limit events
over the plugin SDK, and keeps the latest state per provider — rate-limit
state is account-scoped, so one provider's entry is shared across all its
threads. Older observations never regress newer ones.

Provider events carry statuses and windows but no numeric values, and bb
never sees the HTTP responses an agent process makes. For the numbers, the
plugin resolves the active model's endpoint — its provider prefix
(`scaleway/…`) against a built-in table of OpenAI-compatible providers,
with the key from one optional setting or the provider's standard
environment variable — and reads the six
`x-ratelimit-{limit,remaining,reset}-{requests,tokens}` headers off a
1-token probe request. No other tool's configuration files are read; the
key only ever travels to the endpoint its provider names.

When the endpoint cannot be resolved yet, the segment and the page say
exactly what to set (`bb plugin config rate-limits set apiKey <key>`, an
environment variable, or a `baseUrl`) instead of silently showing nothing.

The latest state is persisted in the plugin's own storage on the BB server,
so a reload or restart serves it immediately, and a background service
re-reconciles recent threads every ten minutes to close any gap. Probing
itself carries no timers at all: every request that completes in the active
thread (each `item/completed` and `turn/completed` event) makes the next
probe due, so the numbers always reflect what your last request just spent.

## For agents

The bundled skill tells an agent to read current limits with
`bb rate-limits status` (or `--json`), to force a fresh probe with
`bb rate-limits probe`, what each field means, and that an empty list just
means no provider has reported rate limits yet.
