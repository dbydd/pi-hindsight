import { Type } from "typebox";
import {
  defineTool,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { MemoryOperations, MemoryOperationsDeps } from "./memory-operation-service.js";
import { formatReflectResult } from "./reflect-presenter.js";
import { toolPresentation } from "./tool-presentation.js";
import { renderMemoryToolTextResult, retainToolResponse } from "../tui/tool-presenters.js";
import { getSessionFile } from "../utils/session.js";
import { hostConfigDirName } from "../config/paths.js";

/**
 * Built per call: the host profile (`.pi` vs `.omp`) is only known once the session
 * started, which is long after this module is loaded.
 */
function hindsightDisabledToolMessage(): string {
  return `Hindsight is disabled for this repository (enabled=false). Open /hindsight and set enabled=true (and restore status.style if desired), or edit ${hostConfigDirName()}/hindsight.json.`;
}

export type ToolOperation = Parameters<ExtensionAPI["registerTool"]>[0];

const tagMatchSchema = Type.Union(
  [
    Type.Literal("any"),
    Type.Literal("all"),
    Type.Literal("any_strict"),
    Type.Literal("all_strict"),
    Type.Literal("exact"),
  ],
  {
    description:
      "How to match tags. Always enforced together with the automatic Pi project/user scope tag filter. 'exact' folds the automatic scope tags into the exact-match set (memory tags must equal scope tags plus these tags, no more, no less) instead of AND-ing a separate scope group, since scope tags must still be present. To also include Hindsight shared/untagged observations (exact empty tags), set includeSharedObservations=true or config.scope.includeSharedObservations.",
  },
);

const budgetSchema = Type.Union([Type.Literal("low"), Type.Literal("mid"), Type.Literal("high")]);

const recallTypeSchema = Type.Union([
  Type.Literal("world"),
  Type.Literal("experience"),
  Type.Literal("observation"),
]);

const tagGroupJsonSchema = {
  type: "object",
  required: ["tags"],
  properties: {
    tags: { type: "array", items: { type: "string" } },
    match: { type: "string", enum: ["any", "all", "any_strict", "all_strict"] },
  },
  additionalProperties: false,
};

const tagGroupSchema = Type.Unsafe<import("../types.js").HindsightTagGroup>(tagGroupJsonSchema);

function tagGroupsSchema(description: string) {
  return Type.Optional(Type.Array(tagGroupSchema, { description }));
}

const retainEntitySchema = Type.Object({
  text: Type.String({ description: "Entity text to associate with the retained content." }),
  type: Type.Optional(Type.String({ description: "Optional entity type." })),
});

const retainUpdateModeSchema = Type.Union([Type.Literal("append"), Type.Literal("replace")], {
  description: "Optional Hindsight update mode for this explicit retain call.",
});

const observationScopesSchema = Type.Unsafe<import("../types.js").HindsightObservationScopes>({
  ...Type.Union([
    Type.Literal("per_tag"),
    Type.Literal("combined"),
    Type.Literal("all_combinations"),
    Type.Literal("shared"),
    Type.Array(Type.Array(Type.String())),
  ]),
  description:
    "Optional Hindsight observation scopes. Use per_tag, combined, all_combinations, shared, or explicit string groups. When provided, overrides configured default observation scopes for this retain call.",
});

function explicitRetainOptionParameters() {
  return {
    documentId: Type.Optional(
      Type.String({
        description:
          "Optional Hindsight document ID. Defaults to the existing deterministic explicit retain document ID.",
      }),
    ),
    timestamp: Type.Optional(
      Type.String({
        description:
          "Optional Hindsight timestamp string, including ISO-ish strings or literal unset, passed through as provided.",
      }),
    ),
    metadata: Type.Optional(
      Type.Record(Type.String(), Type.String(), {
        description:
          "Optional caller metadata string map. Reserved provenance keys such as cwd, pi_session_file, source, and retainSource are set by pi-hindsight and cannot be overridden.",
      }),
    ),
    updateMode: Type.Optional(retainUpdateModeSchema),
    observationScopes: Type.Optional(observationScopesSchema),
    documentTags: Type.Optional(
      Type.Array(Type.String(), {
        description: "Optional Hindsight document_tags for this retained document when supported.",
      }),
    ),
    async: Type.Optional(
      Type.Boolean({
        description:
          "Optional Hindsight async extraction flag for this retain call. Defaults to configured retain.async.",
      }),
    ),
  };
}

type ExplicitRetainOptionParams = {
  documentId?: string;
  timestamp?: string;
  metadata?: Record<string, string>;
  updateMode?: import("../types.js").UpdateMode;
  observationScopes?: import("../types.js").HindsightObservationScopes;
  documentTags?: string[];
  async?: boolean;
};

function explicitRetainOptions(params: ExplicitRetainOptionParams) {
  return {
    ...(params.documentId !== undefined ? { documentId: params.documentId } : {}),
    ...(params.timestamp !== undefined ? { timestamp: params.timestamp } : {}),
    ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
    ...(params.updateMode !== undefined ? { updateMode: params.updateMode } : {}),
    ...(params.observationScopes !== undefined
      ? { observationScopes: params.observationScopes }
      : {}),
    ...(params.documentTags !== undefined ? { documentTags: params.documentTags } : {}),
    ...(params.async !== undefined ? { async: params.async } : {}),
  };
}

export type CommandOperation = {
  name: string;
  spec: Parameters<ExtensionAPI["registerCommand"]>[1];
};

/**
 * The split tools carry only the parameters their single operation needs, so the
 * snippets several of them share are built here instead of being copied per tool.
 */
function bankParameter() {
  return Type.Optional(
    Type.String({
      description: "Bank id or alias project|user|global. Defaults to the coding/project bank.",
    }),
  );
}

/** Change-making tools default this to true in their handler. */
function dryRunParameter(description: string) {
  return Type.Optional(Type.Boolean({ description }));
}

function tagsParameter(description: string) {
  return Type.Optional(Type.Array(Type.String(), { description }));
}

function maxTokensParameter(description: string) {
  return Type.Optional(Type.Integer({ minimum: 1, description }));
}

function parentIdParameter() {
  return Type.Optional(
    Type.Union([Type.String(), Type.Null()], {
      description: "Folder parent. Omit for root create; pass null on update to move to root.",
    }),
  );
}

export interface OperationCatalog {
  tools: ToolOperation[];
  commands: CommandOperation[];
}

export function createOperationCatalog(deps: MemoryOperationsDeps): OperationCatalog {
  let operations: Promise<MemoryOperations> | undefined;
  const loadOperations = () => {
    operations ??= import("./memory-operation-service.js").then(({ createMemoryOperations }) =>
      createMemoryOperations(deps),
    );
    return operations;
  };
  const useCwd = (cwd: string) => deps.reloadConfig?.(cwd);

  function defineCatalogTool<TParams extends ToolDefinition["parameters"], TDetails = unknown>(
    tool: ToolDefinition<TParams, TDetails>,
  ): ToolOperation {
    // Single exposure boundary. `loadMode` (read by omp's `wrapper.ts` off the object
    // handed to `registerTool`) and `exposure` (read by pi) are host runtime keys that
    // the installed Pi `ToolDefinition` does not declare. `defineTool` passes unknown
    // fields through untouched, so merge the marks here — the one place that knows both
    // vocabularies — and narrow back to the host type; the marks ride along onto the
    // registered object.
    const marked = {
      ...tool,
      ...toolPresentation(tool.name),
    } as ToolDefinition<TParams, TDetails>;
    const defined = defineTool(marked);
    const execute = defined.execute.bind(defined);
    return {
      ...defined,
      async execute(id, params, signal, onUpdate, ctx) {
        useCwd(ctx.cwd);
        if (!deps.getConfig().enabled) {
          return {
            content: [{ type: "text" as const, text: hindsightDisabledToolMessage() }],
            details: { disabled: true as const },
          };
        }
        return execute(id, params, signal, onUpdate, ctx);
      },
    };
  }

  const tools: ToolOperation[] = [
    defineCatalogTool({
      name: "hindsight_recall",
      label: "Hindsight Recall",
      description: "Recall raw memories from Hindsight for this project.",
      parameters: Type.Object({
        query: Type.String({ description: "Natural language memory query" }),
        bank: Type.Optional(
          Type.String({ description: "Optional bank id. Defaults to project bank." }),
        ),
        types: Type.Optional(
          Type.Array(recallTypeSchema, {
            description: "Optional Hindsight fact types to retrieve.",
          }),
        ),
        preferObservations: Type.Optional(
          Type.Boolean({
            description:
              "When recalling raw facts ('world'/'experience') together with 'observation', drop raw facts superseded by a returned observation. Defaults to the configured recall.preferObservations.",
          }),
        ),
        minScores: Type.Optional(
          Type.Unsafe<import("@vectorize-io/hindsight-client").MinScores>({
            ...Type.Object({
              semantic: Type.Optional(
                Type.Number({
                  minimum: 0,
                  maximum: 1,
                  description: "Minimum vector similarity (0-1).",
                }),
              ),
              keyword: Type.Optional(Type.Number({ description: "Minimum keyword/BM25 score." })),
              reranker: Type.Optional(
                Type.Number({
                  minimum: 0,
                  maximum: 1,
                  description: "Minimum normalized reranker score (0-1).",
                }),
              ),
              final: Type.Optional(Type.Number({ description: "Minimum final ranking score." })),
            }),
            description:
              "Optional per-stage score floors. Omitted stages impose no floor. No floor by default.",
          }),
        ),
        budget: Type.Optional(
          Type.Unsafe<import("../types.js").Budget>({
            ...budgetSchema,
            description: "Optional Hindsight recall budget override for this tool call.",
          }),
        ),
        maxTokens: Type.Optional(
          Type.Integer({
            minimum: 0,
            description:
              "Optional Hindsight recall token cap override for this tool call. Use 0 for metadata/source-only recall when supported by Hindsight.",
          }),
        ),
        queryTimestamp: Type.Optional(
          Type.String({ description: "Optional ISO timestamp for time-scoped recall." }),
        ),
        includeChunks: Type.Optional(
          Type.Boolean({ description: "Ask Hindsight to include source chunks when supported." }),
        ),
        recallChunksMaxTokens: Type.Optional(
          Type.Integer({
            minimum: 0,
            description: "Optional token cap for included recall chunks.",
          }),
        ),
        includeSourceFacts: Type.Optional(
          Type.Boolean({ description: "Ask Hindsight to include source facts when supported." }),
        ),
        maxSourceFactsTokens: Type.Optional(
          Type.Integer({
            minimum: 0,
            description: "Optional token cap for included source facts.",
          }),
        ),
        includeEntities: Type.Optional(
          Type.Boolean({ description: "Ask Hindsight to include entities when supported." }),
        ),
        trace: Type.Optional(
          Type.Boolean({ description: "Ask Hindsight to include recall trace/debug data." }),
        ),
        tags: Type.Optional(Type.Array(Type.String(), { description: "Additional tag filter." })),
        tagsMatch: Type.Optional(tagMatchSchema),
        tagGroups: tagGroupsSchema(
          "Compound Hindsight tag_groups filter. AND-ed with the automatic Pi project/user scope filter.",
        ),
        includeSharedObservations: Type.Optional(
          Type.Boolean({
            description:
              "When true, also match exact-empty (shared/untagged) observations inside the bank via tag_groups OR. Defaults to config.scope.includeSharedObservations (false). Not cross-bank.",
          }),
        ),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        useCwd(ctx.cwd);
        const operations = await loadOperations();
        const sessionFile = ctx.sessionManager.getSessionFile?.();
        const { bankId, result } = await operations.recall(
          ctx.cwd,
          params.query,
          params.bank,
          sessionFile,
          {
            ...(params.types ? { types: params.types } : {}),
            ...(params.preferObservations !== undefined
              ? { preferObservations: params.preferObservations }
              : {}),
            ...(params.minScores !== undefined ? { minScores: params.minScores } : {}),
            ...(params.budget ? { budget: params.budget } : {}),
            ...(params.maxTokens !== undefined ? { maxTokens: params.maxTokens } : {}),
            ...(params.queryTimestamp ? { queryTimestamp: params.queryTimestamp } : {}),
            ...(params.includeChunks !== undefined ? { includeChunks: params.includeChunks } : {}),
            ...(params.recallChunksMaxTokens !== undefined
              ? { maxChunkTokens: params.recallChunksMaxTokens }
              : {}),
            ...(params.includeSourceFacts !== undefined
              ? { includeSourceFacts: params.includeSourceFacts }
              : {}),
            ...(params.maxSourceFactsTokens !== undefined
              ? { maxSourceFactsTokens: params.maxSourceFactsTokens }
              : {}),
            ...(params.includeEntities !== undefined
              ? { includeEntities: params.includeEntities }
              : {}),
            ...(params.trace !== undefined ? { trace: params.trace } : {}),
            ...(params.tags ? { tags: params.tags } : {}),
            ...(params.tagsMatch ? { tagsMatch: params.tagsMatch } : {}),
            ...(params.tagGroups
              ? { tagGroups: params.tagGroups as import("../types.js").HindsightTagGroup[] }
              : {}),
            ...(params.includeSharedObservations !== undefined
              ? { includeSharedObservations: params.includeSharedObservations }
              : {}),
            ...(signal ? { signal } : {}),
          },
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: { bankId },
        };
      },
      renderResult: renderMemoryToolTextResult,
    }),
    defineCatalogTool({
      name: "hindsight_retain",
      label: "Hindsight Retain",
      description: "Retain explicit raw content in Hindsight. Use for durable facts or decisions.",
      parameters: Type.Object({
        content: Type.String({
          description: "Raw content to retain, not summary if source content is available.",
        }),
        context: Type.String({ description: "Source context for this memory." }),
        bank: Type.Optional(
          Type.String({ description: "Optional bank id. Defaults to project bank." }),
        ),
        tags: Type.Optional(Type.Array(Type.String())),
        entities: Type.Optional(
          Type.Array(retainEntitySchema, {
            description: "Optional Hindsight entities to associate with this retained content.",
          }),
        ),
        ...explicitRetainOptionParameters(),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        useCwd(ctx.cwd);
        const operations = await loadOperations();
        const sessionFile = ctx.sessionManager.getSessionFile?.();
        const result = await operations.retainExplicit({
          cwd: ctx.cwd,
          content: params.content,
          context: params.context,
          ...(sessionFile ? { sessionFile } : {}),
          ...(params.bank ? { bank: params.bank } : {}),
          ...(params.tags ? { tags: params.tags } : {}),
          ...(params.entities ? { entities: params.entities } : {}),
          ...explicitRetainOptions(params),
        });
        return retainToolResponse(result);
      },
      renderResult: renderMemoryToolTextResult,
    }),
    defineCatalogTool({
      name: "hindsight_retain_user",
      label: "Hindsight Retain User",
      description:
        "Retain explicit durable user memory in the configured user bank. Use for stable user identity, preferences, and cross-project workflows only — for anything tied to this repository use hindsight_retain instead (hindsight_retain with bank=global reaches the same user bank).",
      parameters: Type.Object({
        content: Type.String({ description: "Raw memory content to retain." }),
        context: Type.String({ description: "Why this memory is durable user context." }),
        tags: Type.Optional(Type.Array(Type.String())),
        entities: Type.Optional(
          Type.Array(retainEntitySchema, {
            description: "Optional Hindsight entities to associate with this retained content.",
          }),
        ),
        ...explicitRetainOptionParameters(),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        useCwd(ctx.cwd);
        const operations = await loadOperations();
        const sessionFile = ctx.sessionManager.getSessionFile?.();
        const result = await operations.retainExplicit({
          cwd: ctx.cwd,
          content: params.content,
          context: params.context,
          bank: "global",
          ...(sessionFile ? { sessionFile } : {}),
          ...(params.tags ? { tags: params.tags } : {}),
          ...(params.entities ? { entities: params.entities } : {}),
          ...explicitRetainOptions(params),
        });
        return retainToolResponse(result);
      },
      renderResult: renderMemoryToolTextResult,
    }),
    defineCatalogTool({
      name: "hindsight_reflect",
      label: "Hindsight Reflect",
      description:
        "Ask Hindsight to synthesize an answer from memory. Use explicitly, not for default recall.",
      parameters: Type.Object({
        query: Type.String(),
        context: Type.Optional(Type.String()),
        bank: Type.Optional(Type.String()),
        budget: Type.Optional(
          Type.Unsafe<import("../types.js").Budget>({
            ...budgetSchema,
            description: "Optional Hindsight reflect budget override for this tool call.",
          }),
        ),
        maxTokens: Type.Optional(
          Type.Integer({
            minimum: 0,
            description: "Optional Hindsight reflect token cap override for this tool call.",
          }),
        ),
        responseSchema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        includeFacts: Type.Optional(
          Type.Boolean({ description: "Ask Hindsight reflect to include facts when supported." }),
        ),
        includeToolCalls: Type.Optional(
          Type.Boolean({
            description: "Ask Hindsight reflect to include tool-call trace data when supported.",
          }),
        ),
        includeToolCallOutput: Type.Optional(
          Type.Boolean({
            description:
              "When includeToolCalls is set, include tool-call outputs (default true); set false for an inputs-only trace.",
          }),
        ),
        factTypes: Type.Optional(
          Type.Array(recallTypeSchema, {
            description: "Restrict reflection to these Hindsight fact types.",
          }),
        ),
        excludeMentalModels: Type.Optional(
          Type.Boolean({ description: "Exclude all mental models from reflection." }),
        ),
        excludeMentalModelIds: Type.Optional(
          Type.Array(Type.String(), {
            description: "Exclude specific mental models by id from reflection.",
          }),
        ),
        tags: Type.Optional(Type.Array(Type.String(), { description: "Additional tag filter." })),
        tagsMatch: Type.Optional(tagMatchSchema),
        tagGroups: tagGroupsSchema(
          "Compound Hindsight tag_groups filter. AND-ed with the automatic Pi project/user scope filter.",
        ),
        includeSharedObservations: Type.Optional(
          Type.Boolean({
            description:
              "When true, also match exact-empty (shared/untagged) observations inside the bank via tag_groups OR. Defaults to config.scope.includeSharedObservations (false). Not cross-bank.",
          }),
        ),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        useCwd(ctx.cwd);
        const operations = await loadOperations();
        const { bankId, result } = await operations.reflect(
          ctx.cwd,
          params.query,
          params.context,
          params.bank,
          params.responseSchema,
          {
            ...(params.budget ? { budget: params.budget } : {}),
            ...(params.maxTokens !== undefined ? { maxTokens: params.maxTokens } : {}),
            ...(params.includeFacts !== undefined ? { includeFacts: params.includeFacts } : {}),
            ...(params.includeToolCalls !== undefined
              ? { includeToolCalls: params.includeToolCalls }
              : {}),
            ...(params.includeToolCallOutput !== undefined
              ? { includeToolCallOutput: params.includeToolCallOutput }
              : {}),
            ...(params.factTypes ? { factTypes: params.factTypes } : {}),
            ...(params.excludeMentalModels !== undefined
              ? { excludeMentalModels: params.excludeMentalModels }
              : {}),
            ...(params.excludeMentalModelIds
              ? { excludeMentalModelIds: params.excludeMentalModelIds }
              : {}),
            ...(params.tags ? { tags: params.tags } : {}),
            ...(params.tagsMatch ? { tagsMatch: params.tagsMatch } : {}),
            ...(params.tagGroups
              ? { tagGroups: params.tagGroups as import("../types.js").HindsightTagGroup[] }
              : {}),
            ...(params.includeSharedObservations !== undefined
              ? { includeSharedObservations: params.includeSharedObservations }
              : {}),
            ...(signal ? { signal } : {}),
          },
        );
        return {
          content: [{ type: "text", text: formatReflectResult(result) }],
          details: { bankId },
        };
      },
      renderResult: renderMemoryToolTextResult,
    }),
    defineCatalogTool({
      name: "hindsight_status",
      label: "Hindsight Status",
      description:
        "Inspect Pi Hindsight status: setup gate, coding/life banks, project scope tags (basis), recall/retain flags, queue, and sync readiness (queue depth, git seed receipt, knowledge-page capability). Use before changing memory config. Read-only.",
      parameters: Type.Object({}),
      async execute(_id, _params, signal, _onUpdate, ctx) {
        useCwd(ctx.cwd);
        if (signal?.aborted) throw new Error("Aborted");
        const operations = await loadOperations();
        const result = await operations.status(ctx.cwd);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
      renderResult: renderMemoryToolTextResult,
    }),
    defineCatalogTool({
      name: "hindsight_seed_git",
      label: "Hindsight Seed Git",
      description:
        "Opt-in cold-repo seed: retain recent git commit messages (strategy gitlog) into the project bank. Not automatic — conversation retain remains primary. dryRun defaults true; set dryRun=false to enqueue (and flush by default).",
      parameters: Type.Object({
        limit: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 2000,
            description: "Max commits to include (default 300).",
          }),
        ),
        dryRun: Type.Optional(
          Type.Boolean({
            description: "Default true (preview). Set false to enqueue retain.",
          }),
        ),
        flush: Type.Optional(
          Type.Boolean({
            description: "When dryRun=false, flush the queue after enqueue (default true).",
          }),
        ),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        useCwd(ctx.cwd);
        if (signal?.aborted) throw new Error("Aborted");
        const operations = await loadOperations();
        const result = await operations.seedGitLog({
          cwd: ctx.cwd,
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
          dryRun: params.dryRun ?? true,
          ...(params.flush !== undefined ? { flush: params.flush } : {}),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
      renderResult: renderMemoryToolTextResult,
    }),
    defineCatalogTool({
      name: "hindsight_scope",
      label: "Hindsight Scope",
      description:
        "Show active project identity: project:<id> tag, derivation (pin/remote/basename), scope.mode (domain-tagged vs isolated-bank), coding/life bank ids. Read-only.",
      parameters: Type.Object({}),
      async execute(_id, _params, signal, _onUpdate, ctx) {
        useCwd(ctx.cwd);
        if (signal?.aborted) throw new Error("Aborted");
        const operations = await loadOperations();
        const result = operations.scopeInfo(ctx.cwd);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
      renderResult: renderMemoryToolTextResult,
    }),
    defineCatalogTool({
      name: "hindsight_config_get",
      label: "Hindsight Config Get",
      description:
        "Read the effective allowlisted Pi Hindsight config values plus the allowlist; secrets are never returned. Read-only. Use it before hindsight_config_set to see what a patch would change; hindsight_status covers the setup gate, banks, and sync readiness instead.",
      parameters: Type.Object({}),
      async execute(_id, _params, signal, _onUpdate, ctx) {
        useCwd(ctx.cwd);
        if (signal?.aborted) throw new Error("Aborted");
        const operations = await loadOperations();
        const result = await operations.config({ action: "get", cwd: ctx.cwd });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
      renderResult: renderMemoryToolTextResult,
    }),
    defineCatalogTool({
      name: "hindsight_config_set",
      label: "Hindsight Config Set",
      description:
        "Patch allowlisted Pi Hindsight config (project or global file) with typed keys only: setupComplete, scopeMode, projectId, projectIdStrategy, includeSharedObservations, userScopeTags, projectBankId, enableGlobalBank, globalBankId, agentUse, mentalModelsInject, memoryProfile, recall/retain knobs, baseUrl, apiKeyEnvVar, timeoutMs. dryRun defaults true (preview) — set false to write. Domain-tagged setupComplete requires projectBankId. Never pass raw API keys — use apiKeyEnvVar. Read current values with hindsight_config_get first.",
      parameters: Type.Object({
        patch: Type.Object(
          {
            setupComplete: Type.Optional(Type.Boolean()),
            scopeMode: Type.Optional(
              Type.Union([Type.Literal("domain-tagged"), Type.Literal("isolated-bank")]),
            ),
            projectId: Type.Optional(Type.String({ minLength: 1 })),
            projectIdStrategy: Type.Optional(
              Type.Union([Type.Literal("remote"), Type.Literal("basename")]),
            ),
            includeSharedObservations: Type.Optional(Type.Boolean()),
            userScopeTags: Type.Optional(
              Type.Array(Type.String(), {
                description:
                  "User/life bank recall tags (any_strict). Empty array disables the tag filter. Writes scope.userScopeTags.",
              }),
            ),
            projectBankId: Type.Optional(Type.String({ minLength: 1 })),
            enableGlobalBank: Type.Optional(Type.Boolean()),
            globalBankId: Type.Optional(Type.String({ minLength: 1 })),
            agentUse: Type.Optional(
              Type.Union([Type.Literal("coding"), Type.Literal("conversation")]),
            ),
            mentalModelsInject: Type.Optional(Type.Boolean()),
            memoryProfile: Type.Optional(
              Type.Union([
                Type.Literal("project-only"),
                Type.Literal("project+global"),
                Type.Literal("global-only"),
                Type.Literal("recall-only"),
              ]),
            ),
            recallEnabled: Type.Optional(Type.Boolean()),
            recallBudget: Type.Optional(
              Type.Union([Type.Literal("low"), Type.Literal("mid"), Type.Literal("high")]),
            ),
            recallMaxTokens: Type.Optional(Type.Number({ minimum: 0 })),
            retainEnabled: Type.Optional(Type.Boolean()),
            baseUrl: Type.Optional(Type.String({ minLength: 1 })),
            apiKeyEnvVar: Type.Optional(Type.String({ minLength: 1 })),
            timeoutMs: Type.Optional(Type.Number({ minimum: 0 })),
          },
          {
            additionalProperties: false,
            description: "Typed allowlisted config fields only (no free-form keys).",
          },
        ),
        scope: Type.Optional(
          Type.Union([Type.Literal("project"), Type.Literal("global")], {
            description: `Which config file to write (default project ${hostConfigDirName()}/hindsight.json).`,
          }),
        ),
        dryRun: dryRunParameter("When true (default), preview only; set false to write."),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        useCwd(ctx.cwd);
        if (signal?.aborted) throw new Error("Aborted");
        const operations = await loadOperations();
        const result = await operations.config({
          action: "patch",
          cwd: ctx.cwd,
          patch: params.patch as Record<string, unknown>,
          ...(params.scope ? { scope: params.scope } : {}),
          dryRun: params.dryRun ?? true,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
      renderResult: renderMemoryToolTextResult,
    }),
    defineCatalogTool({
      name: "hindsight_bank_list",
      label: "Hindsight Bank List",
      description:
        "List the banks Pi is configured with (id, bankId, role, enabled, access, retain mode) without contacting Hindsight. Use it to pick the bank value for the sibling bank, mental-model, and knowledge-page tools; hindsight_status shows live bank health, and hindsight_bank_get returns one bank's Hindsight-side facts. Read-only.",
      parameters: Type.Object({}),
      async execute(_id, _params, signal, _onUpdate, ctx) {
        useCwd(ctx.cwd);
        if (signal?.aborted) throw new Error("Aborted");
        const operations = await loadOperations();
        const result = operations.bankList();
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
      renderResult: renderMemoryToolTextResult,
    }),
    defineCatalogTool({
      name: "hindsight_bank_get",
      label: "Hindsight Bank Get",
      description:
        "Read one bank's Hindsight-side facts: existence (list-banks), stats, and bank config. A retired /profile is not a hard failure. Read-only. Use hindsight_bank_set_mission to change missions, and hindsight_bank_list for the Pi-configured bank list.",
      parameters: Type.Object({
        bank: bankParameter(),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        useCwd(ctx.cwd);
        if (signal?.aborted) throw new Error("Aborted");
        const operations = await loadOperations();
        const result = await operations.bankGet(params.bank ? { bank: params.bank } : {});
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
      renderResult: renderMemoryToolTextResult,
    }),
    defineCatalogTool({
      name: "hindsight_bank_set_mission",
      label: "Hindsight Bank Set Mission",
      description:
        "Patch a bank's retain/reflect/observations mission text; at least one of the three is required. dryRun defaults true (preview) — set false to write. Read the current missions with hindsight_bank_get first and propose a change only when extraction has been consistently wrong. Use hindsight_bank_list for the Pi-configured bank list.",
      parameters: Type.Object({
        bank: bankParameter(),
        retainMission: Type.Optional(
          Type.String({ description: "Replacement retain mission text." }),
        ),
        reflectMission: Type.Optional(
          Type.String({ description: "Replacement reflect mission text." }),
        ),
        observationsMission: Type.Optional(
          Type.String({ description: "Replacement observations mission text." }),
        ),
        dryRun: dryRunParameter("When true (default), preview only; set false to write."),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        useCwd(ctx.cwd);
        if (signal?.aborted) throw new Error("Aborted");
        const operations = await loadOperations();
        const result = await operations.bankUpdateMission({
          ...(params.bank ? { bank: params.bank } : {}),
          ...(params.retainMission !== undefined ? { retainMission: params.retainMission } : {}),
          ...(params.reflectMission !== undefined ? { reflectMission: params.reflectMission } : {}),
          ...(params.observationsMission !== undefined
            ? { observationsMission: params.observationsMission }
            : {}),
          dryRun: params.dryRun ?? true,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
      renderResult: renderMemoryToolTextResult,
    }),
    defineCatalogTool({
      name: "hindsight_mm_list",
      label: "Hindsight Mental Model List",
      description:
        "List the mental models on a bank as metadata only (id, name, tags, max_tokens, last_refreshed_at). Use it to find ids, then hindsight_mm_get for full content/reflect_response. Create or change models with hindsight_mm_create/update/refresh/delete (dry-run first). Read-only.",
      parameters: Type.Object({
        bank: bankParameter(),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        useCwd(ctx.cwd);
        if (signal?.aborted) throw new Error("Aborted");
        const operations = await loadOperations();
        const result = await operations.mentalModel({
          action: "list",
          cwd: ctx.cwd,
          ...(params.bank ? { bank: params.bank } : {}),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
      renderResult: renderMemoryToolTextResult,
    }),
    defineCatalogTool({
      name: "hindsight_mm_get",
      label: "Hindsight Mental Model Get",
      description:
        "Read one mental model's full content and reflect_response by id. Get ids from hindsight_mm_list (metadata-only); regenerate content with hindsight_mm_refresh. Read-only.",
      parameters: Type.Object({
        id: Type.String({ description: "Mental model id, from hindsight_mm_list." }),
        bank: bankParameter(),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        useCwd(ctx.cwd);
        if (signal?.aborted) throw new Error("Aborted");
        const operations = await loadOperations();
        const result = await operations.mentalModel({
          action: "get",
          cwd: ctx.cwd,
          id: params.id,
          ...(params.bank ? { bank: params.bank } : {}),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
      renderResult: renderMemoryToolTextResult,
    }),
    defineCatalogTool({
      name: "hindsight_mm_create",
      label: "Hindsight Mental Model Create",
      description:
        "Create one mental model from a name plus the question it answers. dryRun defaults true (preview) — set false to create. Coding-bank models default tags to source:pi + project:<activeId>; optional tagsMatch sets refresh tag matching on the create trigger. Keep one dimension per model. Use hindsight_mm_update for an existing id, hindsight_mm_refresh to regenerate it.",
      parameters: Type.Object({
        name: Type.String({ description: "Mental model name; one dimension per model." }),
        sourceQuery: Type.String({
          description: "Question the model answers, answerable from retained memory.",
        }),
        id: Type.Optional(Type.String({ description: "Optional caller-chosen model id." })),
        bank: bankParameter(),
        tags: tagsParameter(
          "Optional tag override; omitted defaults to source:pi (+ project:<activeId> on the coding bank).",
        ),
        maxTokens: maxTokensParameter("Optional model content cap in tokens."),
        tagsMatch: Type.Optional(tagMatchSchema),
        dryRun: dryRunParameter("When true (default), preview only; set false to create."),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        useCwd(ctx.cwd);
        if (signal?.aborted) throw new Error("Aborted");
        const operations = await loadOperations();
        const result = await operations.mentalModel({
          action: "create",
          cwd: ctx.cwd,
          name: params.name,
          sourceQuery: params.sourceQuery,
          ...(params.bank ? { bank: params.bank } : {}),
          ...(params.id ? { id: params.id } : {}),
          ...(params.tags ? { tags: params.tags } : {}),
          ...(params.maxTokens !== undefined ? { maxTokens: params.maxTokens } : {}),
          ...(params.tagsMatch ? { tagsMatch: params.tagsMatch } : {}),
          dryRun: params.dryRun ?? true,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
      renderResult: renderMemoryToolTextResult,
    }),
    defineCatalogTool({
      name: "hindsight_mm_update",
      label: "Hindsight Mental Model Update",
      description:
        "Patch one mental model by id: name, sourceQuery, tags, maxTokens, and/or tagsMatch (at least one required). dryRun defaults true (preview) — set false to write. Read the current model with hindsight_mm_get first; use hindsight_mm_refresh when only the content needs regenerating.",
      parameters: Type.Object({
        id: Type.String({ description: "Mental model id to update." }),
        bank: bankParameter(),
        name: Type.Optional(Type.String({ description: "New model name." })),
        sourceQuery: Type.Optional(Type.String({ description: "New model question." })),
        tags: tagsParameter("New tag list for the model."),
        maxTokens: maxTokensParameter("New model content cap in tokens."),
        tagsMatch: Type.Optional(tagMatchSchema),
        dryRun: dryRunParameter("When true (default), preview only; set false to write."),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        useCwd(ctx.cwd);
        if (signal?.aborted) throw new Error("Aborted");
        const operations = await loadOperations();
        const result = await operations.mentalModel({
          action: "update",
          cwd: ctx.cwd,
          id: params.id,
          ...(params.bank ? { bank: params.bank } : {}),
          ...(params.name ? { name: params.name } : {}),
          ...(params.sourceQuery ? { sourceQuery: params.sourceQuery } : {}),
          ...(params.tags ? { tags: params.tags } : {}),
          ...(params.maxTokens !== undefined ? { maxTokens: params.maxTokens } : {}),
          ...(params.tagsMatch ? { tagsMatch: params.tagsMatch } : {}),
          dryRun: params.dryRun ?? true,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
      renderResult: renderMemoryToolTextResult,
    }),
    defineCatalogTool({
      name: "hindsight_mm_refresh",
      label: "Hindsight Mental Model Refresh",
      description:
        "Regenerate one mental model's content now from its tags and source query. dryRun defaults true (preview) — set false to refresh. Use after relevant memory lands; the inject cache may lag (mentalModels.cacheTtlMs). Use hindsight_mm_update to change the model's definition instead.",
      parameters: Type.Object({
        id: Type.String({ description: "Mental model id to refresh." }),
        bank: bankParameter(),
        dryRun: dryRunParameter("When true (default), preview only; set false to refresh."),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        useCwd(ctx.cwd);
        if (signal?.aborted) throw new Error("Aborted");
        const operations = await loadOperations();
        const result = await operations.mentalModel({
          action: "refresh",
          cwd: ctx.cwd,
          id: params.id,
          ...(params.bank ? { bank: params.bank } : {}),
          dryRun: params.dryRun ?? true,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
      renderResult: renderMemoryToolTextResult,
    }),
    defineCatalogTool({
      name: "hindsight_mm_delete",
      label: "Hindsight Mental Model Delete",
      description:
        "Delete one mental model by id. dryRun defaults true (preview) — set false to delete. Confirm the target with hindsight_mm_get first; Pi cannot restore a deleted model. Use hindsight_mm_update when the model should change rather than disappear.",
      parameters: Type.Object({
        id: Type.String({ description: "Mental model id to delete." }),
        bank: bankParameter(),
        dryRun: dryRunParameter("When true (default), preview only; set false to delete."),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        useCwd(ctx.cwd);
        if (signal?.aborted) throw new Error("Aborted");
        const operations = await loadOperations();
        const result = await operations.mentalModel({
          action: "delete",
          cwd: ctx.cwd,
          id: params.id,
          ...(params.bank ? { bank: params.bank } : {}),
          dryRun: params.dryRun ?? true,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
      renderResult: renderMemoryToolTextResult,
    }),
    defineCatalogTool({
      name: "hindsight_kb_tree",
      label: "Hindsight Knowledge Page Tree",
      description:
        "Show the knowledge-page tree (folders and pages) of a bank. Read-only. For routine Q&A prefer hindsight_kb_search then hindsight_kb_get — knowledge pages are not auto-injected into context. Requires Hindsight client/server knowledge-base support.",
      parameters: Type.Object({
        bank: bankParameter(),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        useCwd(ctx.cwd);
        if (signal?.aborted) throw new Error("Aborted");
        const operations = await loadOperations();
        const result = await operations.knowledge({
          action: "tree",
          cwd: ctx.cwd,
          ...(params.bank ? { bank: params.bank } : {}),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
      renderResult: renderMemoryToolTextResult,
    }),
    defineCatalogTool({
      name: "hindsight_kb_search",
      label: "Hindsight Knowledge Page Search",
      description:
        "Hybrid-search knowledge pages in a bank and return matching page references. Read-only. Pair it with hindsight_kb_get (search, then get) for routine Q&A; use hindsight_kb_tree to browse structure instead. Requires Hindsight client/server knowledge-base support.",
      parameters: Type.Object({
        query: Type.String({ description: "Hybrid page-search query." }),
        limit: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 50, description: "Search result limit (1–50)." }),
        ),
        bank: bankParameter(),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        useCwd(ctx.cwd);
        if (signal?.aborted) throw new Error("Aborted");
        const operations = await loadOperations();
        const result = await operations.knowledge({
          action: "search",
          cwd: ctx.cwd,
          query: params.query,
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
          ...(params.bank ? { bank: params.bank } : {}),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
      renderResult: renderMemoryToolTextResult,
    }),
    defineCatalogTool({
      name: "hindsight_kb_get",
      label: "Hindsight Knowledge Page Get",
      description:
        "Read one knowledge page or folder by id, with its full content. Read-only. Get ids from hindsight_kb_search or hindsight_kb_tree; change a page with hindsight_kb_update. Requires Hindsight client/server knowledge-base support.",
      parameters: Type.Object({
        id: Type.String({ description: "Page or folder id to read." }),
        bank: bankParameter(),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        useCwd(ctx.cwd);
        if (signal?.aborted) throw new Error("Aborted");
        const operations = await loadOperations();
        const result = await operations.knowledge({
          action: "get",
          cwd: ctx.cwd,
          id: params.id,
          ...(params.bank ? { bank: params.bank } : {}),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
      renderResult: renderMemoryToolTextResult,
    }),
    defineCatalogTool({
      name: "hindsight_kb_create_page",
      label: "Hindsight Knowledge Page Create",
      description:
        "Create one knowledge page from the question it documents. dryRun defaults true (preview) — set false to create. Coding-bank pages default tags to source:pi + project:<activeId>; optional tagsMatch restates the server page defaults with refresh tag matching. Nest it with parentId, create a folder with hindsight_kb_create_folder, and change an existing page with hindsight_kb_update. Requires Hindsight client/server knowledge-base support.",
      parameters: Type.Object({
        name: Type.String({ description: "Page name." }),
        sourceQuery: Type.String({ description: "The question this page documents." }),
        parentId: parentIdParameter(),
        bank: bankParameter(),
        tags: tagsParameter(
          "Optional tag override; omitted defaults to source:pi (+ project:<activeId> on the coding bank).",
        ),
        maxTokens: maxTokensParameter("Optional page content cap in tokens."),
        tagsMatch: Type.Optional(tagMatchSchema),
        dryRun: dryRunParameter("When true (default), preview only; set false to create."),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        useCwd(ctx.cwd);
        if (signal?.aborted) throw new Error("Aborted");
        const operations = await loadOperations();
        const result = await operations.knowledge({
          action: "create_page",
          cwd: ctx.cwd,
          name: params.name,
          sourceQuery: params.sourceQuery,
          ...(params.parentId !== undefined ? { parentId: params.parentId } : {}),
          ...(params.bank ? { bank: params.bank } : {}),
          ...(params.tags ? { tags: params.tags } : {}),
          ...(params.maxTokens !== undefined ? { maxTokens: params.maxTokens } : {}),
          ...(params.tagsMatch ? { tagsMatch: params.tagsMatch } : {}),
          dryRun: params.dryRun ?? true,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
      renderResult: renderMemoryToolTextResult,
    }),
    defineCatalogTool({
      name: "hindsight_kb_create_folder",
      label: "Hindsight Knowledge Folder Create",
      description:
        "Create one knowledge page folder, optionally nested under parentId. dryRun defaults true (preview) — set false to create. Folders group pages; create pages with hindsight_kb_create_page. Requires Hindsight client/server knowledge-base support.",
      parameters: Type.Object({
        name: Type.String({ description: "Folder name." }),
        parentId: parentIdParameter(),
        bank: bankParameter(),
        dryRun: dryRunParameter("When true (default), preview only; set false to create."),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        useCwd(ctx.cwd);
        if (signal?.aborted) throw new Error("Aborted");
        const operations = await loadOperations();
        const result = await operations.knowledge({
          action: "create_folder",
          cwd: ctx.cwd,
          name: params.name,
          ...(params.parentId !== undefined ? { parentId: params.parentId } : {}),
          ...(params.bank ? { bank: params.bank } : {}),
          dryRun: params.dryRun ?? true,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
      renderResult: renderMemoryToolTextResult,
    }),
    defineCatalogTool({
      name: "hindsight_kb_update",
      label: "Hindsight Knowledge Page Update",
      description:
        "Patch one knowledge page or folder by id: name, parentId, sourceQuery, tags, and/or maxTokens (at least one required). Pass parentId null to move it back to the root. dryRun defaults true (preview) — set false to write. Read the target with hindsight_kb_get first. Requires Hindsight client/server knowledge-base support.",
      parameters: Type.Object({
        id: Type.String({ description: "Page or folder id to update." }),
        bank: bankParameter(),
        name: Type.Optional(Type.String({ description: "New page or folder name." })),
        parentId: parentIdParameter(),
        sourceQuery: Type.Optional(Type.String({ description: "New page question." })),
        tags: tagsParameter("New tag list for the page."),
        maxTokens: maxTokensParameter("New page content cap in tokens."),
        dryRun: dryRunParameter("When true (default), preview only; set false to write."),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        useCwd(ctx.cwd);
        if (signal?.aborted) throw new Error("Aborted");
        const operations = await loadOperations();
        const result = await operations.knowledge({
          action: "update",
          cwd: ctx.cwd,
          id: params.id,
          ...(params.bank ? { bank: params.bank } : {}),
          ...(params.name ? { name: params.name } : {}),
          ...(params.parentId !== undefined ? { parentId: params.parentId } : {}),
          ...(params.sourceQuery ? { sourceQuery: params.sourceQuery } : {}),
          ...(params.tags ? { tags: params.tags } : {}),
          ...(params.maxTokens !== undefined ? { maxTokens: params.maxTokens } : {}),
          dryRun: params.dryRun ?? true,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
      renderResult: renderMemoryToolTextResult,
    }),
    defineCatalogTool({
      name: "hindsight_kb_delete",
      label: "Hindsight Knowledge Page Delete",
      description:
        "Delete one knowledge page or folder by id. dryRun defaults true (preview) — set false to delete; Pi cannot restore it. Confirm the target with hindsight_kb_get or hindsight_kb_tree first. Requires Hindsight client/server knowledge-base support.",
      parameters: Type.Object({
        id: Type.String({ description: "Page or folder id to delete." }),
        bank: bankParameter(),
        dryRun: dryRunParameter("When true (default), preview only; set false to delete."),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        useCwd(ctx.cwd);
        if (signal?.aborted) throw new Error("Aborted");
        const operations = await loadOperations();
        const result = await operations.knowledge({
          action: "delete",
          cwd: ctx.cwd,
          id: params.id,
          ...(params.bank ? { bank: params.bank } : {}),
          dryRun: params.dryRun ?? true,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
      renderResult: renderMemoryToolTextResult,
    }),
    defineCatalogTool({
      name: "hindsight_kb_seed_taxonomy",
      label: "Hindsight Knowledge Seed Taxonomy",
      description:
        "Seed the fixed five-page coding knowledge taxonomy (idempotent; tags knowledge:component|concept|convention|decision|feature-work). dryRun defaults true (preview) — set false to apply. Degrades with knowledge_pages_unavailable when the client/server lacks knowledge-base APIs. Use hindsight_kb_create_page for one custom page instead.",
      parameters: Type.Object({
        bank: bankParameter(),
        dryRun: dryRunParameter("When true (default), preview only; set false to apply."),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        useCwd(ctx.cwd);
        if (signal?.aborted) throw new Error("Aborted");
        const operations = await loadOperations();
        const result = await operations.knowledge({
          action: "seed_taxonomy",
          cwd: ctx.cwd,
          ...(params.bank ? { bank: params.bank } : {}),
          dryRun: params.dryRun ?? true,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
      renderResult: renderMemoryToolTextResult,
    }),
    defineCatalogTool({
      name: "hindsight_kb_export",
      label: "Hindsight Knowledge Base Export",
      description:
        "Export the whole bank knowledge base as one portable markdown bundle. Heavy and read-only — use it only for a full export/backup, not routine reading (that is hindsight_kb_search + hindsight_kb_get). Requires Hindsight client/server knowledge-base support.",
      parameters: Type.Object({
        bank: bankParameter(),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        useCwd(ctx.cwd);
        if (signal?.aborted) throw new Error("Aborted");
        const operations = await loadOperations();
        const result = await operations.knowledge({
          action: "export",
          cwd: ctx.cwd,
          ...(params.bank ? { bank: params.bank } : {}),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
      renderResult: renderMemoryToolTextResult,
    }),
    defineCatalogTool({
      name: "hindsight_scope_migrate",
      label: "Hindsight Scope Migrate Dry-Run",
      description: `Dry-run only: plan dual-tag / legacy repo:<path-hash> → project:<id> migration. Writes a local receipt under ${hostConfigDirName()}/hindsight/. Never rewrites Hindsight tags or documents. Prefer Hindsight export/import or Pi transcript reimport for actual rebuilds.`,
      parameters: Type.Object({
        bankTags: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "Optional tag inventory sample from the coding bank (e.g. listTags). Used only for counts in the plan.",
          }),
        ),
        writeReceipt: Type.Optional(
          Type.Boolean({
            description: `Write ${hostConfigDirName()}/hindsight/scope-migrate-receipt.json (default true).`,
          }),
        ),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        useCwd(ctx.cwd);
        const operations = await loadOperations();
        const result = await operations.scopeMigrateDryRun(ctx.cwd, {
          ...(params.bankTags ? { bankTags: params.bankTags } : {}),
          ...(params.writeReceipt !== undefined ? { writeReceipt: params.writeReceipt } : {}),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: { dryRun: true, rewrite: "none" },
        };
      },
      renderResult: renderMemoryToolTextResult,
    }),
  ];

  // Human surface is TUI-first: `/hindsight` hub plus a few deliberate slash commands.
  // Day-to-day ops (mode, import, mental models, flush, doctor, init) live in the hub.
  const commands: CommandOperation[] = [
    {
      name: "hindsight",
      spec: {
        description:
          "Open Hindsight memory hub (status, mode, next-opt-out, mental models, import, flush, doctor, setup).",
        handler: async (_args, ctx) => {
          const { runHindsightSetupTui } = await import("../tui/setup-tui.js");
          await runHindsightSetupTui(ctx, deps);
        },
      },
    },
    {
      name: "hindsight:next-opt-out",
      spec: {
        description: "Skip automatic retain for the next agent run in this session.",
        handler: async (_args, ctx) => {
          const operations = await loadOperations();
          const result = await operations.setNextRetainOff(ctx.cwd, getSessionFile(ctx));
          ctx.ui.notify(
            `Hindsight will skip automatic retain for the next agent run in this session. nextRetain=${result.meta.nextRetainMode}`,
            "info",
          );
        },
      },
    },
  ];

  return { tools, commands };
}
