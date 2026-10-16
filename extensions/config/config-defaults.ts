import { DEFAULT_DECISION_INSTRUCTIONS } from "../decision/instructions.js";
import type { ResolvedConfig } from "../types.js";
import { DEFAULT_DECISION_THRESHOLD } from "../types.js";

import { hostConfigDirName } from "./paths.js";

/**
 * State paths are host-derived, so they are read per access: the host profile
 * (`.pi` vs `.omp`) is only known once the session started, which is after this
 * module is loaded.
 */

export const DEFAULT_CONFIG: ResolvedConfig = {
  enabled: true,
  setupComplete: false,
  scope: {
    mode: "domain-tagged",
    projectIdStrategy: "remote",
    includeSharedObservations: false,
    userScopeTags: ["source:pi", "harness:pi"],
  },
  hindsight: { baseUrl: "http://localhost:8888", timeoutMs: 30_000 },
  agentUse: "coding",
  mentalModels: {
    inject: true,
    maxChars: 12_000,
    cacheTtlMs: 300_000,
  },
  banks: [
    { id: "coding", alias: "project", enabled: true, access: "read-write", derive: "repo" },
    { id: "life", alias: "user", enabled: false, access: "read-write" },
  ],
  banksFallback: [],
  decision: {
    enabled: true,
    model: "role:judge",
    maxTokens: 4_096,
    // The default arms no timer: a written value <= 0 normalizes here too, and
    // the decision model's own transport decides how long the call may take.
    timeoutMs: Number.POSITIVE_INFINITY,
    // Final fallback when neither a hand-written value nor a resolved model
    // supplies a budget; see DecisionConfig.maxContextChars.
    maxContextChars: 32_768,
    instructions: DEFAULT_DECISION_INSTRUCTIONS,
    threshold: DEFAULT_DECISION_THRESHOLD,
    maxContextCharsWritten: false,
    cacheTtlMs: 60_000,
    fallback: { recallBanks: [], retainBanks: [] },
  },
  recall: {
    enabled: true,
    budget: "mid",
    maxTokens: 800,
    userMaxTokens: 400,
    types: ["observation"],
    includeSourceFacts: false,
    maxSourceFactsTokens: 4096,
    contextTurns: 2,
    roles: ["user", "assistant"],
    maxQueryChars: 800,
    queryPreamble: "Pi coding task memory lookup.",
    projectQueryPreamble:
      "Project memory lookup for current repo architecture, tasks, bugs, decisions, and constraints.",
    globalQueryPreamble:
      "User memory lookup for durable user preferences, recurring workflows, coding habits, and cross-project context.",
    userQueryPreamble:
      "User memory lookup for durable user preferences, recurring workflows, coding habits, and cross-project context.",
    includeDateInQuery: false,
    includeRepoHintsInQuery: true,
    storeLastRecall: false,
    storeLastRecallFailures: false,
    get lastRecallPath() {
      return `${hostConfigDirName()}/hindsight/last-recall.json`;
    },
    topK: 8,
    timeoutMs: 40_000,
    cacheTtlMs: 60_000,
    injectionMode: "context",
    injectionPosition: "append",
    includeFactsInDebug: false,
    preferObservations: true,
    mode: "every-turn",
    bankMode: "all",
    everyNTurns: 5,
    minIntervalMs: 0,
  },
  observations: {
    enabled: true,
    // Project-stable scope; {repoKey} remains a supported placeholder for legacy configs.
    scopes: [["harness:pi"], ["project:{projectId}"]],
  },
  globalRetain: {
    mode: "explicit-only",
  },
  userRetain: {
    mode: "explicit-only",
  },
  retain: {
    enabled: true,
    async: true,
    delivery: "immediate",
    updateMode: "append",
    content: {
      user: ["text"],
      assistant: ["text", "toolCall"],
      toolResult: ["error"],
    },
    toolFilter: {
      toolCall: {
        exclude: [
          "hindsight_retain",
          "hindsight_retain_user",
          "hindsight_delete_document",
          "hindsight_retain_receipts",
          "hindsight_route_memory",
          "hindsight_recall",
          "hindsight_reflect",
        ],
      },
      toolResult: {
        exclude: [
          "hindsight_retain",
          "hindsight_retain_user",
          "hindsight_delete_document",
          "hindsight_retain_receipts",
          "hindsight_route_memory",
          "hindsight_recall",
          "hindsight_reflect",
          "read",
          "grep",
          "find",
          "find_files",
          "ls",
        ],
      },
    },
    compactToolCalls: true,
    strip: { message: ["usage", "cost", "responseId"], topLevel: ["id", "parentId"] },
    redactSecrets: true,
    entities: [],
    get queuePath() {
      return `${hostConfigDirName()}/hindsight/retain-queue.jsonl`;
    },
    flushIntervalMs: 0,
    periodicFlushMaxJobs: 1,
    periodicFlushTimeoutMs: 2_000,
    shutdownFlushMaxJobs: 10,
    shutdownFlushTimeoutMs: 2_000,
    postRetainReflect: false,
  },
  import: {
    mode: "curated",
    qualityProfile: "compatible",
    turnsPerDocument: 12,
    maxDocumentBytes: 80_000,
    includeBranches: "current-only",
    toolResults: "errors-only",
    toolResultSummaryMaxChars: 500,
    replaceExistingImportedDocs: true,
    get manifestPath() {
      return `${hostConfigDirName()}/hindsight/import-manifest.json`;
    },
    get checkpointPath() {
      return `${hostConfigDirName()}/hindsight/import-checkpoint.json`;
    },
    resume: true,
  },
  status: {
    style: "text",
    detail: "activity",
    maxLength: 24,
    showActivity: true,
  },
  notifications: {
    startup: true,
    recall: false,
    retain: false,
  },
};
