# Tools and commands

## Public human surface

Pi Hindsight is **TUI-first**. Public slash commands:

```text
/hindsight
/hindsight:next-opt-out
```

- `/hindsight` opens a **thin** memory hub: status, short guided setup, and emergency actions (mode, next-opt-out, flush, doctor). Day-to-day mission/mental-model/config edits belong to agent tools, not a TUI field farm.
- `/hindsight:next-opt-out` skips automatic retain for the next agent run only (also available as hub key `x`).

### Hub keys

| Key | Action                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------ |
| `g` | Guided setup (profile, agent use, banks, optional templates + import)                                                    |
| `m` | Session mode: `normal` / `read-only` / `ignored`                                                                         |
| `x` | Next-opt-out: skip automatic retain for the next agent run                                                               |
| `f` | Flush retain queue                                                                                                       |
| `o` | Doctor diagnostics report (includes status tones)                                                                        |
| `n` | Write the project config (`.pi/hindsight.json` under Pi, `.omp/hindsight.json` under omp) with the selected project bank |
| `d` | Deployment / connection helpers                                                                                          |
| `i` | Historical import, including approved Pi session roots (dry-run first)                                                   |
| `t` | Apply starter bank template / mental-model set (dry-run first)                                                           |
| `a` | Toggle advanced settings (prefer agent tools for day-to-day edits)                                                       |
| `q` | Close                                                                                                                    |

Day-to-day mission, mental-model, knowledge-page, and config edits: prefer agent control-plane tools (`hindsight_status`, `hindsight_config_get` / `hindsight_config_set`, `hindsight_bank_list` / `hindsight_bank_get` / `hindsight_bank_set_mission`, `hindsight_mm_*`, `hindsight_kb_*`); the advanced TUI farm is an escape hatch, not the primary surface.

### Agent use and mental models

Config field `agentUse` is `coding` (default) or `conversation`.

- **coding** starter sets: `pi-coding-project`, `pi-coding-user`
- **conversation** starter sets: `pi-conversation-project`, `pi-conversation-user`

Legacy id `pi-user-preferences` still resolves to `pi-coding-user`.

When mental models exist on active banks and `mentalModels.inject` is true (default), their content is injected into automatic context alongside recall (ephemeral; not retained). List results are cached for `mentalModels.cacheTtlMs` (default 5 minutes).

Quality criteria and when the agent should **propose** mission/MM create, update, or refresh (dry-run first, never silent): [Mission and mental-model quality](mission-and-mental-model-quality.md).

## Model-facing tools

Available for the agent (control plane is agent-first; TUI is thin):

- `hindsight_recall`
- `hindsight_retain`
- `hindsight_retain_user` — explicit user-bank writes (global identity/prefs/cross-project workflows)
- `hindsight_seed_git` — opt-in gitlog seed
- `hindsight_reflect`
- `hindsight_status` — setup/banks/scope tones
- `hindsight_scope` — project id derivation
- `hindsight_config_get` — read the allowlisted effective config (no raw secrets)
- `hindsight_config_set` — patch allowlisted config keys (dry-run default on set)
- `hindsight_bank_list` — Pi-configured banks (id, bankId, role, enabled, access, retain mode); no Hindsight round-trip
- `hindsight_bank_get` — one bank's Hindsight-side facts (existence/stats/config)
- `hindsight_bank_set_mission` — patch retain/reflect/observations mission text (dry-run default)
- `hindsight_mm_list` — mental-model metadata only
- `hindsight_mm_get` — full mental-model content
- `hindsight_mm_create` — create one model (dry-run default)
- `hindsight_mm_update` — patch one model by id (dry-run default)
- `hindsight_mm_refresh` — regenerate one model's content (dry-run default)
- `hindsight_mm_delete` — delete one model by id (dry-run default)
- `hindsight_kb_tree` — knowledge-page tree (read-only)
- `hindsight_kb_search` — hybrid-search knowledge pages (read-only)
- `hindsight_kb_get` — read one knowledge page (read-only)
- `hindsight_kb_create_page` — create one knowledge page (dry-run default)
- `hindsight_kb_create_folder` — create one knowledge page folder (dry-run default)
- `hindsight_kb_update` — patch one knowledge page or folder (dry-run default)
- `hindsight_kb_delete` — delete one knowledge page or folder (dry-run default)
- `hindsight_kb_seed_taxonomy` — seed the fixed five-page coding taxonomy (dry-run default; idempotent)
- `hindsight_kb_export` — full-bank markdown bundle (read-only)
- `hindsight_scope_migrate` — dry-run dual-tag / legacy `repo:` migration plan + local receipt (never rewrites)

Knowledge-page tools require a knowledge-base-capable client/server; pages are tool-driven, not auto-injected.

### Tool exposure and discovery

Exposure is generated from one table (`extensions/operations/tool-presentation.ts`) and stamped on each registered tool; the same object carries both hosts' marks, and each host reads only its own key.

**Resident** — kept on the agent's top-level tool surface:

- `hindsight_recall`, `hindsight_retain`, `hindsight_reflect`, `hindsight_status`

**Cold path** — moved behind on-demand discovery:

- `hindsight_retain_user`, `hindsight_seed_git`, `hindsight_scope`, `hindsight_config_get`, `hindsight_config_set`, `hindsight_bank_list`, `hindsight_bank_get`, `hindsight_bank_set_mission`, `hindsight_mm_list`, `hindsight_mm_get`, `hindsight_mm_create`, `hindsight_mm_update`, `hindsight_mm_refresh`, `hindsight_mm_delete`, `hindsight_kb_tree`, `hindsight_kb_search`, `hindsight_kb_get`, `hindsight_kb_create_page`, `hindsight_kb_create_folder`, `hindsight_kb_update`, `hindsight_kb_delete`, `hindsight_kb_seed_taxonomy`, `hindsight_kb_export`, `hindsight_scope_migrate`
- Any tool added later without a resident entry lands here too (cold path is the default).

Host controls:

- **omp** reads `loadMode`. `essential` (resident) keeps the tool on the top-level surface; `discoverable` (cold path) puts it behind `xd://` discovery. `tools.xdevDocs` sets how device docs are surfaced (default `catalog`), and `tools.xdevInlineDevices` is an allowlist of devices whose docs are inlined into the prompt.
- **pi** reads `exposure`. `direct` (resident) is active as soon as the extension registers it; `deferred` (cold path) must be activated — with `--tools` / `defaultTools` at session start, or `setActiveTools` mid-session — and stays reachable through tool search when it is not active.

See the generated [surface reference](surface-reference.md) for parameter schemas.
