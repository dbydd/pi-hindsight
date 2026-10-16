---
title: "Troubleshooting"
description: Diagnose the five routing failures that look like broken memory, using only shipped tools.
---

Diagnosis-first guide for the five failures that look like "memory is broken" but are really routing failures. Every step uses tools that already ship with Pi Hindsight — no scratch commands and no hand-built HTTP calls.

Start with **Triage**, then jump to the symptom that matches. The full routing model is in [Memory behavior → Decision-driven bank routing](/pi-hindsight/concepts/memory-behavior/#decision-driven-bank-routing).

## Triage order

Run these first, in this order. Together they answer most of the five symptoms.

1. `hindsight_status` — setup gate, project scope tags, queue depth, server reachability, and `hostMemoryBackend`.
2. `hindsight_bank_list` — the routing table: which banks Pi is configured to use, each one's `access` (read / write / read-write) and retain mode (`always` / `decision` / `explicit-only`).
3. `hindsight_config_get` — the effective allowlisted config: `recall.mode`, `recall.bankMode`, `banks[].retain.mode`, `decision.*`, `banksFallback`.
4. `hindsight_bank_get` for the suspect bank — whether that bank exists on the Hindsight side at all.

Then branch:

| Symptom                                                             | Root cause section                                                |
| ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| First recall injects nothing, no memory ever appears                | [Bank missing or not created](#1-bank-missing-or-not-created)     |
| Banks exist, but every routing decision falls back to the same bank | [Decision model cannot answer](#2-decision-model-cannot-answer)   |
| A bank you configured is never written                              | [Misspelled or missing `bankId`](#3-misspelled-or-missing-bankid) |
| Decisions route as if no work were in progress                      | [Todo state unreadable](#4-todo-state-unreadable)                 |
| Nothing is ever written or read, in any mode                        | [Setup gate closed](#5-setup-gate-closed-or-automatic-memory-off) |

## 1. Bank missing or not created

**Symptom.** The first automatic recall injects nothing. No error, no bank appears afterwards, and explicit retains that target the bank by id fail or create nothing reusable.

**Root cause.** The bank was never created, or was created under a different id. Automatic recall reads whatever exists; if the configured bank id does not resolve, there is nothing to read. The extension ensures the project bank only after the setup gate passes, so on a new install without a bank id there is no bank to ensure.

**Verify.**

1. `hindsight_bank_list` — check every entry you expect has a resolvable `bankId` and `enabled: true`.
2. `hindsight_bank_get` with that `bankId` — confirm the bank exists on the Hindsight side (existence, not just Pi-local config).
3. `hindsight_status` — read `setupComplete`. `false` means the setup gate blocked automatic bank creation; the status also carries `setupHint` naming the next action.

**Fix.**

1. If `setupComplete` is false, complete setup first: run `/hindsight` and follow guided setup, **or** set the bank id explicitly (`banks[].bankId`, or `PI_HINDSIGHT_PROJECT_BANK_ID`). See symptom [5](#5-setup-gate-closed-or-automatic-memory-off) — an unconfigured install gets no automatic bank, and therefore no automatic memory.
2. If the id is missing, set it in config (`hindsight_config_set`) or create the bank with the id you meant.
3. Re-run recall in a new turn; the decision cache (`decision.cacheTtlMs`, 60s by default) and the recall block cache can otherwise replay the empty result.

## 2. Decision model cannot answer

**Symptom.** Nothing is obviously broken — recall keeps working and no error surfaces — but every turn routes to the same bank (usually the coding bank), whatever the question was.

**Root cause.** Every backend rung failed or was unusable, so every decision fell through to `decision.fallback` and then to `banksFallback`. The layer is designed to do exactly this: a failing decision model costs routing quality, never memory. The common causes are a disabled layer, a model spec that does not resolve on this host, a timeout, or a backend that answered an incomplete question table.

**Verify.**

1. `hindsight_config_get` — confirm `decision.enabled` is true and `decision.model` resolves to something this host has. A `role:<name>` spec is a **skipped level on pi**, not an error: it degrades to the session model. `<provider>/<modelId>` works on both hosts.
2. Check that routing is actually being asked for: `recall.mode: "decision"` and/or `recall.bankMode: "decision"`, and/or an entry in `banks[].retain.mode: "decision"`. With none of those, no decision call is made and fixed routing is correct behavior, not a fault.
3. `hindsight_config_get` — confirm `decision.fallback.recallBanks` / `retainBanks` (or top-level `banksFallback`) names a real entry id. An empty or stale fallback list is why a failed decision lands on the same bank every time.
4. Watch the `hindsight:retrieval` event bus for `phase: "decision"` spans and read `reason`: `no-model`, `backends-failed`, `disabled`, and `no-candidates` each point at a different cause.

**Fix.**

1. Set `decision.model` to a spec the host can resolve — `<provider>/<modelId>` for a portable setup, `role:<name>` on a host that has that role.
2. Set an explicit fallback so a failed decision still routes somewhere sensible: `decision.fallback.recallBanks` / `retainBanks`, or `banksFallback`.
3. Raise `decision.timeoutMs` if slow backends are timing out; lower it if an unreachable backend is stalling each turn.

Do not treat this as data loss. Nothing went missing — the round was routed, just not well.

## 3. Misspelled or missing `bankId`

**Symptom.** One configured bank never receives writes. Every other bank behaves. Nothing about it changes when you edit modes.

**Root cause.** Write routing needs a concrete bank id. The coding-role entry resolves to the derived project bank; **every other entry needs its own `bankId`**, and an entry without one is skipped as unresolved. A typo has the same effect: the configured id does not match any candidate, so the id is refused and reported rather than written. This is silent from the transcript's point of view — the turn looks normal.

**Verify.**

1. `hindsight_bank_list` — read `bankId` per entry character by character. Confirm each non-coding entry has one, and compare it against `hindsight_bank_get`, which asks Hindsight itself whether that bank resolves.
2. `hindsight_bank_get` with the suspect `bankId` — a missing bank distinguishes a typo from a bank that was simply never created.
3. Watch `hindsight:retrieval` `phase: "retain"` spans for `droppedBanks`. Refused ids — not offered, or no longer eligible — are listed there instead of being written quietly.

**Fix.**

1. Correct the id in config with `hindsight_config_set`, or create the intended bank so the id resolves.
2. Confirm the entry is also enabled and write-capable (`access` is `write` or `read-write`, `retain.enabled` not false); access-incompatible entries are skipped as well.

## 4. Todo state unreadable

**Symptom.** Routing decisions look right for small talk but wrong for real work — a turn mid-task gets no project recall, or the decision quotes no open work.

**Root cause.** The decision prompt carries the host task state, and the two hosts read it differently. If no reader can read it, the state is `unknown`.

- **omp** — read through the `omp-todo-more` read event; projects to `{kind:"ok", goal, openItems:[{phase,title,explanation}]}` or `{kind:"unavailable"}`.
- **pi** — read from the `rpiv-todo-state` session entry on the branch (`TaskDetails{tasks: Task[], nextId}`).

**`{kind: "unavailable"}` and `unknown` are not "no tasks".** An unreadable task list is not an empty one: the layer treats it as task state unknown and decides accordingly, rather than concluding nothing is in flight. So a missing todo plugin changes decision _quality_, never the presence of memory.

**Verify.**

1. Confirm the host's todo surface exists at all: on omp, that the todo plugin is loaded and answering; on pi, that a `rpiv-todo-state` entry exists on the branch.
2. Compare what the host shows against what the decision saw. Since the last user message and the task state are never truncated by `decision.maxContextChars`, a missing task state is a read failure, not a budget cut.
3. If routing quality matters here, sanity-check the layer is being consulted at all with `hindsight_config_get` (`recall.mode` / `recall.bankMode` / retain modes).

**Fix.**

1. Enable or repair the host's todo surface. This is the only real fix — the extension reads the host's own state and does not keep a private copy.
2. If the surface cannot be available, simplify the routing question: prefer `recall.bankMode: "all"` or `retain.mode: "always"` over `decision`, so routing no longer depends on task state you cannot read.

## 5. Setup gate closed or automatic memory off

**Symptom.** Nothing is remembered in any mode. Recall injects nothing, retain writes nothing, no queue grows, and there is no error in the transcript — possibly accompanied by a startup notice telling you automatic memory is off.

**Root cause.** Automatic memory never started, so none of the above could run. Two gates must pass:

- **A setup signal must exist.** Any one of: `setupComplete: true`, a coding or user entry carrying a `bankId`, a project config file (`.pi/hindsight.json` / `.pi/hindsight.jsonc`), or local runtime state under `.pi/hindsight/` (queue file, `retain-cursors.json`, import manifest, or last-recall snapshot).
- **Domain-tagged mode needs an explicit coding bank id.** `requiresExplicitCodingBankId` = `scope.mode === "domain-tagged"` **and** a coding entry that is enabled. In that mode a path-derived bank id is not enough — the extension will not silently auto-operate on a path-derived bank as if it were a shared coding domain. `isolated-bank` mode may still path-derive.

When the gate fails, `/hindsight` and the status surface show the hint: run `/hindsight`, or set `banks.project.bankId` (or `PI_HINDSIGHT_PROJECT_BANK_ID`). Until then automatic memory is off, which is why nothing else in this page can bite.

**Verify.**

1. `hindsight_status` — read `setupComplete`. `false` means the gate is closed; the response carries `setupHint` with the concrete next action.
2. `hindsight_config_get` — read `scope.mode`. `domain-tagged` is the mode that additionally demands an explicit coding bank id.
3. `hindsight_bank_list` — confirm the coding entry is enabled and has a non-empty `bankId`.
4. `omp config get memory.backend` — omp only. When it is not `off`, omp's built-in memory backend is running alongside this extension and you have two entry points writing two different banks. `hindsight_status` reports this as its `hostMemoryBackend` fact; `redundant: true` is the signal. Symmetric fixes: `omp config reset memory.backend` (or `omp config set memory.backend off`), or `/hindsight:omp-backend` and pick `off`. `available: false` means the CLI could not answer — run it manually rather than guessing.

**Fix.**

1. Run `/hindsight` and complete guided setup (pick a profile, set bank ids). This satisfies both gates in one pass.
2. Or set the id directly: `banks.project.bankId` via `hindsight_config_set`, or `PI_HINDSIGHT_PROJECT_BANK_ID`, or the top-level `banks[]` entry.
3. In domain-tagged mode, an explicit coding `bankId` is mandatory; `isolated-bank` mode may keep deriving from the path.
4. On omp, make sure only one memory entry point is active (step 4 above).

## Related

- [Memory behavior → Decision-driven bank routing](/pi-hindsight/concepts/memory-behavior/#decision-driven-bank-routing) — the full model: gates, fallback chain, cache, and degradation philosophy.
- [Configuration → Decision layer](/pi-hindsight/reference/configuration/#decision-layer-decision) — field-by-field meaning of `decision.*`.
- [Tools and commands](/pi-hindsight/reference/tools-and-commands/) — what every tool above reads and writes.
- The `hindsight-memory-doctor` skill — the same checks run as a guided diagnosis when memory itself is in question.
