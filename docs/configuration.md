# Configuration

Pi Hindsight resolves configuration from defaults, global config, project config, and environment variables.

## Precedence

Config is loaded from:

1. `~/.pi/agent/hindsight.json` or `.jsonc` under Pi; `~/.omp/agent/hindsight.json` or `.jsonc` under omp
2. `hindsight.json` or `hindsight.jsonc` in the host's project config dir (`.pi` under Pi, `.omp` under omp)
3. environment variables

If both `.json` and `.jsonc` exist at the same scope, `.json` wins. Config is normalized after merging. Unknown fields are ignored, and invalid values fall back to defaults. Comments and trailing commas are accepted in **both** suffixes: the reader parses every config file as JSONC, so `hindsight.json` may carry `//` lines too.

Environment variables win the effective value. Project/user stored values can still be edited for future runs after the environment override is removed.

## `$schema`

The first time guided setup or the memory tools write a config file, the file starts with a
`$schema` line pointing at this package's published schema:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/dbydd/pi-hindsight/main/schemas/hindsight.schema.json",
  "banks": [{ "id": "coding", "alias": "project", "bankId": "pi-project-my-repo" }],
}
```

It is an editor hint only — it buys completion and validation for the `banks[]` entries, which are
the most hand-written part of a config. The loader ignores the key, and deleting the line changes
nothing. Existing files are never rewritten to add it.

## Host config paths

Runtime truth outranks package constants: an omp process still resolves `@earendil-works/*`, and that copy reports pi's `.pi` and `~/.pi/agent`. The extension resolves the host config dir in this order:

1. `PI_CODING_AGENT_DIR` / `PI_CONFIG_DIR` — explicit override, honored by both hosts
2. the live session file — `<config dir>/agent/sessions/<project>/<file>.jsonl`
3. omp's `@oh-my-pi/pi-utils/dirs`, when the omp plugin tree provides it
4. `@earendil-works/pi-coding-agent` — correct under pi
5. `$HOME/<dir>/agent` — `<dir>` is `PI_CONFIG_DIR`, else the last-resort `.pi`

That yields:

- **Global agent dir** — `~/.pi/agent` under Pi, `~/.omp/agent` under omp.
- **Project config dir** — `.pi` under Pi, `.omp` under omp.
- **Project state dir** — `<project config dir>/hindsight`. `recall.lastRecallPath`, `retain.queuePath`, `import.manifestPath`, and `import.checkpointPath` all default inside it, so sidecars, queues, cursors, receipts, and import checkpoints follow the same host.

## Common environment variables

```bash
export HINDSIGHT_BASE_URL=http://localhost:8888
export HINDSIGHT_API_TOKEN=...
# Legacy fallback still accepted when TOKEN is unset:
# export HINDSIGHT_API_KEY=...
# or point config/env at another env var without storing the raw key:
export HINDSIGHT_API_KEY_REF=HINDSIGHT_API_TOKEN

export PI_HINDSIGHT_ENABLED=true
export PI_HINDSIGHT_PROJECT_BANK_ID=pi-project-my-repo
export PI_HINDSIGHT_USER_BANK_ID=user-luxus
# Legacy fallback still works during migration:
# export PI_HINDSIGHT_GLOBAL_BANK_ID=global-luxus
# Optional automatic-recall quality floors (local drop before inject):
# export PI_HINDSIGHT_MIN_RERANKER=0.2
# export PI_HINDSIGHT_MIN_SEMANTIC=0.65
```

Project config SecretRef shape:

```json
{
  "hindsight": {
    "apiKey": { "source": "env", "name": "HINDSIGHT_API_TOKEN" }
  }
}
```

## Memory profiles

- **Project + User**: project bank enabled; user bank enabled; user bank settings are written once to global Pi config.
- **Project Only**: project bank enabled; user bank disabled; automatic retain writes to the project bank.
- **User Only**: project bank disabled; user bank enabled from global Pi config.
- **Recall Only**: automatic recall enabled; automatic retain disabled; explicit tools and imports remain available.

When a profile uses user memory, guided setup asks for a user bank ID and writes it to global Pi config. Override it later with `PI_HINDSIGHT_USER_BANK_ID`, the `user`-alias entry's `bankId` in the global hindsight config (`~/.pi/agent/hindsight.json` under Pi, `~/.omp/agent/hindsight.json` under omp), or the setup TUI if you prefer a different shared bank. Legacy `PI_HINDSIGHT_GLOBAL_BANK_ID`, `banks.global`, and `global-only` config names are migrated/supported during transition.

## Bank list (`banks`)

`banks` is an **ordered array** of bank entries. Each entry needs a stable `id`; the two reserved role names are `project` (coding) and `user` (life). An entry may carry one as its `id` or as its `alias` — both mean the same role bank, so the shortest form is a single field: `{ "alias": "project" }` is an enabled, read-write coding bank whose bank is derived from the repo path.

```jsonc
{
  "banks": [
    {
      "id": "coding",
      "alias": "project",
      "bankId": "pi-coding",
      "enabled": true,
      "access": "read-write",
      "derive": "manual",
      "description": "This repo's architecture, tasks, decisions, and constraints",
      "mission": { "retain": "…", "reflect": "…", "observations": "…" },
      "recall": { "enabled": true, "maxTokens": 800, "preamble": "…" },
      "retain": { "enabled": true, "mode": "decision" },
      "tagGroups": [],
    },
    { "id": "life", "alias": "user", "bankId": "agent-global-stable", "access": "read-write" },
  ],
  "banksFallback": ["coding"],
}
```

| Field           | Meaning                                                                                                                                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`            | Stable unique key. Layers merge by `id`; tools and the decision model reference it. Defaults to `alias`.                                                                                                                                 |
| `alias`         | `project` or `user`. Keeps the coding / life role semantics (tags, `derive`, shared observations). Implied by a reserved `id`, and supplies a missing `id`.                                                                              |
| `bankId`        | Concrete Hindsight bank. Required for `alias: "user"`; optional for coding entries.                                                                                                                                                      |
| `enabled`       | Defaults to `true`. `{ "id": "x", "enabled": false }` disables a bank from any layer.                                                                                                                                                    |
| `access`        | `read`, `write`, or `read-write` (default). Read paths skip `write` entries; write paths skip `read` entries.                                                                                                                            |
| `derive`        | Only read on a coding entry (`project` role): `repo`, `cwd`, `manual`, `basename`. Ignored elsewhere.                                                                                                                                    |
| `description`   | What the bank holds, in plain content terms; shown to the decision model when it picks banks. Access and write policy belong in `access` and `retain.mode`, not here — see **Writing bank descriptions** under **Decision layer** below. |
| `retain`        | Automatic write routing for this entry: `enabled` and `mode`. See **Automatic retain modes** below.                                                                                                                                      |
| `tagGroups`     | Explicit Hindsight tag groups; replaces derived tags for that entry.                                                                                                                                                                     |
| `banksFallback` | Bank ids used when the decision model fails or returns unusable output. Replaced wholesale per layer, not merged.                                                                                                                        |

**Layer merge:** global Pi config is the base and the repo config overlays it. Entries merge by `id` — field-level, with `mission`, `recall`, and `retain` merged one level deeper and `tagGroups` replaced whole. A new `id` appends to the tail, so recall order stays stable. `banksFallback` is replaced wholesale.

**Legacy three-slot configs still work.** A `banks` object is normalized on read: `project` (or `coding`) becomes the coding entry, and `user` (or `global`, or `life`) becomes the life entry, carrying `enabled`, `bankId`, `derive`, and mission fields with them. Writers only ever produce the array form.

### Automatic retain modes (`banks[].retain`)

Which banks a completed turn's transcript is written to. Every entry carries its own mode; there is
no global switch beyond `retain.enabled`.

```jsonc
{
  "banks": [
    { "id": "coding", "alias": "project" },
    {
      "id": "life",
      "alias": "user",
      "bankId": "agent-global-stable",
      "retain": { "mode": "decision" },
    },
    { "id": "scratch", "bankId": "scratch-bank", "retain": { "mode": "explicit-only" } },
  ],
}
```

| Field            | Meaning                                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `retain.enabled` | Defaults to `true`. `false` keeps the entry out of automatic writes entirely.                                                     |
| `retain.mode`    | `always`, `decision`, or `explicit-only`. Defaults to `always` on the coding-role entry and `explicit-only` on every other entry. |

- `always` — the entry is written on every retain turn.
- `decision` — the entry is offered to the decision layer, which answers one question per entry.
  This is the only mode that makes the decision model decide anything about writes.
- `explicit-only` — the entry is never written automatically; `hindsight_retain` and
  `hindsight_retain_user` can still write it.

Write candidates are entries that are `enabled`, are not `access: "read"`, are not
`retain.enabled: false`, and are not `explicit-only`. The coding-role entry (the `project` alias, the
`project` id, or the first entry) always writes to the derived project bank; every other entry needs
its own `bankId` and is skipped when it has none.

A config with no `decision` entry never calls the decision model: routing stays exactly the
pre-decision behavior, with no extra call and no added latency. When a `decision` entry exists and
the model cannot answer (disabled, no model, timeout, backend failure), those entries fall back to
`decision.fallback.retainBanks`, then `banksFallback`, filtered to entries that still qualify as
write candidates. `always` entries are written either way. If nothing is left to write, that turn's
transcript is not written anywhere: the retain cursor still advances past it and the skip is
reported — a notification, and a `phase: "retain"` telemetry event carrying the reason and any
refused bank ids.

**Legacy `userRetain.mode` / `globalRetain.mode`.** The field is single-valued (`explicit-only`)
today; it is mapped onto the user entry's `retain.mode` at load time, so an old config keeps
expressing the User Bank write mode in the new place. An entry that states its own mode wins.

## Isolated bank naming

The coding entry's `bankId` always wins. If it is unset, its `derive` chooses the name:

- `repo` / `cwd` (default): hashed `pi-project-<slug>-<pathHash>`
- `basename`: git-root folder name as-is (opt-in; share isolated banks with folder-named clients)
- `manual`: set `bankId` explicitly

Domain-tagged mode still requires an explicit coding bank id. See [Project identity](project-identity.md).

## Bank settings display

Pi Hindsight distinguishes local Pi behavior from bank-owned Hindsight settings. Setup and status surfaces show both:

- `Location: Project` or `Location: User` describes the Pi memory route.
- `Bank: <bank-id>` names the concrete Hindsight bank that owns missions, config overrides, mental models, and directives.

Mission text, bank config overrides, bank templates, mental models, and directives remain Hindsight bank settings, not normal Pi JSON config. Manage them in the Hindsight control-plane web UI. `/hindsight` status surfaces resolved bank config and override counts read-only.

## Compatibility and runtime identity

Pi Hindsight targets the official `@vectorize-io/hindsight-client` package and the current documented Hindsight REST/OpenAPI behavior. The runtime client sends a `pi-hindsight/<package-version>` user-agent on SDK requests. `/hindsight` and debug/status diagnostics surface local package identity, configured server URL, append-mode support, bank reachability, queue state, and failed-consolidation hints where the server exposes them.

## Setup TUI

Run:

```text
/hindsight
```

The setup TUI opens with status facts, then offers focused edit tabs for connection, banks, recall, retain, import, and UI settings. Setting rows show the effective value plus its source (`project`, `global`, `env`, or `default`). Setting descriptions, default values, and all layers are shown inside edit prompts.

Deployment choices cover Hindsight Cloud, an existing local/external API, and local `hindsight-embed` guidance. The local `hindsight-embed` option gives commands to run yourself and can set the base URL to `http://localhost:8888`; it does not manage daemons.

## Advanced project config example

Bank missions are intentionally absent from this JSON example. Hindsight bank configuration/database is the source of truth for retain, reflect, and observation mission text; Pi JSON should only select banks and extension behavior. Existing mission fields in older configs are treated as legacy fallbacks.

Paths below are Pi's resolved defaults; see [Host config paths](#host-config-paths).

```json
{
  "banks": [
    {
      "id": "coding",
      "alias": "project",
      "bankId": "pi-project-my-repo",
      "derive": "manual"
    },
    {
      "id": "life",
      "alias": "user",
      "enabled": false,
      "bankId": "user-luxus"
    }
  ],
  "banksFallback": ["coding"],
  "decision": {
    "model": "role:judge",
    "timeoutMs": -1,
    "fallback": { "recallBanks": ["coding"], "retainBanks": ["coding"] }
  },
  "recall": {
    "budget": "mid",
    "maxTokens": 800,
    "types": ["observation"],
    "includeSourceFacts": false,
    "maxSourceFactsTokens": 4096,
    "roles": ["user", "assistant"],
    "contextTurns": 2,
    "maxQueryChars": 800,
    "includeRepoHintsInQuery": true,
    "storeLastRecall": false,
    "storeLastRecallFailures": false,
    "lastRecallPath": ".pi/hindsight/last-recall.json",
    "topK": 8,
    "timeoutMs": 40000,
    "cacheTtlMs": 60000,
    "injectionPosition": "append",
    "mode": "every-turn",
    "bankMode": "all",
    "minScores": {
      "reranker": 0.2,
      "semantic": 0.65
    }
  },
  "observations": {
    "enabled": true,
    "scopes": [["harness:pi"], ["repo:{repoKey}"]]
  },
  "retain": {
    "queuePath": ".pi/hindsight/retain-queue.jsonl",
    "flushIntervalMs": 30000,
    "periodicFlushMaxJobs": 1,
    "periodicFlushTimeoutMs": 2000,
    "updateMode": "append",
    "shutdownFlushMaxJobs": 10,
    "shutdownFlushTimeoutMs": 2000,
    "postRetainReflect": false,
    "beforeEnqueue": {
      "command": ["/usr/local/bin/retain-check"],
      "timeoutMs": 5000
    }
  },
  "import": {
    "manifestPath": ".pi/hindsight/import-manifest.json",
    "checkpointPath": ".pi/hindsight/import-checkpoint.json",
    "resume": true
  },
  "status": {
    "style": "text",
    "detail": "activity",
    "maxLength": 24,
    "showActivity": true
  },
  "notifications": {
    "startup": true,
    "recall": false,
    "retain": false
  }
}
```

### `scope.userScopeTags`

User/life bank recall filter (`any_strict`) for automatic inject and `hindsight_recall` / `hindsight_reflect`. Default: `["source:pi", "harness:pi"]`.

- `source:pi` matches source memories (world/experience facts).
- `harness:pi` matches observations, which inherit observation-scope tags rather than the full source-memory tag set.

An empty array (`[]`) disables the tag filter so anything in that bank can be recalled (bank-level isolation only). Invalid values fall back to the default. Do not remove `harness:pi` if you still want observation recall from the user bank under a tag filter.

Agents can read this field through `hindsight_config_get` and patch it through `hindsight_config_set` as `userScopeTags` (string array; empty array allowed). Patches write `scope.userScopeTags`. There is no TUI field.

```json
{
  "scope": {
    "userScopeTags": []
  }
}
```

### `recall.minScores` (optional)

Exact fields for automatic-recall score floors. **Defaults: no floors** (inject quality-filtered
top-k without score thresholds). When set, drop candidates whose returned `scores.semantic` /
`scores.reranker` /
`scores.final` / `scores.keyword` is a number strictly below the matching floor. Missing
`scores` or missing score fields **fail open** (keep the hit).

- Env overrides: `PI_HINDSIGHT_MIN_SEMANTIC`, `PI_HINDSIGHT_MIN_RERANKER` (merge over config for
  those fields).
- Independent of the `hindsight_recall` tool `minScores` argument (API passthrough on explicit
  tool calls).

Behavior, why defaults stay off, and a suggested starting floor: [Memory behavior → Recall quality](memory-behavior.md#recall-quality).

### `recall.mode`

When automatic recall runs. Four values:

- `every-turn` (default) — every context hook recalls, exactly as before. The decision model is not
  called unless `recall.bankMode` asks for it.
- `decision` — the decision model decides whether this turn injects at all; a "no" skips the turn
  without a recall call or injection.
- `interval` — recall only when both `recall.everyNTurns` context hooks have passed and
  `recall.minIntervalMs` has elapsed since the last recall a server answered. No decision call.
- `manual` — automatic recall is off; only explicit tools (`hindsight_recall`, `hindsight_reflect`)
  reach memory.

```json
{
  "recall": {
    "mode": "interval",
    "everyNTurns": 5,
    "minIntervalMs": 300000
  }
}
```

`everyNTurns` (default `5`) counts context hooks; `minIntervalMs` (default `0`, meaning no time gate)
counts milliseconds since the last successful recall. Both gates must be satisfied, so one of them
throttles on its own and `interval` with defaults recalls on every fifth turn.

### `recall.bankMode`

Which banks automatic recall reads.

- `all` (default) — every enabled, readable `banks` entry, in config order. Unchanged behavior.
- `decision` — the decision model picks the turn's read banks from that same candidate list. The
  picked entry ids replace the scope set for the turn; tag derivation and injection position are
  unchanged.

```json
{
  "recall": { "bankMode": "decision" },
  "decision": { "fallback": { "recallBanks": ["coding"] } }
}
```

When the decision model cannot answer, the read set comes from `decision.fallback.recallBanks`, then
`banksFallback`, both filtered to enabled, readable entries. A `bankMode: "decision"` config with an
empty fallback list therefore reads nothing on a failed decision — set `banksFallback` (or
`decision.fallback.recallBanks`) whenever you enable it. A model that answers "no banks" skips the
turn too.

### `retain.beforeEnqueue` (optional)

Runs a local argv command immediately before Retain Queue admission. The command is spawned without
a shell and receives canonical, sanitized Retain Job JSON on stdin. Exit `0` allows the job into the
queue; nonzero exit, timeout, spawn failure, or malformed config blocks before queue/Hindsight calls.
Stdout and stderr are discarded so checker output cannot leak into Pi logs. Absent by default; not
writable through `hindsight_config_set`.

```json
{
  "retain": {
    "beforeEnqueue": {
      "command": ["/usr/local/bin/retain-check"],
      "timeoutMs": 5000
    }
  }
}
```

## Decision layer (`decision`)

Optional model-driven bank routing. When enabled, the model answers a small question table: whether
the turn injects recall, and for every offered bank whether recall reads it and whether retain
writes to it. Recall and retain then use that routing instead of a fixed bank list. Each path makes
its own call with the candidates it can route to — recall at the context hook with the readable
banks, retain at agent end with the write candidates — and each call is cached on its own.

```jsonc
{
  "decision": {
    "enabled": true,
    "model": "role:judge",
    "maxTokens": 4096,
    "timeoutMs": -1,
    "cacheTtlMs": 60000,
    "fallback": { "recallBanks": ["coding"], "retainBanks": ["coding"] },
  },
}
```

|| Field | Meaning |
|| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
|| `enabled` | When false the layer decides nothing and the memory paths keep their own bank selection. |
|| `model` | `role:<name>` on a host that has model roles, or `<provider>/<modelId>` on every host. A role spec on a host without roles falls back to the session model. |
| `maxTokens` | Output cap per answer. `<= 0` means no cap: the field is left off the backend call and the transport keeps its own. |
| `timeoutMs` | Per-attempt budget in milliseconds. `<= 0` arms no timer, so only the caller's own signal can stop the call. |
| `maxContextChars` | Character budget for the recent-activity part of the prompt. The last user message and the task state are always included. |
| `threshold` | Probability at or above which a backend's numeric answer counts as "yes". Default `0.5`. Local models and cloud deciders calibrate differently, so retune it when you swap judge models. Values outside 0–1 fall back to the default. |
| `instructions.inject` | Gate A question text. No placeholders. An empty string falls back to the built-in default. |
| `instructions.read` | Gate B read question text, rendered per bank. Placeholders: `{bank}`, `{description}`, `{access}`. |
| `instructions.write` | Gate B write question text, rendered per bank. Placeholders: `{bank}`, `{description}`, `{access}`. |
| `cacheTtlMs` | Reuse window for a decision, keyed by the offered bank ids (tagged per path) and the last user message content. |
|| `fallback.recallBanks` / `retainBanks` | Bank ids used when no backend answers. Empty means the top-level `banksFallback` list. Unknown ids are dropped at load time. |

**Budgets.** `maxTokens` bounds only the answer, not the prompt, so it does not constrain the
model's context window; the default of 4096 sits above the 1024-token minimum thinking budget that
Anthropic-dialect proxies enforce, which a 200-token cap would trip on every call. `timeoutMs`
defaults to no timer: an api can run on any machine at any speed, and a local timer only aborts work
that would otherwise have answered.

`maxContextChars` is the one input-side number, and its effective value is:

1. the hand-written config value, when the file carries a usable positive integer;
2. otherwise the value derived from the resolved decision model — a quarter of its `contextWindow`
   in tokens, clamped to 2k–12k tokens, times 4 characters per token (8192 chars for a 32k model,
   48000 chars for a 200k+ model, 8192 chars for a model that reports no window);
3. otherwise the built-in default of 32768 characters.

**Context.** The prompt carries the last user message, the host task state (`unknown` when it
cannot be read, never "no tasks"), the recent activity that fits the budget, and every candidate
bank with its `access` and `description`.

### System One transport (`decision.systemOne`)

A rung that calls the gateway's System One endpoint directly, in the decision protocol's own
`noul` question form, instead of a host chat or judgment surface. Off by default, so the default
config makes no request this layer does not already make.

```jsonc
{
  "decision": {
    "systemOne": {
      "enabled": true,
      "baseUrl": "http://127.0.0.1:3425",
      "model": "group/decider",
      "apiKeyEnvVar": "GATEWAY_KEY",
    },
  },
}
```

| Field          | Meaning                                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| `enabled`      | When true the rung is built. Default `false`.                                                            |
| `baseUrl`      | Gateway base URL; the rung posts to `<baseUrl>/v1/systemone`. Default `http://127.0.0.1:3425`.           |
| `model`        | Decision model the gateway serves over System One. Default `group/decider`.                              |
| `apiKeyEnvVar` | Name of the environment variable holding the gateway key. The key itself is never stored in this config. |

Use it on Pi. Pi's model registry resolves chat models only, so a decision group never resolves
there and the typed rung stays empty; System One reaches the gateway's own protocol and does not
go through the host's model table. On omp the rung sits after the native judgment rung and before
the text bridge, so a host-native typed judgment still wins when the model offers one.

The rung is transport, not a separate decision: it gets the same state, the same question table,
and the same `decision.threshold` as every other rung, and a gateway failure is an ordinary failed
rung — the ladder moves on and the layer ends at `decision.fallback`. It speaks only `noul`
questions, so no prompt or question-text change is needed to use it.

### Decision questions (`decision.instructions`)

The text of the three questions the model answers. All three default to a text that says what the
gate controls, which state fields bear on it, and which way to lean when the state is ambiguous —
and all three lean toward **no**.

The lean matters more than it sounds. Injection spends context window on every turn it fires, so a
gate that fires on weak signals degrades into the every-turn recall this layer exists to replace.

Measured on a local judge (`clef-flash`, temperature 0, three identical runs), changing only gate
A's wording moved the answer from `inject = 0.151` to `0.862`. Below `decision.threshold` that
difference is a silent no-inject: `recall.mode: "decision"` looks healthy and recalls nothing.
Small models follow the text literally, so the text is a control surface, not decoration.

| Placeholder     | Substituted with                                                  | Gates       |
| --------------- | ----------------------------------------------------------------- | ----------- |
| `{bank}`        | The bank's config `id`                                            | read, write |
| `{description}` | The bank's `description`, or `no description provided` when unset | read, write |
| `{access}`      | The bank's `access` (`read`, `write`, or `read-write`)            | read, write |

Read and write questions are rendered per candidate bank, so each question the model sees names the
bank it is about and carries that bank's own description and access. An unset `description` is
spelled out rather than left empty, so the model reads "this bank says nothing about itself"
instead of interpreting a blank slot.

````jsonc
{
  "decision": {
    "instructions": {
      "inject": "Decide whether this turn injects a block of memories recalled from past sessions before the answer is generated. Default to no.",
      "read": "Decide whether automatic recall reads bank \"{bank}\" this turn. That bank holds: {description}.",
      "write": "Decide whether this turn's memory is retained into bank \"{bank}\". That bank holds: {description}."
    }
  }
}

An empty or whitespace-only string falls back to the built-in default for that gate, so a config
cannot mute a gate by blanking it.

**When you swap judge models, tune here first.** Model calibration differs — a local small model and
a cloud decider do not read the same sentence the same way. Adjust `decision.instructions` (and
`decision.threshold`) before changing any code; both are config precisely so that model changes do
not require a release.

### Writing bank descriptions

`banks[].description` is shown to the decision model when it picks banks. Describe **what the bank
holds**, in plain content terms. Access and write policy belong in `access` and `retain.mode`, not
in the description.

A description carrying policy text degrades bank selection: measured on the same local judge,
changing one bank's description from `"Read-only for agents; never auto-retained into."` to a plain
content description moved `read:agent-global-stable` from `0.477` to `0.648`. A policy sentence
asks the model to reason about permissions it cannot verify; a content sentence lets it match the
turn against what the bank actually contains.

```jsonc
// Better: what the bank holds.
{ "id": "coding", "description": "This repo's architecture, tasks, decisions, and constraints" }

// Worse: policy the model cannot verify, and `access` already says it.
{ "id": "coding", "description": "Read-only for agents; never auto-retained into." }
````

**Routing rules.** Only enabled, access-compatible banks are offered: read routing skips `write`
entries, write routing skips `read` entries, and a bank id the model returns that was not offered
is dropped. Write routing only offers entries in `retain.mode: "decision"` (see **Automatic retain
modes** above).

**Degradation.** The layer tries backends in order — a host-native judgment surface, a host
classifier, then a text bridge over any chat model — and ends at the fallback banks. It keeps
recall on and never raises into the calling turn, so an unreachable decision model costs routing
quality instead of memory.

**Choosing a backend.** The ladder is built from what the host can actually do, so pick the model and
read the rungs off the table:

| Host capability                                        | Rungs offered                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------- |
| omp model whose api answers typed judgments            | native judgment api, then the host text judge                                   |
| omp any other chat model                               | host text judge                                                                 |
| omp on-device keyword model (`local-inference`)        | none — no drivable port, so the ladder is empty and routing falls straight back |
| pi registry with a classifier surface                  | classifier, then a text bridge                                                  |
| pi registry with a chat transport only                 | text bridge                                                                     |
| no model, no transport, or an unbuildable host adapter | none — no rung, so the layer ends at the fallback banks                         |

`decision.model` picks the model; the rungs come from it. `role:<name>` reads the host role table
(`<provider>/<modelId>` on every host). The two hosts differ:

|                | omp                                                                              | pi                                                                               |
| -------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Role table     | yes — `role:<name>` resolves; an unresolved role falls back to the session model | no — `role:<name>` is a skipped level, never an error; the session model is used |
| Model ref      | resolved through the host model query facade, then the registry                  | registry lookup by `provider/modelId`                                            |
| Preferred spec | `role:judge` when a judge role exists, else `<provider>/<modelId>`               | `<provider>/<modelId>`                                                           |

A `<provider>/<modelId>` spec works on both hosts and is the portable choice. On pi, a `role:` spec
is not a failure — it degrades to the session model, so a shared config still decides instead of
erroring every turn.

**When it is worth enabling.** The defaults call no model at all: `recall.mode: "every-turn"`,
`recall.bankMode: "all"`, and coding `retain.mode: "always"` with no `decision` entry leaves routing
exactly as it was, with no extra call and no added latency. Turn the layer on when a real routing
question exists:

- More than one bank competes for the same traffic — a shared coding bank plus a life bank plus a
  scratch bank — and the right bank depends on the turn.
- Injecting every turn is too costly, or injecting on irrelevant turns adds noise: `recall.mode: "decision"`
  lets a turn skip itself.
- Long sessions drift across topics, so a per-turn read set beats a fixed list.

Keep it off when one bank serves everything (a single-bank or `Project Only` profile): the layer can
only choose among the candidates offered, and there is nothing to choose. If you turn it on, set
`decision.fallback.recallBanks` / `retainBanks` (or `banksFallback`) to a bank that exists — an empty
filtered set makes the round skip rather than route.

**Status.** Both halves are wired: `recall.mode: "decision"` reads gate A, `recall.bankMode:
"decision"` reads gate B, and `banks[].retain.mode: "decision"` reads the write half of the table
for that entry. Entries in `always` or `explicit-only` mode never reach the model, so a config with
no `decision` entry makes no decision call at all.
