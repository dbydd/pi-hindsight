---
title: "Architecture Notes"
---

These notes record deepening work completed after the mission/global-memory pass and the remaining conditions for reopening broader architecture changes.

## Memory routing

- `globalRetain.mode`/`userRetain.mode` is `"explicit-only"` in every profile and maps onto the user entry's `banks[].retain.mode`. Automatic retain targets the entries whose mode is not `explicit-only`: the coding role by default, the user entry only when a config sets it to `always` or `decision`. The heuristic memory router that used to classify content into project/global/both/skip was removed per ADR 004; `retain.mode: "decision"` replaced it as the model-driven write router.

## Config editing

- Config editing registry owns field metadata, layer/source display composition, input parsing, input defaults, and patch intent builders. Adding one setting should usually touch the registry plus config writer tests, not a separate action switch.

## Document deletion UX

- Recent explicit retain receipts are persisted and surfaced in `/hindsight` status facts so users can find exact document IDs for deletion in the Hindsight web UI.

## Historical import queue seam

- Import delivery now has an import-specific queue seam, records queued-but-not-delivered imports as `queued` in checkpoints/results, and normalizes equivalent cwd paths before project-scope checks.
