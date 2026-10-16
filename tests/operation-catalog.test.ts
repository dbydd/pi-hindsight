import { describe, expect, it, vi } from "vitest";
import { banks } from "./helpers/bank-config.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../extensions/config/config.js";
import { createOperationCatalog } from "../extensions/operations/operation-catalog.js";
import type { HindsightLikeClient, ResolvedConfig } from "../extensions/types.js";

type RetainOptions = Parameters<HindsightLikeClient["retain"]>[2];
type RecallOptions = Parameters<HindsightLikeClient["recall"]>[2];
type ReflectOptions = Parameters<HindsightLikeClient["reflect"]>[2];

type JsonSchema = {
  type?: string;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  patternProperties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  const?: unknown;
  minimum?: number;
  required?: string[];
};

function client(): HindsightLikeClient {
  return {
    retain: async () => undefined,
    recall: async () => [],
    reflect: async () => ({}),
    getBankConfig: async () => ({ config: {}, overrides: {} }),
    getBankProfile: async () => ({ id: "bank" }),
  };
}

function retainMock() {
  return vi.fn(async (_bankId: string, _content: string, _options?: RetainOptions) => undefined);
}

function requireTool(catalog: ReturnType<typeof createOperationCatalog>, name: string) {
  const tool = catalog.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing ${name} tool`);
  return tool;
}

describe("operation catalog", () => {
  it("registers expandable renderers for explicit memory tool results", () => {
    const catalog = createOperationCatalog({
      getClient: () => client(),
      getConfig: () => DEFAULT_CONFIG,
      getProjectBankId: () => "project-bank",
    });

    for (const name of [
      "hindsight_recall",
      "hindsight_retain",
      "hindsight_retain_user",
      "hindsight_reflect",
    ]) {
      expect(requireTool(catalog, name).renderResult).toBeTypeOf("function");
    }
  });

  it("refuses tool execution when extension is disabled for the repo", async () => {
    const recall = vi.fn(async () => []);
    const catalog = createOperationCatalog({
      getClient: () => ({ ...client(), recall }),
      getConfig: () => ({ ...DEFAULT_CONFIG, enabled: false }),
      getProjectBankId: () => "project-bank",
    });
    const tool = requireTool(catalog, "hindsight_recall");
    const result = await tool.execute(
      "call-1",
      { query: "what did we decide?" },
      undefined,
      undefined,
      {
        cwd: mkdtempSync(join(tmpdir(), "pi-hindsight-disabled-tool-")),
        sessionManager: { getSessionFile: () => undefined },
      } as never,
    );

    expect(recall).not.toHaveBeenCalled();
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("disabled for this repository"),
    });
    expect(result.details).toEqual({ disabled: true });
  });

  it("exposes and maps advanced explicit retain options on the project retain tool", async () => {
    const retain = retainMock();
    const cwd = mkdtempSync(join(tmpdir(), "pi-hindsight-catalog-"));
    const sessionFile = join(cwd, "session.jsonl");
    const catalog = createOperationCatalog({
      getClient: () => ({ ...client(), retain }),
      getConfig: () => DEFAULT_CONFIG,
      getProjectBankId: () => "project-bank",
    });
    const tool = requireTool(catalog, "hindsight_retain");
    const properties = (tool.parameters as JsonSchema).properties ?? {};

    expect(properties.documentId?.type).toBe("string");
    expect(properties.timestamp?.type).toBe("string");
    expect(properties.metadata?.patternProperties?.["^.*$"]?.type).toBe("string");
    expect(properties.updateMode?.anyOf?.map((schema) => schema.const)).toEqual([
      "append",
      "replace",
    ]);
    expect(properties.observationScopes?.anyOf?.some((entry) => entry.const === "per_tag")).toBe(
      true,
    );
    expect(properties.observationScopes?.anyOf?.some((entry) => entry.const === "combined")).toBe(
      true,
    );
    expect(properties.observationScopes?.anyOf?.some((entry) => entry.const === "shared")).toBe(
      true,
    );
    expect(properties.documentTags?.items?.type).toBe("string");
    expect(properties.async?.type).toBe("boolean");

    await tool.execute(
      "call",
      {
        content: "Remember exact decision",
        context: "unit test retain tool",
        bank: "target-bank",
        tags: ["decision:test"],
        entities: [{ text: "Alice", type: "person" }],
        documentId: "manual-doc",
        timestamp: "unset",
        metadata: {
          cwd: "wrong-cwd",
          pi_session_file: "wrong-session",
          source: "wrong-source",
          retainSource: "wrong-retain-source",
          caller: "kept",
        },
        updateMode: "append",
        observationScopes: "per_tag",
        documentTags: ["doc:manual"],
        async: false,
      },
      new AbortController().signal,
      () => undefined,
      { cwd, sessionManager: { getSessionFile: () => sessionFile } } as never,
    );

    expect(retain).toHaveBeenCalledWith(
      "target-bank",
      "Remember exact decision",
      expect.objectContaining({
        context: "unit test retain tool",
        documentId: "manual-doc",
        timestamp: "unset",
        metadata: {
          cwd,
          pi_session_file: sessionFile,
          source: "pi-hindsight",
          retainSource: "tool",
          caller: "kept",
        },
        updateMode: "append",
        observationScopes: "per_tag",
        documentTags: ["doc:manual"],
        async: false,
        entities: [{ text: "Alice", type: "person" }],
      }),
    );

    retain.mockClear();
    await tool.execute(
      "call",
      {
        content: "Append using deterministic explicit document ID",
        context: "unit test append default document ID",
        updateMode: "append",
      },
      new AbortController().signal,
      () => undefined,
      { cwd, sessionManager: { getSessionFile: () => sessionFile } } as never,
    );

    expect(retain).toHaveBeenCalledWith(
      "project-bank",
      "Append using deterministic explicit document ID",
      expect.objectContaining({
        context: "unit test append default document ID",
        documentId: expect.stringMatching(/^pi-explicit:/),
        updateMode: "append",
      }),
    );
  });

  it("keeps simple retain defaults unchanged when advanced tool options are omitted", async () => {
    const retain = retainMock();
    const cwd = mkdtempSync(join(tmpdir(), "pi-hindsight-catalog-"));
    const sessionFile = join(cwd, "session.jsonl");
    const catalog = createOperationCatalog({
      getClient: () => ({ ...client(), retain }),
      getConfig: () => DEFAULT_CONFIG,
      getProjectBankId: () => "project-bank",
    });

    const tool = requireTool(catalog, "hindsight_retain");

    await tool.execute(
      "call",
      { content: "Remember simple default", context: "unit test retain defaults" },
      new AbortController().signal,
      () => undefined,
      { cwd, sessionManager: { getSessionFile: () => sessionFile } } as never,
    );

    const options = retain.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(options).toMatchObject({
      context: "unit test retain defaults",
      updateMode: "replace",
      async: true,
      metadata: {
        cwd,
        pi_session_file: sessionFile,
        source: "pi-hindsight",
        retainSource: "tool",
      },
      observationScopes: [["harness:pi"], [expect.stringMatching(/^project:/)]],
    });
    expect(options.documentId).toEqual(expect.stringMatching(/^pi-explicit:/));
    expect(options.tags).toEqual(
      expect.arrayContaining([
        "source:pi",
        expect.stringMatching(/^project:/),
        expect.stringMatching(/^repo:/),
        expect.stringMatching(/^session:/),
      ]),
    );
  });

  it("exposes and maps advanced explicit recall controls", async () => {
    const recall = vi.fn(async (_bankId: string, _query: string, _options?: RecallOptions) => ({
      ok: true,
    }));
    const cwd = mkdtempSync(join(tmpdir(), "pi-hindsight-catalog-"));
    const catalog = createOperationCatalog({
      getClient: () => ({ ...client(), recall }),
      getConfig: () => DEFAULT_CONFIG,
      getProjectBankId: () => "project-bank",
    });
    const tool = requireTool(catalog, "hindsight_recall");
    const properties = (tool.parameters as JsonSchema).properties ?? {};

    expect(properties.types?.items?.anyOf?.map((schema) => schema.const)).toEqual([
      "world",
      "experience",
      "observation",
    ]);
    expect(properties.budget?.anyOf?.map((schema) => schema.const)).toEqual(["low", "mid", "high"]);
    expect(properties.tagsMatch?.anyOf?.map((schema) => schema.const)).toEqual([
      "any",
      "all",
      "any_strict",
      "all_strict",
      "exact",
    ]);
    expect(properties.maxTokens?.type).toBe("integer");
    expect(properties.maxTokens?.minimum).toBe(0);
    expect(properties.includeChunks?.type).toBe("boolean");
    expect(properties.recallChunksMaxTokens?.type).toBe("integer");
    expect(properties.includeSourceFacts?.type).toBe("boolean");
    expect(properties.maxSourceFactsTokens?.type).toBe("integer");
    expect(properties.includeEntities?.type).toBe("boolean");
    expect(properties.trace?.type).toBe("boolean");
    expect(properties.preferObservations?.type).toBe("boolean");
    expect(properties.minScores?.type).toBe("object");

    await tool.execute(
      "call",
      {
        query: "find source context",
        types: ["world", "observation"],
        preferObservations: true,
        minScores: { semantic: 0.2, final: 0.5 },
        budget: "high",
        maxTokens: 0,
        includeChunks: true,
        recallChunksMaxTokens: 512,
        includeSourceFacts: true,
        maxSourceFactsTokens: 256,
        includeEntities: true,
        trace: true,
        tags: ["caller:tag"],
      },
      new AbortController().signal,
      () => undefined,
      { cwd, sessionManager: {} } as never,
    );

    expect(recall).toHaveBeenCalledWith(
      "project-bank",
      "find source context",
      expect.objectContaining({
        types: ["world", "observation"],
        preferObservations: true,
        minScores: { semantic: 0.2, final: 0.5 },
        budget: "high",
        maxTokens: 0,
        includeChunks: true,
        maxChunkTokens: 512,
        includeSourceFacts: true,
        maxSourceFactsTokens: 256,
        includeEntities: true,
        trace: true,
        tagGroups: expect.arrayContaining([
          expect.objectContaining({
            tags: expect.arrayContaining([expect.stringMatching(/^repo:/)]),
          }),
          { tags: ["caller:tag"], match: "any_strict" },
        ]),
      }),
    );
  });

  it("declares a type on every tagGroups.match enum so strict JSON schema validators (Moonshot MFJS) accept the tool", () => {
    // Regression: Moonshot's "Moonshot Flavored JSON Schema" (MFJS) rejects any
    // property schema that omits `type`, even when `enum` is present. The
    // tagGroups.match field is a hand-written JSON schema literal wrapped in
    // Type.Unsafe, so TypeBox cannot add `type` automatically. Without an
    // explicit `type: "string"`, every request carrying hindsight_recall /
    // hindsight_reflect is rejected by api.kimi.com/coding/v1 with:
    //   tools.function.parameters is not a valid moonshot flavored json schema,
    //   details: <At path 'properties.tagGroups.items.properties.match': type is not defined>
    // See https://github.com/MoonshotAI/kimi-cli/issues/1595
    const catalog = createOperationCatalog({
      getClient: () => client(),
      getConfig: () => DEFAULT_CONFIG,
      getProjectBankId: () => "project-bank",
    });

    for (const name of ["hindsight_recall", "hindsight_reflect"] as const) {
      const tool = requireTool(catalog, name);
      const properties = (tool.parameters as JsonSchema).properties ?? {};
      const tagGroupsItems = properties.tagGroups?.items as JsonSchema | undefined;
      const matchSchema = tagGroupsItems?.properties?.match;

      expect(matchSchema, `${name} should declare tagGroups.items.properties.match`).toBeDefined();
      expect(
        matchSchema?.type,
        `${name}.tagGroups.items.properties.match must declare type for MFJS`,
      ).toBe("string");
      expect(matchSchema?.enum).toEqual(["any", "all", "any_strict", "all_strict"]);
    }
  });

  it("folds automatic scope tags into an exact tagsMatch filter for recall", async () => {
    const recall = vi.fn(async (_bankId: string, _query: string, _options?: RecallOptions) => ({
      ok: true,
    }));
    const cwd = mkdtempSync(join(tmpdir(), "pi-hindsight-catalog-"));
    const catalog = createOperationCatalog({
      getClient: () => ({ ...client(), recall }),
      getConfig: () => DEFAULT_CONFIG,
      getProjectBankId: () => "project-bank",
    });
    const tool = requireTool(catalog, "hindsight_recall");

    await tool.execute(
      "call",
      { query: "find exact scope", tags: ["topic:auth"], tagsMatch: "exact" },
      new AbortController().signal,
      () => undefined,
      { cwd, sessionManager: {} } as never,
    );

    const options = (recall.mock.calls as unknown[][])[0]?.[2] as { tagGroups?: unknown[] };
    expect(options.tagGroups).toHaveLength(1);
    expect(options.tagGroups?.[0]).toEqual({
      match: "exact",
      tags: expect.arrayContaining([expect.stringMatching(/^repo:/), "topic:auth"]),
    });
  });

  it("exposes and maps low-risk explicit reflect controls", async () => {
    const reflect = vi.fn(async (_bankId: string, _query: string, _options?: ReflectOptions) => ({
      ok: true,
    }));
    const cwd = mkdtempSync(join(tmpdir(), "pi-hindsight-catalog-"));
    const catalog = createOperationCatalog({
      getClient: () => ({ ...client(), reflect }),
      getConfig: () => DEFAULT_CONFIG,
      getProjectBankId: () => "project-bank",
    });
    const tool = requireTool(catalog, "hindsight_reflect");
    const properties = (tool.parameters as JsonSchema).properties ?? {};

    expect(properties.budget?.anyOf?.map((schema) => schema.const)).toEqual(["low", "mid", "high"]);
    expect(properties.maxTokens?.type).toBe("integer");
    expect(properties.maxTokens?.minimum).toBe(0);
    expect(properties.includeFacts?.type).toBe("boolean");
    expect(properties.includeToolCalls?.type).toBe("boolean");
    expect(properties.includeToolCallOutput?.type).toBe("boolean");
    expect(properties.factTypes?.type).toBe("array");
    expect(properties.excludeMentalModels?.type).toBe("boolean");
    expect(properties.excludeMentalModelIds?.type).toBe("array");
    expect(properties.tagsMatch?.anyOf?.map((schema) => schema.const)).toEqual([
      "any",
      "all",
      "any_strict",
      "all_strict",
      "exact",
    ]);

    await tool.execute(
      "call",
      {
        query: "synthesize",
        budget: "mid",
        maxTokens: 0,
        includeFacts: true,
        includeToolCalls: true,
        tags: ["caller:tag"],
      },
      new AbortController().signal,
      () => undefined,
      { cwd, sessionManager: {} } as never,
    );

    expect(reflect).toHaveBeenCalledWith(
      "project-bank",
      "synthesize",
      expect.objectContaining({
        budget: "mid",
        maxTokens: 0,
        includeFacts: true,
        includeToolCalls: true,
        tagGroups: expect.arrayContaining([
          expect.objectContaining({
            tags: expect.arrayContaining([expect.stringMatching(/^repo:/)]),
          }),
          { tags: ["caller:tag"], match: "any_strict" },
        ]),
      }),
    );
  });

  it("maps advanced explicit retain options on the user retain tool", async () => {
    const retain = retainMock();
    const cwd = mkdtempSync(join(tmpdir(), "pi-hindsight-catalog-"));
    const config: ResolvedConfig = {
      ...DEFAULT_CONFIG,
      banks: banks({ user: { enabled: true, bankId: "global-bank" } }),
    };
    const catalog = createOperationCatalog({
      getClient: () => ({ ...client(), retain }),
      getConfig: () => config,
      getProjectBankId: () => "project-bank",
    });
    const tool = requireTool(catalog, "hindsight_retain_user");

    await tool.execute(
      "call",
      {
        content: "Remember global preference",
        context: "unit test global retain tool",
        documentId: "global-doc",
        timestamp: "2026-05-06T00:00:00Z",
        metadata: { caller: "kept", source: "wrong-source", retainSource: "wrong-retain" },
        updateMode: "append",
        observationScopes: [["user:manual"]],
        async: false,
      },
      new AbortController().signal,
      () => undefined,
      { cwd, sessionManager: {} } as never,
    );

    expect(retain).toHaveBeenCalledWith(
      "global-bank",
      "Remember global preference",
      expect.objectContaining({
        documentId: "global-doc",
        timestamp: "2026-05-06T00:00:00Z",
        metadata: { cwd, source: "pi-hindsight", retainSource: "tool", caller: "kept" },
        updateMode: "append",
        observationScopes: [["user:manual"]],
        async: false,
      }),
    );
  });

  it("retains durable user memory through retain_user and retain with bank=global alike", async () => {
    const retain = retainMock();
    const cwd = mkdtempSync(join(tmpdir(), "pi-hindsight-catalog-"));
    const config: ResolvedConfig = {
      ...DEFAULT_CONFIG,
      banks: banks({ user: { enabled: true, bankId: "global-bank" } }),
    };
    const catalog = createOperationCatalog({
      getClient: () => ({ ...client(), retain }),
      getConfig: () => config,
      getProjectBankId: () => "project-bank",
    });
    const ctx = { cwd, sessionManager: {} } as never;
    const call = { content: "Same durable preference", context: "unit test equivalence" };

    await requireTool(catalog, "hindsight_retain_user").execute(
      "call",
      call,
      undefined,
      undefined,
      ctx,
    );
    await requireTool(catalog, "hindsight_retain").execute(
      "call",
      { ...call, bank: "global" },
      undefined,
      undefined,
      ctx,
    );

    expect(retain).toHaveBeenCalledTimes(2);
    const [userId, userContent, userOptions] = retain.mock.calls[0]!;
    const [bankId, bankContent, bankOptions] = retain.mock.calls[1]!;
    expect(userId).toBe("global-bank");
    expect(bankId).toBe("global-bank");
    expect(userContent).toBe(bankContent);
    expect(userOptions?.documentId).toBe(bankOptions?.documentId);
  });

  it("lists the Pi-configured banks through hindsight_bank_list without a client call", async () => {
    const catalog = createOperationCatalog({
      getClient: () => {
        throw new Error("hindsight_bank_list must not call the Hindsight client");
      },
      getConfig: () => ({
        ...DEFAULT_CONFIG,
        banks: banks({ coding: { bankId: "coding-bank" }, user: { bankId: "user-bank" } }),
      }),
      getProjectBankId: () => "coding-bank",
    });

    const result = await requireTool(catalog, "hindsight_bank_list").execute(
      "call",
      {},
      undefined,
      undefined,
      { cwd: mkdtempSync(join(tmpdir(), "pi-hindsight-catalog-")), sessionManager: {} } as never,
    );

    const details = result.details as {
      projectBankId: string;
      banks: Array<Record<string, unknown>>;
    };
    expect(details.projectBankId).toBe("coding-bank");
    expect(
      details.banks.map((entry) => [
        entry.id,
        entry.bankId,
        entry.role,
        entry.enabled,
        entry.access,
        entry.retainMode,
      ]),
    ).toEqual([
      ["project", "coding-bank", "coding", true, "read-write", "always"],
      ["user", "user-bank", "user", false, "read-write", "explicit-only"],
    ]);
  });

  it("drops the action enum and the old combined tool names", () => {
    const catalog = createOperationCatalog({
      getClient: () => client(),
      getConfig: () => DEFAULT_CONFIG,
      getProjectBankId: () => "bank",
    });

    for (const tool of catalog.tools) {
      const properties = (tool.parameters as JsonSchema).properties ?? {};
      expect(properties.action, tool.name).toBeUndefined();
    }

    const names = catalog.tools.map((tool) => tool.name);
    for (const legacy of [
      "hindsight_config",
      "hindsight_bank",
      "hindsight_mental_model",
      "hindsight_knowledge",
      "hindsight_retain_global",
    ]) {
      expect(names, legacy).not.toContain(legacy);
    }
  });

  it("splits each family into tools carrying only their own operation's parameters", () => {
    const catalog = createOperationCatalog({
      getClient: () => client(),
      getConfig: () => DEFAULT_CONFIG,
      getProjectBankId: () => "bank",
    });
    const splitTools = [
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
    ] as const;
    /** Explicit retain overrides stay on the two retain tools only. */
    const retainOnlyParams = [
      "documentId",
      "timestamp",
      "metadata",
      "updateMode",
      "observationScopes",
      "documentTags",
      "async",
    ];

    for (const name of splitTools) {
      const properties = (requireTool(catalog, name).parameters as JsonSchema).properties ?? {};
      expect(Object.keys(properties).length, name).toBeLessThanOrEqual(8);
      for (const param of retainOnlyParams) {
        expect(properties[param], `${name}.${param}`).toBeUndefined();
      }
    }

    expect(
      splitTools.map((name) =>
        ((requireTool(catalog, name).parameters as JsonSchema).required ?? []).slice().sort(),
      ),
    ).toEqual([
      [],
      ["patch"],
      [],
      [],
      [],
      [],
      ["id"],
      ["name", "sourceQuery"],
      ["id"],
      ["id"],
      ["id"],
      [],
      ["query"],
      ["id"],
      ["name", "sourceQuery"],
      ["name"],
      ["id"],
      ["id"],
      [],
      [],
    ]);
  });

  it("declares the public tool and command surface in one catalog", () => {
    const catalog = createOperationCatalog({
      getClient: () => client(),
      getConfig: () => DEFAULT_CONFIG,
      getProjectBankId: () => "bank",
    });

    expect(catalog.tools.map((tool) => tool.name)).toEqual([
      "hindsight_recall",
      "hindsight_retain",
      "hindsight_retain_user",
      "hindsight_reflect",
      "hindsight_status",
      "hindsight_seed_git",
      "hindsight_scope",
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
      "hindsight_scope_migrate",
    ]);

    // Human surface is TUI-first: hub + next-opt-out and omp-backend slash commands.
    expect(catalog.commands.map((command) => command.name)).toEqual([
      "hindsight",
      "hindsight:next-opt-out",
      "hindsight:omp-backend",
    ]);
  });
});
