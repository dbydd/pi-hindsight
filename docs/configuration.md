# Configuration

Pi Hindsight resolves configuration from defaults, global config, project config, and environment variables.

## Precedence

Config is loaded from:

1. `~/.pi/agent/hindsight.json` or `.jsonc` under Pi; `~/.omp/agent/hindsight.json` or `.jsonc` under omp
2. `hindsight.json` or `hindsight.jsonc` in the host's project config dir (`.pi` under Pi, `.omp` under omp)
3. environment variables

If both `.json` and `.jsonc` exist at the same scope, `.json` wins. Config is normalized after merging. Unknown fields are ignored, and invalid values fall back to defaults.

Environment variables win the effective value. Project/user stored values can still be edited for future runs after the environment override is removed.

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

| Field           | Meaning                                                                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`            | Stable unique key. Layers merge by `id`; tools and the decision model reference it. Defaults to `alias`.                                                    |
| `alias`         | `project` or `user`. Keeps the coding / life role semantics (tags, `derive`, shared observations). Implied by a reserved `id`, and supplies a missing `id`. |
| `bankId`        | Concrete Hindsight bank. Required for `alias: "user"`; optional for coding entries.                                                                         |
| `enabled`       | Defaults to `true`. `{ "id": "x", "enabled": false }` disables a bank from any layer.                                                                       |
| `access`        | `read`, `write`, or `read-write` (default). Read paths skip `write` entries; write paths skip `read` entries.                                               |
| `derive`        | Only read on a coding entry (`project` role): `repo`, `cwd`, `manual`, `basename`. Ignored elsewhere.                                                       |
| `tagGroups`     | Explicit Hindsight tag groups; replaces derived tags for that entry.                                                                                        |
| `banksFallback` | Bank ids used when the decision model fails or returns unusable output. Replaced wholesale per layer, not merged.                                           |

**Layer merge:** global Pi config is the base and the repo config overlays it. Entries merge by `id` — field-level, with `mission`, `recall`, and `retain` merged one level deeper and `tagGroups` replaced whole. A new `id` appends to the tail, so recall order stays stable. `banksFallback` is replaced wholesale.

**Legacy three-slot configs still work.** A `banks` object is normalized on read: `project` (or `coding`) becomes the coding entry, and `user` (or `global`, or `life`) becomes the life entry, carrying `enabled`, `bankId`, `derive`, and mission fields with them. Writers only ever produce the array form.

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
    "timeoutMs": 3000,
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

Agents can get and patch this field through `hindsight_config` as `userScopeTags` (string array; empty array allowed). Patches write `scope.userScopeTags`. There is no TUI field.

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
writable through `hindsight_config`.

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

Optional model-driven bank routing. When enabled, one extra model call per turn answers a small
question table: whether the turn injects recall, and for every offered bank whether recall reads
it and whether retain writes to it. Recall and retain then use that routing instead of a fixed
bank list.

```jsonc
{
  "decision": {
    "enabled": true,
    "model": "role:judge",
    "maxTokens": 200,
    "timeoutMs": 3000,
    "maxContextChars": 6000,
    "cacheTtlMs": 60000,
    "fallback": { "recallBanks": ["coding"], "retainBanks": ["coding"] },
  },
}
```

| Field                                  | Meaning                                                                                                                                                     |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                              | When false the layer decides nothing and the memory paths keep their own bank selection.                                                                    |
| `model`                                | `role:<name>` on a host that has model roles, or `<provider>/<modelId>` on every host. A role spec on a host without roles falls back to the session model. |
| `maxTokens`                            | Answer budget for backends that accept one.                                                                                                                 |
| `timeoutMs`                            | Per-attempt budget. A backend that exceeds it is abandoned and the next one is tried.                                                                       |
| `maxContextChars`                      | Budget for the recent-activity part of the prompt. The last user message and the task state are always included.                                            |
| `cacheTtlMs`                           | Reuse window for a decision, keyed by the offered bank ids and the last user message content.                                                               |
| `fallback.recallBanks` / `retainBanks` | Bank ids used when no backend answers. Empty means the top-level `banksFallback` list. Unknown ids are dropped at load time.                                |

**Context.** The prompt carries the last user message, the host task state (`unknown` when it
cannot be read, never "no tasks"), the recent activity that fits the budget, and every candidate
bank with its `access` and `description`.

**Routing rules.** Only enabled, access-compatible banks are offered: read routing skips `write`
entries, write routing skips `read` entries, and a bank id the model returns that was not offered
is dropped.

**Degradation.** The layer tries backends in order — a host-native judgment surface, a host
classifier, then a text bridge over any chat model — and ends at the fallback banks. It keeps
recall on and never raises into the calling turn, so an unreachable decision model costs routing
quality instead of memory.

**Status.** Automatic recall is wired: `recall.mode: "decision"` reads gate A and
`recall.bankMode: "decision"` reads gate B. Automatic retain still selects its own banks, so the
write half of the table above is not user-visible yet.
