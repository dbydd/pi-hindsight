/**
 * Tool exposure marks for the two hosts pi-hindsight runs on.
 *
 * One registered tool object carries both hosts' keys; each host reads the key it
 * knows and ignores the other:
 *
 * - **omp** reads `loadMode` off the object handed to `registerTool` (its `wrapper.ts`
 *   resolves `defaultLoadModeForToolName(name, definition.loadMode)`). `essential`
 *   keeps the tool on the top-level surface; the extension-tool default is
 *   `discoverable`, which moves it behind `xd://` discovery.
 * - **pi** reads `exposure` (`direct` = active as soon as the extension registers it,
 *   `deferred` = activated on demand / reachable through tool search).
 *
 * pi's `defineTool` returns the object unchanged (it does not strip unknown fields),
 * so the omp-only `loadMode` key survives on the object pi registers; pi also accepts
 * the keys it does not declare at the `registerTool` boundary, where `defineCatalogTool`
 * narrows the merged object back to the host type.
 * `tests/tool-presentation.test.ts` pins that pass-through so a future pi that starts
 * dropping unknown fields fails loudly instead of silently losing the omp mark.
 */

/** How eagerly a tool is surfaced to the model. */
export type ToolTier = "resident" | "cold-path";

/** The two host keys, derived together from one tier. */
export interface ToolPresentation {
  loadMode: "essential" | "discoverable";
  exposure: "direct" | "deferred";
}

/**
 * Tools the agent reaches for every turn; kept on the top-level surface.
 *
 * Everything else is the cold path — `discoverable` under omp, `deferred` under pi.
 * That covers the explicit-memory tools (`hindsight_retain_user`,
 * `hindsight_seed_git`, `hindsight_scope`, `hindsight_scope_migrate`, the
 * `hindsight_config_*`, `hindsight_bank_*`, `hindsight_mm_*`, and `hindsight_kb_*`
 * families) and any tool added later without a resident entry here, so a new tool
 * lands cold-path (the safe default) rather than silently taking over the top-level
 * surface. The catalog-surface test in `tests/operation-catalog.test.ts` keeps the
 * registered name set pinned, so an unintended addition shows up as a diff instead
 * of hiding behind this default.
 */
export const RESIDENT_TOOL_NAMES: readonly string[] = [
  "hindsight_recall",
  "hindsight_retain",
  "hindsight_reflect",
  "hindsight_status",
];

/** Map a tier to the dual-host marks. Pure. */
export function presentationForTier(tier: ToolTier): ToolPresentation {
  return tier === "resident"
    ? { loadMode: "essential", exposure: "direct" }
    : { loadMode: "discoverable", exposure: "deferred" };
}

/** Resolve the dual-host marks for a tool name (unknown names default to cold path). */
export function toolPresentation(name: string): ToolPresentation {
  return presentationForTier(RESIDENT_TOOL_NAMES.includes(name) ? "resident" : "cold-path");
}
