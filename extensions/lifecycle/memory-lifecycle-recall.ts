import { createHash } from "node:crypto";
import {
  emitRetrieval,
  telemetryEvent,
  telemetryFailure,
  retrievalId,
  type RetrievalObserver,
  type RetrievalTelemetry,
} from "./retrieval-telemetry.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isAbortError } from "../client/timeout.js";
import { recallForContext } from "./recall.js";
import { redactError } from "../utils/sanitize.js";
import { writeLastRecallSnapshot } from "./recall-visibility.js";
import { selectMemoryScopes, type MemoryRecallScope } from "../operations/memory-scope.js";
import {
  getEffectiveSessionMemoryMode,
  readSessionMemoryMeta,
} from "../utils/session-memory-meta.js";
import type { HindsightActivity } from "../utils/status.js";
import type { DecisionLayer } from "../decision/decision.js";
import type { DecisionBankCandidate } from "../decision/types.js";
import type { HindsightLikeClient, RecallBlock, RecallFailure, ResolvedConfig } from "../types.js";
import type { ContextEvent, ContextPatch, RuntimeSnapshot } from "./memory-lifecycle-runtime.js";

export type RecallStatusActivity = Extract<
  HindsightActivity,
  "idle" | "recalling" | "recalled" | "recall-empty" | "recall-failed"
>;

export interface RecallTurnPolicy {
  recall(event: ContextEvent, runtime: RuntimeSnapshot): Promise<ContextPatch | undefined>;
}

export interface RecallTurnPolicyDeps {
  observer?: RetrievalObserver;
  getConfig(): ResolvedConfig;
  getClient(): HindsightLikeClient;
  /**
   * Decision layer for `recall.mode: "decision"` and `recall.bankMode: "decision"`.
   * Absent means those gates degrade to the fixed scope set instead of failing.
   */
  getDecisionLayer?: () => DecisionLayer | undefined;
  setMemoryStatus(
    runtime: RuntimeSnapshot,
    activity: RecallStatusActivity,
    memoryCount?: number,
  ): void;
  notify(runtime: RuntimeSnapshot, message: string, level: "info" | "warning"): void;
}

/** `recall.mode: "interval"` state; one per policy instance, so one per session. */
interface RecallIntervalState {
  /** Context hooks seen since this policy was created. */
  turns: number;
  /** Turn index of the last recall a server answered; undefined before the first. */
  lastRecallTurn: number | undefined;
  /** Start time of the last recall a server answered; undefined before the first. */
  lastRecallAt: number | undefined;
}

interface RecallCacheEntry {
  rendered: string;
  blocks: RecallBlock[];
  failed: number;
  failures: RecallFailure[];
  timestamp: number;
}

type CacheKeyMessage = { role?: string; content?: unknown; timestamp?: number };

export function lastUserMessageContentIdentity(messages: readonly CacheKeyMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    const content = message.content;
    return typeof content === "string" ? content : JSON.stringify(content ?? "");
  }
  return "";
}

/** Bank IDs + last-user content; transcript length is not part of the key (auto-continue retries). */
export function recallTurnCacheKey(
  bankIds: readonly string[],
  messages: readonly CacheKeyMessage[],
): string {
  return `${bankIds.join(",")}|${lastUserMessageContentIdentity(messages)}`;
}

export function createRecallCache(ttlMs: number | (() => number) = 60000) {
  const cache = new Map<string, { entry: RecallCacheEntry; timestamp: number }>();
  const ttl = () => (typeof ttlMs === "function" ? ttlMs() : ttlMs);
  return {
    get(key: string): RecallCacheEntry | undefined {
      const cached = cache.get(key);
      if (!cached) return undefined;
      if (Date.now() - cached.timestamp > ttl()) {
        cache.delete(key);
        return undefined;
      }
      return cached.entry;
    },
    set(key: string, entry: RecallCacheEntry) {
      cache.set(key, { entry, timestamp: Date.now() });
    },
  };
}

function canAppendRecallMessage(event: ContextEvent): boolean {
  const last = event.messages[event.messages.length - 1];
  const lastRole = (last as unknown as { role?: string } | undefined)?.role;
  return Boolean(last && lastRole === "user");
}

function buildRecallNotification(memoryCount: number, bankIds: string[], failed: number): string {
  if (memoryCount > 0) {
    return `Hindsight recalled ${memoryCount} memory item${memoryCount === 1 ? "" : "s"} from ${bankIds.join(", ")}${failed > 0 ? `; ${failed} bank${failed === 1 ? "" : "s"} failed` : ""}`;
  }
  if (failed > 0) return `Hindsight recall failed for ${failed} bank${failed === 1 ? "" : "s"}`;
  return "Hindsight recalled no matching memory";
}

function patchWithRecallMessage(
  event: ContextEvent,
  recallMessage: AgentMessage,
): ContextPatch | undefined {
  const last = event.messages[event.messages.length - 1];
  const lastRole = (last as unknown as { role?: string } | undefined)?.role;
  if (last && lastRole === "user") {
    return { messages: [...event.messages.slice(0, -1), recallMessage, last] };
  }
  return undefined;
}

/** Both interval gates must be exhausted: enough turns, and enough elapsed time. */
function intervalDue(
  state: RecallIntervalState,
  recall: ResolvedConfig["recall"],
  now: number,
): boolean {
  const turnsSince =
    state.lastRecallTurn === undefined ? state.turns : state.turns - state.lastRecallTurn;
  if (turnsSince < recall.everyNTurns) return false;
  return state.lastRecallAt === undefined || now - state.lastRecallAt >= recall.minIntervalMs;
}

/** Read candidates mirror the scope set, so a bank the model picks always yields a scope. */
function readBankCandidates(
  scopes: readonly MemoryRecallScope[],
  config: ResolvedConfig,
): DecisionBankCandidate[] {
  return scopes.map((scope) => {
    const entry = config.banks.find((candidate) => candidate.id === scope.entryId);
    return {
      id: scope.entryId,
      access: entry?.access ?? "read-write",
      ...(entry?.description ? { description: entry.description } : {}),
    };
  });
}

export function createRecallTurnPolicy(deps: RecallTurnPolicyDeps): RecallTurnPolicy {
  const cache = createRecallCache(() => deps.getConfig().recall.cacheTtlMs);
  const origins = new WeakMap<RecallCacheEntry, RetrievalTelemetry[]>();
  const interval: RecallIntervalState = {
    turns: 0,
    lastRecallTurn: undefined,
    lastRecallAt: undefined,
  };
  return {
    async recall(event: ContextEvent, runtime: RuntimeSnapshot): Promise<ContextPatch | undefined> {
      const started = Date.now();
      const contextId = deps.observer ? retrievalId() : undefined;
      const retrievals: RetrievalTelemetry[] = [];
      let cacheStatus: "hit" | "miss" | "none" = "none";
      const observe: RetrievalObserver = (item) => {
        retrievals.push(structuredClone(item));
        emitRetrieval(deps.observer, () => item);
      };
      const injection = (
        status: RetrievalTelemetry["status"],
        rendered = "",
        extra: Record<string, unknown> = {},
      ) => {
        emitRetrieval(deps.observer, () =>
          telemetryEvent(started, {
            phase: "injection",
            mode: "automatic",
            cache: cacheStatus,
            status,
            contextId,
            injected: Boolean(rendered),
            retrievalIds: retrievals.flatMap((e) => (e.retrievalId ? [e.retrievalId] : [])),
            injectedIds: rendered ? retrievals.flatMap((e) => e.injectedIds ?? []) : [],
            injectedCount: rendered
              ? retrievals.reduce((n, e) => n + (e.injectedCount ?? 0), 0)
              : 0,
            renderedHash: createHash("sha256").update(rendered).digest("hex"),
            renderedLength: rendered.length,
            ...extra,
          }),
        );
      };
      const skip = (reason: string) => {
        injection("skipped", "", { reason });
        return undefined;
      };
      const config = deps.getConfig();
      if (!config.enabled || !config.recall.enabled) return skip("disabled");
      if (config.recall.mode === "manual") return skip("manual");

      const sessionMemory = getEffectiveSessionMemoryMode(
        await readSessionMemoryMeta(runtime.cwd, runtime.sessionFile),
      );
      if (!sessionMemory.recall) return skip("session-disabled");

      interval.turns += 1;
      if (config.recall.mode === "interval" && !intervalDue(interval, config.recall, Date.now())) {
        return skip("interval");
      }

      const scopes = selectMemoryScopes(runtime.cwd, config);
      if (scopes.length === 0) return skip("no-scopes");
      if (config.recall.injectionPosition === "append" && !canAppendRecallMessage(event)) {
        return skip("append-requires-user");
      }

      let recallResult: RecallCacheEntry | undefined;
      try {
        if (runtime.signal?.aborted) {
          deps.setMemoryStatus(runtime, "idle");
          return skip("aborted");
        }

        // One decision call covers both gates: whether this turn injects, and which
        // read banks the turn uses. Each gate is honored only by the mode that asked
        // for it, and a missing layer leaves the fixed scope set in place — routing
        // quality is what a broken decision costs, never the turn's memory.
        let readScopes = scopes;
        const layer =
          config.recall.mode === "decision" || config.recall.bankMode === "decision"
            ? deps.getDecisionLayer?.()
            : undefined;
        if (layer) {
          const decision = await layer.decide({
            messages: event.messages,
            readCandidates: readBankCandidates(scopes, config),
            // Retain routing is not part of the recall path.
            writeCandidates: [],
            ...(runtime.signal ? { signal: runtime.signal } : {}),
          });
          if (config.recall.mode === "decision" && !decision.inject) {
            return skip("decision-no-inject");
          }
          if (config.recall.bankMode === "decision") {
            const selected = new Set(decision.readBanks);
            readScopes = scopes.filter((scope) => selected.has(scope.entryId));
            if (readScopes.length === 0) return skip("decision-no-banks");
          }
        }

        const cacheKey = recallTurnCacheKey(
          readScopes.map((s) => s.bankId),
          event.messages,
        );
        recallResult = cache.get(cacheKey);
        cacheStatus = recallResult ? "hit" : "miss";
        if (recallResult && deps.observer) {
          for (const origin of origins.get(recallResult) ?? []) {
            emitRetrieval(observe, () =>
              telemetryEvent(started, {
                ...origin,
                phase: "retrieval",
                mode: "automatic",
                status: origin.status,
                cache: "hit",
                contextId,
                retrievalId: retrievalId(),
                cacheOriginId: origin.retrievalId,
                startedAt: new Date(started).toISOString(),
                endedAt: new Date().toISOString(),
                durationMs: Date.now() - started,
              }),
            );
          }
        }
        if (!recallResult) {
          deps.setMemoryStatus(runtime, "recalling");
          const fetched = await recallForContext({
            client: deps.getClient(),
            config,
            scopes: readScopes,
            messages: event.messages,
            cwd: runtime.cwd,
            ...(deps.observer ? { observer: observe, contextId } : {}),
            ...(runtime.signal ? { signal: runtime.signal } : {}),
          });
          if (runtime.signal?.aborted) {
            deps.setMemoryStatus(runtime, "idle");
            return skip("aborted");
          }
          recallResult = { ...fetched, timestamp: Date.now() };
          if (deps.observer) origins.set(recallResult, retrievals.slice());
          cache.set(cacheKey, recallResult);
        }
        if (runtime.signal?.aborted) {
          deps.setMemoryStatus(runtime, "idle");
          return skip("aborted");
        }
        const { rendered, blocks, failed, failures, timestamp } = recallResult;
        // Both interval gates measure from the last turn a server answered, whether
        // it was served fresh or from the turn cache.
        if (config.recall.mode === "interval" && failed === 0) {
          interval.lastRecallTurn = interval.turns;
          interval.lastRecallAt = Date.now();
        }
        const memoryCount = blocks.reduce((count, block) => count + block.memoryCount, 0);
        deps.setMemoryStatus(
          runtime,
          memoryCount > 0 ? "recalled" : failed > 0 ? "recall-failed" : "recall-empty",
          memoryCount,
        );
        if (config.notifications.recall) {
          deps.notify(
            runtime,
            buildRecallNotification(
              memoryCount,
              blocks.map((block) => block.bankId),
              failed,
            ),
            failed > 0 && memoryCount === 0 ? "warning" : "info",
          );
        }
        if (
          config.recall.storeLastRecall &&
          (rendered || failed === 0 || config.recall.storeLastRecallFailures)
        ) {
          try {
            await writeLastRecallSnapshot(
              runtime.cwd,
              config.recall.lastRecallPath,
              {
                query: blocks[0]?.query ?? failures[0]?.query ?? "",
                rendered,
                blocks,
                failed,
                ...(failures.length ? { failures } : {}),
              },
              runtime.signal,
            );
          } catch (error) {
            if (isAbortError(error) || runtime.signal?.aborted) throw error;
            deps.notify(
              runtime,
              `Hindsight last recall snapshot write failed: ${redactError(error)}`,
              "warning",
            );
          }
        }
        if (runtime.signal?.aborted) {
          deps.setMemoryStatus(runtime, "idle");
          return skip("aborted");
        }
        if (!rendered) {
          injection(
            failed
              ? retrievals.some((e) => e.status === "timeout")
                ? "timeout"
                : "error"
              : "empty",
          );
          return undefined;
        }
        const recallMessage = {
          role: "user",
          content: rendered,
          timestamp,
        } as AgentMessage;
        const patch =
          config.recall.injectionPosition === "append"
            ? patchWithRecallMessage(event, recallMessage)
            : { messages: [recallMessage, ...event.messages] };
        injection(patch ? "success" : "skipped", patch ? rendered : "", { failedScopes: failed });
        return patch;
      } catch (error) {
        if (isAbortError(error) || runtime.signal?.aborted) {
          deps.setMemoryStatus(runtime, "idle");
          return skip("aborted");
        }
        injection("error", "", telemetryFailure(error));
        deps.setMemoryStatus(runtime, "recall-failed");
        // Recall runs every turn, so this stays debug-gated behind the same opt-in flags that
        // already gate the last-recall sidecar, instead of notifying (which would spam normal
        // usage). Users who enabled storeLastRecall + storeLastRecallFailures can inspect the
        // redacted cause via the opt-in last-recall sidecar under the project state dir
        // (config.recall.lastRecallPath).
        if (config.recall.storeLastRecall && config.recall.storeLastRecallFailures) {
          try {
            await writeLastRecallSnapshot(runtime.cwd, config.recall.lastRecallPath, {
              query: "",
              rendered: "",
              blocks: [],
              failed: 1,
              failures: [
                {
                  bankId: "pre-scope-failure",
                  query: "",
                  error: `Unexpected recall failure: ${redactError(error)}`,
                },
              ],
            });
          } catch {
            // Best-effort debug snapshot; do not let a write failure mask the original recall failure.
          }
        }
        return undefined;
      }
    },
  };
}
