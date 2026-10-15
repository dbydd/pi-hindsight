import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../extensions/config/config.js";
import { createOperationCatalog } from "../extensions/operations/operation-catalog.js";
import {
  presentationForTier,
  RESIDENT_TOOL_NAMES,
  toolPresentation,
} from "../extensions/operations/tool-presentation.js";

const RESIDENT_MARKS = { loadMode: "essential", exposure: "direct" };
const COLD_PATH_MARKS = { loadMode: "discoverable", exposure: "deferred" };

/** Resident on both hosts: recalled/retained/reflected every turn, plus status. */
const RESIDENT_TOOLS = [
  "hindsight_recall",
  "hindsight_retain",
  "hindsight_reflect",
  "hindsight_status",
];

/**
 * Cold path on both hosts: the explicit-memory tools and the split
 * config/bank/mental-model/knowledge-page families. None of them has a resident
 * entry, so they reach the cold path through the unknown-name default.
 */
const COLD_PATH_TOOLS = [
  "hindsight_retain_user",
  "hindsight_seed_git",
  "hindsight_scope",
  "hindsight_scope_migrate",
  "hindsight_config_get",
  "hindsight_config_set",
  "hindsight_bank_list",
  "hindsight_bank_get",
  "hindsight_bank_set_mission",
  "hindsight_mm_list",
  "hindsight_mm_get",
  "hindsight_mm_create",
  "hindsight_mm_update",
  "hindsight_mm_refresh",
  "hindsight_mm_delete",
  "hindsight_kb_tree",
  "hindsight_kb_search",
  "hindsight_kb_get",
  "hindsight_kb_create_page",
  "hindsight_kb_create_folder",
  "hindsight_kb_update",
  "hindsight_kb_delete",
  "hindsight_kb_seed_taxonomy",
  "hindsight_kb_export",
];

/** The exposure marks are host runtime keys the installed Pi `ToolDefinition` does not declare. */
type MarkedTool = { name: string; loadMode?: unknown; exposure?: unknown };

function marksOf(name: string): { loadMode: unknown; exposure: unknown } {
  const catalog = createOperationCatalog({
    getClient: () => ({}) as never,
    getConfig: () => DEFAULT_CONFIG,
    getProjectBankId: () => "bank",
  });
  const tool = catalog.tools.find((candidate) => candidate.name === name) as MarkedTool | undefined;
  if (!tool) throw new Error(`Missing ${name} tool`);
  return { loadMode: tool.loadMode, exposure: tool.exposure };
}

describe("tool presentation marks", () => {
  it("keeps the four resident tools on the top-level surface of both hosts", () => {
    for (const name of RESIDENT_TOOLS) {
      expect(marksOf(name), name).toEqual(RESIDENT_MARKS);
    }
  });

  it("moves the cold-path tools behind discovery on both hosts", () => {
    for (const name of COLD_PATH_TOOLS) {
      expect(marksOf(name), name).toEqual(COLD_PATH_MARKS);
    }
  });

  it("covers every registered tool with exactly one tier", () => {
    const catalog = createOperationCatalog({
      getClient: () => ({}) as never,
      getConfig: () => DEFAULT_CONFIG,
      getProjectBankId: () => "bank",
    });
    expect(catalog.tools.map((tool) => tool.name).sort()).toEqual(
      [...RESIDENT_TOOLS, ...COLD_PATH_TOOLS].sort(),
    );
  });

  it("maps each tier to the paired host marks", () => {
    expect(presentationForTier("resident")).toEqual(RESIDENT_MARKS);
    expect(presentationForTier("cold-path")).toEqual(COLD_PATH_MARKS);
    expect(RESIDENT_TOOL_NAMES).toEqual(RESIDENT_TOOLS);
  });

  it("defaults an unknown tool name to the cold path", () => {
    expect(toolPresentation("hindsight_recall")).toEqual(RESIDENT_MARKS);
    expect(toolPresentation("hindsight_bank_get")).toEqual(COLD_PATH_MARKS);
    expect(toolPresentation("hindsight_some_future_tool")).toEqual(COLD_PATH_MARKS);
  });

  it("keeps the omp-only loadMode key on the object defineTool returns", () => {
    const base = {
      name: "hindsight_probe",
      label: "Hindsight Probe",
      description: "probe",
      parameters: Type.Object({}),
      async execute() {
        return { content: [], details: undefined };
      },
    } satisfies ToolDefinition;
    const marked = { ...base, ...toolPresentation("hindsight_recall") } as ToolDefinition;
    const defined = defineTool(marked) as unknown as Record<string, unknown>;
    expect(defined.loadMode).toBe("essential");
    expect(defined.exposure).toBe("direct");
  });
});
