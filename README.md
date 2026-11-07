# bb-ratelimits

A [bb](https://getbb.app) plugin that shows **rate limits for the model you are working with** — captured automatically from every thread turn, plus numeric `x-ratelimit-*` values probed from the endpoint that model resolves to. Usually with **zero configuration**.

```
Rate limits ● 599/600 req · 858K/1M tok · resets in 8.5s
```

![The rate-limits segment above a thread composer, and the expanded
windows](screenshots/overview.png)

The bb sibling of
[opencode-ratelimits](https://github.com/reda-maizate/opencode-ratelimits),
which shows the same idea in the OpenCode TUI footer. That plugin hooks
`http.response` and reads headers passively; bb never sees the HTTP responses
an agent process makes, so this plugin reads bb's own
`provider/rateLimits/updated` events **and** probes the endpoint the active
model points at.

## What you get

- **Context row above every open thread's composer** — numeric limits for the
  thread's active model with a status dot (green, amber under 20% remaining,
  red at zero), plus the provider's status and windows when its bridge reports
  them. Switch models in the picker and the numbers follow within seconds.
- **Rate limits page** — a sidebar page with the probe's requests/tokens and
  every tracked provider's windows, resets, and limit reasons.
- **CLI** — `bb rate-limits status [--json]` and `bb rate-limits probe
  [--model <id>] [--json]`, for you or for agents.
- **Live updates** — a provider reports new state or a probe lands, and every
  open surface refreshes through a realtime signal.

## Install

From a checkout of this repository:

```sh
git clone https://github.com/reda-maizate/bb-ratelimits.git
cd bb-ratelimits
bb plugin install .
```

Or install directly from GitHub without cloning:

```sh
bb plugin install https://github.com/reda-maizate/bb-ratelimits
# or pinned to a branch:
bb plugin install git:https://github.com/reda-maizate/bb-ratelimits.git@main
# or tracking the latest release tag:
bb plugin install git:https://github.com/reda-maizate/bb-ratelimits.git@^0.5.0
```

Then reload plugins (or restart bb). The plugin appears as **Rate Limits** in
`bb plugin list`.

> Requires bb 0.48+ and the plugin SDK 0.6.94+ (declared in `package.json` →
> `engines`; bb checks them for you).

## Setup — usually nothing

The context segment reads the thread's active model from the composer's
picker — e.g. `scaleway/glm-5.3` — and resolves the endpoint from the
**provider prefix** against a built-in table of OpenAI-compatible providers:

| Provider prefix | Base URL | Environment variables |
| --- | --- | --- |
| scaleway | `https://api.scaleway.ai/v1` | `SCALEWAY_API_KEY`, `SCW_API_KEY`, `SCW_SECRET_KEY` |
| openai | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| openrouter | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| groq | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` |
| mistral | `https://api.mistral.ai/v1` | `MISTRAL_API_KEY` |
| together | `https://api.together.xyz/v1` | `TOGETHER_API_KEY` |
| cerebras | `https://api.cerebras.ai/v1` | `CEREBRAS_API_KEY` |
| deepseek | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` |
| xai | `https://api.x.ai/v1` | `XAI_API_KEY` |
| perplexity | `https://api.perplexity.ai` | `PERPLEXITY_API_KEY` |
| fireworks | `https://api.fireworks.ai/inference/v1` | `FIREWORKS_API_KEY` |

The API key comes from (in order):

1. the `apiKey` plugin setting — `bb plugin config rate-limits set apiKey <key>`
   (stored as a secret), which also **overrides** the environment if both exist;
2. the provider's standard environment variable above, if the bb server
   process inherits it (a desktop-launched bb.app may not — see
   Troubleshooting);
3. `RATE_LIMITS_API_KEY` for custom base URLs.

So a Scaleway user with `SCALEWAY_API_KEY` in bb's environment needs **no
configuration at all**; otherwise the one thing to set is the `apiKey`
setting. When something is missing, the segment, the page, and the CLI say
exactly what to set instead of silently hiding.

The probe sends a 1-token chat completion for the active model and reads the
six OpenAI-compatible headers
(`x-ratelimit-{limit,remaining,reset}-{requests,tokens}`). Numbers from a 429
are kept — a refused request is exactly the signal you want. Namespaced model
ids lose their prefix for the call (`scaleway/glm-5.3` → `glm-5.3`), and deeper
ids survive (`openrouter/anthropic/…` → `anthropic/…`). No other tool's
configuration files are read; the key only ever travels to the endpoint its
provider names, never to logs or storage.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `baseUrl` | `""` | A full URL for endpoints outside the table, or a provider name (`scaleway`, `openrouter`, …) to override the model-prefix lookup. |
| `apiKey` | unset | The endpoint's API key. Overrides the environment variable. Stored as a secret. |

Settings are all optional; there is no cooldown or polling interval — probing is
purely event-driven.

```sh
bb plugin config rate-limits set apiKey <key>
bb plugin config rate-limits set baseUrl https://api.example.com/v1
bb plugin config rate-limits unset apiKey
```

## CLI

```sh
bb rate-limits status              # probe snapshot + every tracked provider
bb rate-limits status --json      # machine-readable
bb rate-limits probe              # force a probe for the active model now
bb rate-limits probe --model scaleway/glm-5.3 --json
```

## Troubleshooting

- **"no API key set for …"** — the endpoint resolved; set the key with
  `bb plugin config rate-limits set apiKey <key>` or export the provider's
  environment variable.
- **Environment variable not picked up** — the bb server must see it. A
  desktop-launched bb.app does not inherit shell exports from
  `~/.zshenv`/`~/.zprofile`; launch bb from a terminal that exports it, or use
  the `apiKey` setting (the dependable path).
- **"unknown provider"** — the model's prefix doesn't name a known provider
  (e.g. you named your OpenCode provider `scw`). Set `baseUrl` to the full URL
  or to the provider name it should behave like.
- **`HTTP 401`** — the probe ran and the endpoint rejected the key; check the
  key belongs to the same provider the model prefix names.
- **No provider entries at all** — no provider has reported rate limits yet;
  run a turn in a thread first. Note that ACP bridges (OpenCode, Cursor)
  never emit `provider/rateLimits/updated` events, so for them the probe is
  the numeric source (bridges like Claude Code and Codex do report).

## How it works

- Providers publish rate-limit state as `provider/rateLimits/updated` thread
  events while turns run. The plugin listens for thread activity, reads each
  thread's newest rate-limit events over the plugin SDK, and keeps the latest
  state **per provider** (rate-limit state is account-scoped, so entries are
  shared across threads; older observations never regress newer ones).
- The probe is **purely event-driven — no timers, no polling**. It fires
  after every request from the active thread (each completed item and turn
  means the account just spent requests, so the numbers should reflect it)
  and on every model switch; the CLI can force one on demand.
- The latest provider states, probe snapshot, and active model persist in the
  plugin's own storage, so a reload or restart serves them immediately.

## Development

```sh
npm install
npm run typecheck
npm test          # 85 tests: pure logic + fake plugin host + stubbed fetch
bb plugin build
```

Endpoint resolution, header parsing, and tracking logic live in `shared.ts`
and are unit-tested without a bb server; `server.test.ts` drives the backend
against the official fake plugin host, `app.test.tsx` renders both UI surfaces.

## License

MIT — see [LICENSE](LICENSE).
