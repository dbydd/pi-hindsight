import {
  RECALL_SCORE_FIELDS,
  type BankConfigEntry,
  type BankRetainMode,
  type DecisionConfig,
  type HindsightEntityInput,
  type RecallMinScores,
  type ResolvedConfig,
} from "../types.js";
import { DEFAULT_CONFIG } from "./config-defaults.js";
import { isRecord } from "./is-record.js";
import { normalizeBankEntries, normalizeBanksFallback } from "./banks.js";

export { isRecord };

export function merge<T>(base: T, patch: unknown): T {
  if (!isRecord(base) || !isRecord(patch)) return (patch ?? base) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isRecord(value) && isRecord(out[key]) ? merge(out[key], value) : value;
  }
  return out as T;
}

export function envBool(env: NodeJS.ProcessEnv, name: string): boolean | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

export function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function optionalString(value: unknown, fallback?: string): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function validEnvVarName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

export function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

export function stringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : fallback;
}

export function stringMatrix(value: unknown, fallback: string[][]): string[][] {
  return Array.isArray(value) &&
    value.every(
      (scope) =>
        Array.isArray(scope) && scope.length > 0 && scope.every((item) => typeof item === "string"),
    )
    ? value
    : fallback;
}

export function enumArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T[],
): T[] {
  return Array.isArray(value) && value.every((item) => allowed.includes(item as T))
    ? (value as T[])
    : fallback;
}

export function optionalStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}
function normalizeApiKeyRefString(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("env:")) return undefined;
  const name = value.slice("env:".length);
  return validEnvVarName(name) ? value : undefined;
}

function normalizeApiKeyRef(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (value.source !== "env" || typeof value.name !== "string" || !validEnvVarName(value.name))
    return undefined;
  return `env:${value.name}`;
}

function resolveApiKeyRef(ref: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (!ref) return undefined;
  if (!ref.startsWith("env:")) return undefined;
  const name = ref.slice("env:".length);
  return name ? optionalString(env[name]) : undefined;
}

function directApiKey(value: unknown, fallback?: string): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function entityArray(value: unknown, fallback: HindsightEntityInput[]): HindsightEntityInput[] {
  if (!Array.isArray(value)) return fallback;
  const entities = value
    .map((item) => {
      if (!isRecord(item) || typeof item.text !== "string" || item.text.length === 0)
        return undefined;
      return {
        text: item.text,
        ...(typeof item.type === "string" && item.type.length > 0 ? { type: item.type } : {}),
      } satisfies HindsightEntityInput;
    })
    .filter((item): item is HindsightEntityInput => Boolean(item));
  return entities.length === value.length ? entities : fallback;
}

function toolNameFilter(
  value: unknown,
  fallback: { include?: string[]; exclude?: string[] },
): { include?: string[]; exclude?: string[] } {
  if (!isRecord(value)) return fallback;
  const hasInclude = "include" in value;
  const hasExclude = "exclude" in value;
  const include = optionalStringArray(value.include);
  const exclude = optionalStringArray(value.exclude);
  if ((hasInclude && !include) || (hasExclude && !exclude) || (!hasInclude && !hasExclude)) {
    return fallback;
  }
  return {
    ...(include ? { include } : {}),
    ...(exclude ? { exclude } : {}),
  };
}

function retainBeforeEnqueue(
  value: unknown,
): NonNullable<ResolvedConfig["retain"]["beforeEnqueue"]> {
  if (!isRecord(value)) return { command: [], timeoutMs: 5_000, malformed: true };
  const command =
    Array.isArray(value.command) &&
    value.command.length > 0 &&
    value.command.every((item) => typeof item === "string" && item.length > 0)
      ? value.command
      : undefined;
  const timeoutMs = positiveInt(value.timeoutMs, 5_000);
  return command ? { command, timeoutMs } : { command: [], timeoutMs, malformed: true };
}

function scoreFloors(value: unknown): RecallMinScores | undefined {
  if (!isRecord(value)) return undefined;
  const floors: RecallMinScores = {};
  for (const field of RECALL_SCORE_FIELDS) {
    const valueForField = value[field];
    if (typeof valueForField === "number" && Number.isFinite(valueForField)) {
      floors[field] = valueForField;
    }
  }
  return Object.keys(floors).length ? floors : undefined;
}

/**
 * `decision` is normalized like the rest of the config: unusable values fall back
 * to defaults, and fallback bank ids resolve against the configured entries so a
 * stale id cannot route to a bank that no longer exists.
 */
function decisionConfig(value: unknown, banks: BankConfigEntry[]): DecisionConfig {
  const raw = isRecord(value) ? value : {};
  const fallback = isRecord(raw.fallback) ? raw.fallback : {};
  const instructions = isRecord(raw.instructions) ? raw.instructions : {};
  // A usable written number is kept; everything else (missing, non-integer,
  // non-positive) falls through to the model-derived budget in decision.ts.
  const writtenContextChars =
    typeof raw.maxContextChars === "number" &&
    Number.isInteger(raw.maxContextChars) &&
    raw.maxContextChars > 0
      ? raw.maxContextChars
      : undefined;
  return {
    enabled: bool(raw.enabled, DEFAULT_CONFIG.decision.enabled),
    model: stringValue(raw.model, DEFAULT_CONFIG.decision.model),
    // Non-positive is a setting, not an error: no cap on the answer budget.
    maxTokens: intOr(raw.maxTokens, DEFAULT_CONFIG.decision.maxTokens),
    // Non-positive is a setting, not an error: it normalizes to "no timer".
    timeoutMs: normalizeTimeoutMs(raw.timeoutMs, DEFAULT_CONFIG.decision.timeoutMs),
    maxContextChars: writtenContextChars ?? DEFAULT_CONFIG.decision.maxContextChars,
    // A blank written string is not a setting: it would mute the gate, so it
    // falls back to the built-in default instead.
    instructions: {
      inject: writtenText(instructions.inject, DEFAULT_CONFIG.decision.instructions.inject),
      read: writtenText(instructions.read, DEFAULT_CONFIG.decision.instructions.read),
      write: writtenText(instructions.write, DEFAULT_CONFIG.decision.instructions.write),
    },
    // A probability outside 0-1 is unusable, not a setting; the default stands.
    threshold: probability(raw.threshold, DEFAULT_CONFIG.decision.threshold),
    maxContextCharsWritten: writtenContextChars !== undefined,
    cacheTtlMs: positiveInt(raw.cacheTtlMs, DEFAULT_CONFIG.decision.cacheTtlMs),
    fallback: {
      recallBanks: normalizeBanksFallback(fallback.recallBanks, banks),
      retainBanks: normalizeBanksFallback(fallback.retainBanks, banks),
    },
  };
}

/** A written integer, or the fallback for anything that is not one. */
function intOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

/** A non-empty string, or the fallback for a missing or blank one. */
function writtenText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

/** A finite number in [0, 1], or the fallback for anything else. */
function probability(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : fallback;
}

/**
 * A written non-positive budget means "no timer", so it lands on `Infinity`:
 * `withTimeout` arms no timer for a non-finite value and only the caller's own
 * signal can stop the call.
 */
function normalizeTimeoutMs(value: unknown, fallback: number): number {
  const budget = intOr(value, fallback);
  return budget > 0 ? budget : Number.POSITIVE_INFINITY;
}

function hasConfiguredRecallField(rawConfig: unknown, field: string): boolean {
  return isRecord(rawConfig) && isRecord(rawConfig.recall) && field in rawConfig.recall;
}

/**
 * The legacy `userRetain.mode` / `globalRetain.mode` value a config layer declared,
 * if any. Both are single-valued (`explicit-only`) today; a nonsense value stays
 * unread here and falls back to the default in the `userRetain` section below.
 */
function declaredUserRetainMode(rawConfig: unknown): BankRetainMode | undefined {
  if (!isRecord(rawConfig)) return undefined;
  for (const key of ["userRetain", "globalRetain"]) {
    const section = rawConfig[key];
    if (isRecord(section) && section.mode === "explicit-only") return "explicit-only";
  }
  return undefined;
}

/**
 * Map a legacy `userRetain.mode` / `globalRetain.mode` onto the user entry's
 * `retain.mode`, so a config that predates the `banks` array keeps stating the
 * User Bank write mode in the new place. An entry that declares its own mode wins:
 * the guided-setup writer sets the legacy field for every profile.
 */
function applyLegacyUserRetainMode(
  banks: BankConfigEntry[],
  rawConfig: unknown,
): BankConfigEntry[] {
  const mode = declaredUserRetainMode(rawConfig);
  if (!mode) return banks;
  const index = banks.findIndex((entry) => entry.alias === "user");
  if (index < 0 || banks[index]!.retain?.mode) return banks;
  return banks.map((entry, at) =>
    at === index ? { ...entry, retain: { ...entry.retain, mode } } : entry,
  );
}

export function normalizeConfig(
  config: ResolvedConfig,
  rawConfig?: unknown,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConfig {
  const apiKeyRef =
    normalizeApiKeyRef(config.hindsight?.apiKey) ??
    normalizeApiKeyRefString(config.hindsight?.apiKeyRef) ??
    normalizeApiKeyRefString(DEFAULT_CONFIG.hindsight.apiKeyRef);
  const apiKey =
    directApiKey(config.hindsight?.apiKey, DEFAULT_CONFIG.hindsight.apiKey) ??
    resolveApiKeyRef(apiKeyRef, env);
  // `banks` may be the new array or the legacy three-slot object; both normalize here.
  // The legacy user-retain mode then lands on the user entry, its new home.
  const banks = applyLegacyUserRetainMode(
    normalizeBankEntries(config.banks, DEFAULT_CONFIG.banks),
    rawConfig,
  );
  const banksFallback = normalizeBanksFallback(config.banksFallback, banks);
  const minScores = scoreFloors(config.recall?.minScores);
  const scopeRaw = (
    config as {
      scope?: {
        mode?: unknown;
        projectId?: unknown;
        projectIdStrategy?: unknown;
        includeSharedObservations?: unknown;
        userScopeTags?: unknown;
      };
    }
  ).scope;
  const projectIdPin = optionalString(scopeRaw?.projectId, DEFAULT_CONFIG.scope.projectId);
  const userScopeTags = [
    ...new Set(
      stringArray(scopeRaw?.userScopeTags, DEFAULT_CONFIG.scope.userScopeTags).filter(Boolean),
    ),
  ];
  return {
    enabled: bool(config.enabled, DEFAULT_CONFIG.enabled),
    setupComplete: bool(
      (config as { setupComplete?: unknown }).setupComplete,
      DEFAULT_CONFIG.setupComplete,
    ),
    scope: {
      mode: enumValue(
        scopeRaw?.mode,
        ["domain-tagged", "isolated-bank"] as const,
        DEFAULT_CONFIG.scope.mode,
      ),
      ...(projectIdPin ? { projectId: projectIdPin } : {}),
      projectIdStrategy: enumValue(
        scopeRaw?.projectIdStrategy,
        ["remote", "basename"] as const,
        DEFAULT_CONFIG.scope.projectIdStrategy,
      ),
      includeSharedObservations: bool(
        scopeRaw?.includeSharedObservations,
        DEFAULT_CONFIG.scope.includeSharedObservations,
      ),
      // Empty array is intentional: no tag filter on user-bank recall (#592).
      userScopeTags,
    },
    hindsight: {
      baseUrl: stringValue(config.hindsight?.baseUrl, DEFAULT_CONFIG.hindsight.baseUrl),
      ...(apiKey ? { apiKey } : {}),
      ...(apiKeyRef ? { apiKeyRef } : {}),
      timeoutMs: positiveInt(config.hindsight?.timeoutMs, DEFAULT_CONFIG.hindsight.timeoutMs),
    },
    agentUse: enumValue(
      (config as { agentUse?: unknown }).agentUse,
      ["coding", "conversation"],
      DEFAULT_CONFIG.agentUse,
    ),
    mentalModels: {
      inject: bool(
        (config as { mentalModels?: { inject?: unknown } }).mentalModels?.inject,
        DEFAULT_CONFIG.mentalModels.inject,
      ),
      maxChars: positiveInt(
        (config as { mentalModels?: { maxChars?: unknown } }).mentalModels?.maxChars,
        DEFAULT_CONFIG.mentalModels.maxChars,
      ),
      cacheTtlMs: positiveInt(
        (config as { mentalModels?: { cacheTtlMs?: unknown } }).mentalModels?.cacheTtlMs,
        DEFAULT_CONFIG.mentalModels.cacheTtlMs,
      ),
    },
    banks,
    banksFallback,
    decision: decisionConfig(config.decision, banks),
    observations: {
      enabled: bool(config.observations?.enabled, DEFAULT_CONFIG.observations.enabled),
      scopes: stringMatrix(config.observations?.scopes, DEFAULT_CONFIG.observations.scopes),
    },
    userRetain: {
      mode: enumValue(
        config.userRetain?.mode ?? config.globalRetain?.mode,
        ["explicit-only"],
        DEFAULT_CONFIG.userRetain.mode,
      ),
    },
    globalRetain: {
      mode: enumValue(
        config.userRetain?.mode ?? config.globalRetain?.mode,
        ["explicit-only"],
        DEFAULT_CONFIG.userRetain.mode,
      ),
    },
    recall: {
      enabled: bool(config.recall?.enabled, DEFAULT_CONFIG.recall.enabled),
      budget: enumValue(
        config.recall?.budget,
        ["low", "mid", "high"],
        DEFAULT_CONFIG.recall.budget,
      ),
      maxTokens: positiveInt(config.recall?.maxTokens, DEFAULT_CONFIG.recall.maxTokens),
      userMaxTokens: positiveInt(config.recall?.userMaxTokens, DEFAULT_CONFIG.recall.userMaxTokens),
      types: stringArray(config.recall?.types, DEFAULT_CONFIG.recall.types),
      includeSourceFacts: bool(
        config.recall?.includeSourceFacts,
        DEFAULT_CONFIG.recall.includeSourceFacts,
      ),
      maxSourceFactsTokens: positiveInt(
        config.recall?.maxSourceFactsTokens,
        DEFAULT_CONFIG.recall.maxSourceFactsTokens,
      ),
      contextTurns: positiveInt(config.recall?.contextTurns, DEFAULT_CONFIG.recall.contextTurns),
      roles: enumArray(
        config.recall?.roles,
        ["user", "assistant", "tool", "system"],
        DEFAULT_CONFIG.recall.roles,
      ),
      maxQueryChars: positiveInt(config.recall?.maxQueryChars, DEFAULT_CONFIG.recall.maxQueryChars),
      queryPreamble:
        typeof config.recall?.queryPreamble === "string"
          ? config.recall.queryPreamble
          : DEFAULT_CONFIG.recall.queryPreamble,
      projectQueryPreamble:
        hasConfiguredRecallField(rawConfig, "projectQueryPreamble") &&
        typeof config.recall?.projectQueryPreamble === "string"
          ? config.recall.projectQueryPreamble
          : hasConfiguredRecallField(rawConfig, "queryPreamble") &&
              typeof config.recall?.queryPreamble === "string"
            ? config.recall.queryPreamble
            : DEFAULT_CONFIG.recall.projectQueryPreamble,
      globalQueryPreamble:
        hasConfiguredRecallField(rawConfig, "userQueryPreamble") &&
        typeof config.recall?.userQueryPreamble === "string"
          ? config.recall.userQueryPreamble
          : hasConfiguredRecallField(rawConfig, "globalQueryPreamble") &&
              typeof config.recall?.globalQueryPreamble === "string"
            ? config.recall.globalQueryPreamble
            : hasConfiguredRecallField(rawConfig, "queryPreamble") &&
                typeof config.recall?.queryPreamble === "string"
              ? config.recall.queryPreamble
              : (DEFAULT_CONFIG.recall.userQueryPreamble ??
                DEFAULT_CONFIG.recall.globalQueryPreamble),
      includeDateInQuery: bool(
        config.recall?.includeDateInQuery,
        DEFAULT_CONFIG.recall.includeDateInQuery,
      ),
      includeRepoHintsInQuery: bool(
        config.recall?.includeRepoHintsInQuery,
        DEFAULT_CONFIG.recall.includeRepoHintsInQuery,
      ),
      storeLastRecall: bool(config.recall?.storeLastRecall, DEFAULT_CONFIG.recall.storeLastRecall),
      storeLastRecallFailures: bool(
        config.recall?.storeLastRecallFailures,
        DEFAULT_CONFIG.recall.storeLastRecallFailures,
      ),
      lastRecallPath:
        typeof config.recall?.lastRecallPath === "string" && config.recall.lastRecallPath.trim()
          ? config.recall.lastRecallPath
          : DEFAULT_CONFIG.recall.lastRecallPath,
      topK: positiveInt(config.recall?.topK, DEFAULT_CONFIG.recall.topK),
      timeoutMs: positiveInt(config.recall?.timeoutMs, DEFAULT_CONFIG.recall.timeoutMs),
      cacheTtlMs: positiveInt(config.recall?.cacheTtlMs, DEFAULT_CONFIG.recall.cacheTtlMs),
      injectionMode: "context",
      injectionPosition: enumValue(
        config.recall?.injectionPosition,
        ["prepend", "append"],
        DEFAULT_CONFIG.recall.injectionPosition,
      ),
      includeFactsInDebug: bool(
        config.recall?.includeFactsInDebug,
        DEFAULT_CONFIG.recall.includeFactsInDebug,
      ),
      preferObservations: bool(
        config.recall?.preferObservations,
        DEFAULT_CONFIG.recall.preferObservations,
      ),
      mode: enumValue(
        config.recall?.mode,
        ["every-turn", "decision", "interval", "manual"],
        DEFAULT_CONFIG.recall.mode,
      ),
      bankMode: enumValue(
        config.recall?.bankMode,
        ["all", "decision"],
        DEFAULT_CONFIG.recall.bankMode,
      ),
      everyNTurns: positiveInt(config.recall?.everyNTurns, DEFAULT_CONFIG.recall.everyNTurns),
      minIntervalMs: positiveInt(config.recall?.minIntervalMs, DEFAULT_CONFIG.recall.minIntervalMs),
      ...(minScores ? { minScores } : {}),
      ...(optionalString(config.recall?.queryTimestamp, DEFAULT_CONFIG.recall.queryTimestamp)
        ? {
            queryTimestamp: stringValue(
              config.recall?.queryTimestamp,
              DEFAULT_CONFIG.recall.queryTimestamp ?? "",
            ),
          }
        : {}),
    },
    retain: {
      enabled: bool(config.retain?.enabled, DEFAULT_CONFIG.retain.enabled),
      async: bool(config.retain?.async, DEFAULT_CONFIG.retain.async),
      delivery: enumValue(
        config.retain?.delivery,
        ["immediate", "coalesced"],
        DEFAULT_CONFIG.retain.delivery,
      ),
      updateMode: enumValue(
        config.retain?.updateMode,
        ["append", "replace"],
        DEFAULT_CONFIG.retain.updateMode,
      ),
      content: {
        user: enumArray(config.retain?.content?.user, ["text"], DEFAULT_CONFIG.retain.content.user),
        assistant: enumArray(
          config.retain?.content?.assistant,
          ["text", "toolCall", "thinking"],
          DEFAULT_CONFIG.retain.content.assistant,
        ),
        toolResult: enumArray(
          config.retain?.content?.toolResult,
          ["error", "summary", "content"],
          DEFAULT_CONFIG.retain.content.toolResult,
        ),
      },
      toolFilter: {
        toolCall: toolNameFilter(
          config.retain?.toolFilter?.toolCall,
          DEFAULT_CONFIG.retain.toolFilter.toolCall,
        ),
        toolResult: toolNameFilter(
          config.retain?.toolFilter?.toolResult,
          DEFAULT_CONFIG.retain.toolFilter.toolResult,
        ),
      },
      compactToolCalls: bool(
        config.retain?.compactToolCalls,
        DEFAULT_CONFIG.retain.compactToolCalls,
      ),
      strip: {
        message: stringArray(config.retain?.strip?.message, DEFAULT_CONFIG.retain.strip.message),
        topLevel: stringArray(config.retain?.strip?.topLevel, DEFAULT_CONFIG.retain.strip.topLevel),
      },
      redactSecrets: bool(config.retain?.redactSecrets, DEFAULT_CONFIG.retain.redactSecrets),
      entities: entityArray(config.retain?.entities, DEFAULT_CONFIG.retain.entities),
      queuePath: stringValue(config.retain?.queuePath, DEFAULT_CONFIG.retain.queuePath),
      flushIntervalMs: Math.max(
        0,
        typeof config.retain?.flushIntervalMs === "number" &&
          Number.isInteger(config.retain.flushIntervalMs)
          ? config.retain.flushIntervalMs
          : DEFAULT_CONFIG.retain.flushIntervalMs,
      ),
      periodicFlushMaxJobs: positiveInt(
        config.retain?.periodicFlushMaxJobs,
        DEFAULT_CONFIG.retain.periodicFlushMaxJobs,
      ),
      periodicFlushTimeoutMs: positiveInt(
        config.retain?.periodicFlushTimeoutMs,
        DEFAULT_CONFIG.retain.periodicFlushTimeoutMs,
      ),
      shutdownFlushMaxJobs: positiveInt(
        config.retain?.shutdownFlushMaxJobs,
        DEFAULT_CONFIG.retain.shutdownFlushMaxJobs,
      ),
      shutdownFlushTimeoutMs: positiveInt(
        config.retain?.shutdownFlushTimeoutMs,
        DEFAULT_CONFIG.retain.shutdownFlushTimeoutMs,
      ),
      postRetainReflect: bool(
        config.retain?.postRetainReflect,
        DEFAULT_CONFIG.retain.postRetainReflect,
      ),
      ...(config.retain?.beforeEnqueue !== undefined
        ? { beforeEnqueue: retainBeforeEnqueue(config.retain.beforeEnqueue) }
        : {}),
    },
    import: {
      mode: enumValue(
        config.import?.mode,
        ["curated", "raw", "forensic"],
        DEFAULT_CONFIG.import.mode,
      ),
      qualityProfile: enumValue(
        config.import?.qualityProfile,
        ["compatible", "strict"],
        DEFAULT_CONFIG.import.qualityProfile,
      ),
      turnsPerDocument: positiveInt(
        config.import?.turnsPerDocument,
        DEFAULT_CONFIG.import.turnsPerDocument,
      ),
      maxDocumentBytes: positiveInt(
        config.import?.maxDocumentBytes,
        DEFAULT_CONFIG.import.maxDocumentBytes,
      ),
      includeBranches: enumValue(
        config.import?.includeBranches,
        ["current-only", "all-leaves"],
        DEFAULT_CONFIG.import.includeBranches,
      ),
      toolResults: enumValue(
        config.import?.toolResults,
        ["errors-only", "summary", "content"],
        DEFAULT_CONFIG.import.toolResults,
      ),
      toolResultSummaryMaxChars: positiveInt(
        config.import?.toolResultSummaryMaxChars,
        DEFAULT_CONFIG.import.toolResultSummaryMaxChars,
      ),
      replaceExistingImportedDocs: bool(
        config.import?.replaceExistingImportedDocs,
        DEFAULT_CONFIG.import.replaceExistingImportedDocs,
      ),
      manifestPath: stringValue(config.import?.manifestPath, DEFAULT_CONFIG.import.manifestPath),
      checkpointPath: stringValue(
        config.import?.checkpointPath,
        DEFAULT_CONFIG.import.checkpointPath,
      ),
      resume: bool(config.import?.resume, DEFAULT_CONFIG.import.resume),
    },
    status: {
      style: enumValue(
        config.status?.style,
        ["off", "text", "emoji", "nerdfont"],
        DEFAULT_CONFIG.status.style,
      ),
      detail: enumValue(
        config.status?.detail,
        ["minimal", "project", "activity", "verbose"],
        DEFAULT_CONFIG.status.detail,
      ),
      maxLength: positiveInt(config.status?.maxLength, DEFAULT_CONFIG.status.maxLength),
      showActivity: bool(config.status?.showActivity, DEFAULT_CONFIG.status.showActivity),
    },
    notifications: {
      startup: bool(config.notifications?.startup, DEFAULT_CONFIG.notifications.startup),
      recall: bool(config.notifications?.recall, DEFAULT_CONFIG.notifications.recall),
      retain: bool(config.notifications?.retain, DEFAULT_CONFIG.notifications.retain),
    },
  };
}
