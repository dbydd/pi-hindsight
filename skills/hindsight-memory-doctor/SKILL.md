---
name: hindsight-memory-doctor
description: >
  Self-check Pi Hindsight memory when the user is frustrated, confused, or
  complains about memory quality (wrong prefs, missing context, "it forgot",
  "never ask questions" vs wants questions, empty inject, wrong project).
  Inspect status/scope/mental models/bank missions, compare to quality docs,
  propose dry-run fixes. Trigger on memory complaints, "memory is wrong",
  "forgot", "why did it inject", /hindsight-memory-doctor, or conflict with
  recalled/MM content. Do NOT run every turn.
---

# Hindsight memory doctor

When the user is **upset or skeptical about memory**, behave like a careful human under conflict: **stop, inspect, question the memory stack**, then propose a small fix. Do not argue from broken inject. Do not mutate banks silently.

Authoritative criteria: `docs/mission-and-mental-model-quality.md` (packaged; also docs-site _Mission and mental-model quality_).

## Trigger (yes)

- User complains about memory / Hindsight / inject / prefs / “forgot” / wrong project context
- Injected MM or recall **contradicts** the user (e.g. “do not ask questions” vs wants high-signal questions)
- User asks why memory looks wrong or empty
- Explicit `/skill:hindsight-memory-doctor`

## Do not trigger

- Normal coding with healthy inject
- Single imperfect recall hit
- Every turn “maybe refresh?”

## Workflow (always)

1. **Acknowledge** the complaint in one line. Treat it as a possible **system** issue, not only user error.
2. **Inspect** (tools; no dry-run needed for reads):
   - `hindsight_status`
   - `hindsight_scope`
   - `hindsight_bank_list` — the routing table: which banks exist, and each one's
     `access` (read / write / read-write) and retain mode (always / decision / explicit-only)
   - `hindsight_mm_list` (coding bank; life/user if enabled)
   - `hindsight_mm_get` for broken/suspicious ids
   - `hindsight_bank_get` for coding (and life if enabled) — missions
3. **omp only: check for a second entry point.** `hindsight_status` carries
   `hostMemoryBackend`. `redundant: true` means omp's built-in memory backend is
   on alongside this extension, so the session has two memory entry points
   writing two different banks — memories look "lost" because the wrong bank was
   written. Fix with one command, never a YAML edit:
   - `omp config reset memory.backend` (or `omp config set memory.backend off`)
   - or run `/hindsight:omp-backend` and pick `off`; it re-reads and reports back.
   - `available: false` means the omp CLI could not answer; say so and ask the
     user to run the command manually rather than guessing.
     On the Pi host this step does not apply — Pi ships no built-in backend.
4. **Score against the quality guide** (priority order):
   1. Broken/empty MM content (`#`, empty, Generating…) — prefs MMs may need `fact_types` world+experience+observation, not observation-only
   2. A redundant omp backend (two entry points, the wrong bank being written)
   3. Prefs contradict the user
   4. Missing starters for **this** `project:<id>`
   5. Fat inject / truncation
   6. Mission noise (only if multi-session pattern)
   7. Polish-only → skip

   Before blaming content quality (3–6), rule out **routing**: the reads in step
   2 are also the routing checks. Each symptom below already has its tool above —
   no extra call, no new tool. Full write-up: `docs/troubleshooting.md`.

   | Symptom                                                  | Check with                                  | What you are looking for                                                                                             |
   | -------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
   | First recall injects nothing; no bank ever appears       | `hindsight_status` + `hindsight_bank_get`   | `setupComplete: false`, or the configured `bankId` does not exist server-side → symptom 1, fix setup first           |
   | Every turn routes to the same bank whatever was asked    | `hindsight_config_get`                      | No `decision` entry asked for, or a fallback list that names no real entry → symptom 2, it degrades, nothing is lost |
   | One configured bank never gets a write                   | `hindsight_bank_list`                       | A missing/typo'd `bankId` on a non-coding entry → symptom 3, it is skipped as unresolved                             |
   | Mid-task turns get no recall, or decisions quote no work | host todo surface                           | Task state read as `unavailable`/`unknown` → symptom 4, that is unreadable, **not** "no tasks"                       |
   | Nothing remembered in any mode                           | `hindsight_status` + `hindsight_config_get` | Setup gate closed, or domain-tagged mode with no explicit coding bank id → symptom 5, treat as first cause           |

   Two traps worth naming out loud when reporting:
   - A failed/unreachable decision model degrades to fallback banks and keeps
     recall on. It costs routing quality, never memory.
   - `unavailable` ≠ empty task list. Never read it as "there is nothing in flight".

5. **omp only: check the subagent profile when the complaint comes from a spawned agent.**
   A task or workflow agent resolves its own layers: user `hindsight.json`, user
   `hindsight-subagent.json` profile, project `hindsight.json`, project
   `hindsight-subagent.json` profile. The main session never reads the profile file.

   - Read the agent definition name before you read any config. The profile key is that name.
   - Read `hindsight-subagent.json` or `.jsonc` in `~/.omp/agent` and in `<cwd>/.omp`.
     A missing `profiles.<name>` entry means the agent inherits `hindsight.json`.
   - Compare the profile's `banks` with the banks the agent actually used. Bank entries
     merge by `id` or `alias`, so one stated field overrides while the rest stays.
   - If a workflow gives two roles the same agent name, both resolve one profile. Report
     that as an agent naming issue and ask for separate named agent definitions.
   - Treat the profile as a routing setting. Explicit `hindsight_*` calls accept a bank id
     and do not enforce a profile allowlist, so do not describe it as a hard boundary.

6. **Propose** a short plan (max 3 actions). Prefer:
   - explicit retain of the **correct** durable fact
   - refresh (or clear+refresh if delta-drift)
   - create missing starters for this project
   - mission patch only if extraction is systematically wrong
   - turn off a redundant omp backend — one command, but ask first: it removes
     omp's own memory tools for the session, so only propose it when the user
     wants a single entry point
   - set the missing coding `bankId` / complete setup when the gate, not the
     content, is the cause — routing fix before any content repair
7. **Dry-run first** for any mutation (`hindsight_mm_create` / `hindsight_mm_update` / `hindsight_mm_refresh` / `hindsight_mm_delete` / `hindsight_bank_set_mission`, dryRun true). Apply only after user ok (`dryRun: false` or hub).
8. **Verify** list/get again. Note inject cache may lag (`mentalModels.cacheTtlMs`, often ~5 min) — new session or wait.

## Output shape

```text
Memory doctor
- What I checked: …
- What’s wrong (priority): …
- Proposed fixes (dry-run): …
- Not doing: … (noise / other projects / silent rewrite)
```

## Hard rules

- Never silent create/update/delete of mental models or missions.
- Never edit another project’s `project:<other>` models to “fix” this session.
- Same-turn retain + rely-on-recall is invalid; refresh after retain has landed.
- If tools unavailable / setup incomplete: say so and point to `/hindsight` setup.
- Never edit `~/.omp/agent/config.yml` by hand. omp settings go through
  `omp config set|reset`, which validates; a YAML edit bypasses that and can
  silently fall back to a default.
- Never edit another session's profile to mask a routing fault. Name the layer that
  supplied the value, then propose the smallest change in that file.

## Optional user invoke

`/skill:hindsight-memory-doctor` — run full workflow once.
