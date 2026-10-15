import type { AgentEndEvent } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { projectMessages } from "../utils/messages.js";
import { enqueueRetainFromAgentEnd } from "./retain.js";
import { emitRetrieval, telemetryEvent, type RetrievalObserver } from "./retrieval-telemetry.js";
import type { DecisionLayer } from "../decision/decision.js";
import type { DecisionBankCandidate, DecisionResult } from "../decision/types.js";
import {
  advanceRetainCursor,
  filterNewRetainMessages,
  readSessionRetainState,
  retainedThroughIndex,
} from "./retain-cursor.js";
import { stableSessionId } from "../utils/session.js";
import {
  clearNextSessionRetainMode,
  getEffectiveSessionMemoryMode,
  readSessionMemoryMeta,
} from "../utils/session-memory-meta.js";
import { redactError } from "../utils/sanitize.js";
import { autoRetainEntries, bankRetainMode, isCodingBankEntry } from "../config/banks.js";
import type { BankRetainMode, HindsightLikeClient, ResolvedConfig } from "../types.js";
import type { RuntimeSnapshot } from "./memory-lifecycle-runtime.js";
import type { HindsightActivity } from "../utils/status.js";

export type RetainStatusActivity = Extract<
  HindsightActivity,
  "retaining" | "retained" | "retain-queued" | "retain-failed"
>;

export interface RetainTurnPolicy {
  retain(event: AgentEndEvent, runtime: RuntimeSnapshot): Promise<RetainTurnResult>;
}

export interface RetainTurnResult {
  queued: boolean;
  sent: number;
  remaining: number;
}

export interface RetainTurnPolicyDeps {
  observer?: RetrievalObserver;
  getConfig(): ResolvedConfig;
  getClient(): HindsightLikeClient;
  getProjectBankId(): string;
  /**
   * Decision layer for entries with `retain.mode: "decision"`. Absent means those
   * entries degrade to the configured fallback banks instead of failing the turn.
   */
  getDecisionLayer?: () => DecisionLayer | undefined;
  setMemoryStatus(
    runtime: RuntimeSnapshot,
    activity: RetainStatusActivity,
    queueRemaining?: number,
  ): void;
  notify(runtime: RuntimeSnapshot, message: string, level: "info" | "warning"): void;
}

/** One entry automatic retain may write to: the decision candidate plus its routing. */
interface RetainCandidate extends DecisionBankCandidate {
  /** Hindsight bank the entry writes to. */
  bankId: string;
  mode: BankRetainMode;
}

/** Where a retain turn writes, and why. */
interface RetainRouting {
  bankIds: string[];
  /** Retain-side routing reason; telemetry and the skip notification only. */
  reason: string;
  /** Entry ids that produced no write: unroutable, or returned but refused. */
  dropped: string[];
  /** True when the decision layer was consulted at all. */
  decided: boolean;
  /** The layer's own reason when it answered; absent when it was not consulted. */
  decisionReason?: string;
}

export function createRetainTurnPolicy(deps: RetainTurnPolicyDeps): RetainTurnPolicy {
  const retainedBySession = new Map<string, Awaited<ReturnType<typeof readSessionRetainState>>>();

  const sessionRetainState = async (runtime: RuntimeSnapshot) => {
    const sessionId = stableSessionId(runtime.sessionFile, runtime.cwd);
    const state =
      retainedBySession.get(sessionId) ?? (await readSessionRetainState(runtime.cwd, sessionId));
    retainedBySession.set(sessionId, state);
    return { sessionId, state };
  };

  const newRetainMessages = async (
    runtime: RuntimeSnapshot,
    messages: AgentEndEvent["messages"],
  ): Promise<AgentEndEvent["messages"]> => {
    const { state } = await sessionRetainState(runtime);
    return filterNewRetainMessages(messages as AgentMessage[], state) as AgentEndEvent["messages"];
  };

  const markRetainedMessages = async (
    runtime: RuntimeSnapshot,
    allMessages: AgentEndEvent["messages"],
    retainedMessages?: AgentEndEvent["messages"],
  ): Promise<void> => {
    const { sessionId } = await sessionRetainState(runtime);
    const batch = retainedMessages ?? allMessages;
    const throughIndex = retainedThroughIndex(
      allMessages as AgentMessage[],
      batch as AgentMessage[],
    );
    await advanceRetainCursor(runtime.cwd, sessionId, allMessages as AgentMessage[], throughIndex);
    retainedBySession.set(sessionId, await readSessionRetainState(runtime.cwd, sessionId));
  };

  const retainableMessages = (messages: AgentEndEvent["messages"]): Record<string, unknown>[] =>
    projectMessages(messages as AgentMessage[], deps.getConfig());

  const retainableMessageCount = (messages: AgentEndEvent["messages"]): number =>
    retainableMessages(messages).length;

  const dedupe = (ids: string[]): string[] => [...new Set(ids)];

  /** Write candidates, plus the entry ids skipped for having no resolvable bank. */
  const retainCandidates = (
    config: ResolvedConfig,
  ): { candidates: RetainCandidate[]; unresolved: string[] } => {
    const candidates: RetainCandidate[] = [];
    const unresolved: string[] = [];
    for (const entry of autoRetainEntries(config)) {
      // The coding role writes to the derived project bank; every other entry
      // needs its own `bankId`, and one without it cannot be routed anywhere.
      const bankId = isCodingBankEntry(config, entry) ? deps.getProjectBankId() : entry.bankId;
      if (!bankId) {
        unresolved.push(entry.id);
        continue;
      }
      candidates.push({
        id: entry.id,
        bankId,
        mode: bankRetainMode(config, entry),
        access: entry.access ?? "read-write",
        ...(entry.description ? { description: entry.description } : {}),
      });
    }
    return { candidates, unresolved };
  };

  /** `decision.fallback.retainBanks`, else `banksFallback`, kept to routable entries. */
  const fallbackRouting = (
    config: ResolvedConfig,
    candidates: RetainCandidate[],
    reason: string,
  ): RetainRouting => {
    const configured =
      config.decision.fallback.retainBanks.length > 0
        ? config.decision.fallback.retainBanks
        : config.banksFallback;
    const bankIds = new Map(candidates.map((candidate) => [candidate.id, candidate.bankId]));
    return {
      bankIds: dedupe(configured.flatMap((id) => bankIds.get(id) ?? [])),
      reason,
      // A configured id no candidate accepts is reported, never written.
      dropped: configured.filter((id) => !bankIds.has(id)),
      decided: true,
    };
  };

  /**
   * Where this retain turn writes.
   *
   * `retain.mode: "always"` entries are written unconditionally, `explicit-only`
   * entries never are, and `decision` entries are offered to the decision model.
   * The model is consulted only when a `decision` entry exists: an `always`-only
   * config keeps the pre-decision routing exactly, with no extra call.
   */
  const routeRetain = async (
    config: ResolvedConfig,
    messages: AgentEndEvent["messages"],
    runtime: RuntimeSnapshot,
  ): Promise<RetainRouting> => {
    const { candidates, unresolved } = retainCandidates(config);
    const always = candidates.filter((candidate) => candidate.mode === "always");
    const asked = candidates.filter((candidate) => candidate.mode === "decision");
    const alwaysBankIds = always.map((candidate) => candidate.bankId);
    if (asked.length === 0) {
      const bankIds = dedupe(alwaysBankIds);
      return {
        bankIds,
        reason: bankIds.length > 0 ? "always" : "no-bank-id",
        dropped: unresolved,
        decided: false,
      };
    }

    // Beyond this point the model decides the `decision` entries; the `always`
    // entries are unioned in, so an unreachable model cannot cost them a write.
    const degraded = (reason: string): RetainRouting => {
      const fallback = fallbackRouting(config, candidates, reason);
      return {
        ...fallback,
        bankIds: dedupe([...alwaysBankIds, ...fallback.bankIds]),
        dropped: [...new Set([...fallback.dropped, ...unresolved])],
      };
    };
    const layer = deps.getDecisionLayer?.();
    let result: DecisionResult | undefined;
    if (layer) {
      try {
        result = await layer.decide({
          messages,
          // Retain never decides recall: the read half belongs to the recall path.
          readCandidates: [],
          writeCandidates: asked.map(({ id, access, description }) => ({
            id,
            access,
            ...(description ? { description } : {}),
          })),
          ...(runtime.signal ? { signal: runtime.signal } : {}),
        });
      } catch {
        // The layer promises not to throw; a host adapter that does still degrades.
        result = undefined;
      }
    }
    if (!result) return degraded(layer ? "decision-error" : "decision-layer-unavailable");

    const picked = new Set(result.writeBanks);
    const offered = new Set(asked.map((candidate) => candidate.id));
    // Second filter, mirroring the read path: a returned id that no longer meets
    // the candidate conditions is refused and reported instead of written.
    const chosen = asked.filter((candidate) => picked.has(candidate.id));
    return {
      bankIds: dedupe([...alwaysBankIds, ...chosen.map((candidate) => candidate.bankId)]),
      reason: "decision",
      dropped: [...new Set([...result.writeBanks.filter((id) => !offered.has(id)), ...unresolved])],
      decided: true,
      ...(result.reason ? { decisionReason: result.reason } : {}),
    };
  };

  /**
   * Retain-side routing telemetry: recorded when the model was consulted, and
   * whenever nothing was written. The plain `always` path that writes keeps the
   * pre-decision behavior, its empty telemetry included, and decision's own span
   * already describes the model call, so this one adds only the write routing.
   */
  const emitRetainRouting = (started: number, routing: RetainRouting): void => {
    if (!routing.decided && routing.bankIds.length > 0) return;
    emitRetrieval(deps.observer, () =>
      telemetryEvent(started, {
        phase: "retain",
        mode: "automatic",
        cache: "none",
        status: routing.bankIds.length > 0 ? "success" : "skipped",
        reason: routing.reason,
        bankIds: routing.bankIds,
        ...(routing.decisionReason ? { decisionReason: routing.decisionReason } : {}),
        ...(routing.dropped.length > 0 ? { droppedBanks: routing.dropped } : {}),
      }),
    );
  };

  return {
    async retain(event: AgentEndEvent, runtime: RuntimeSnapshot): Promise<RetainTurnResult> {
      const config = deps.getConfig();
      // The turn needs something it could route to at all: an enabled, write-capable
      // entry that is not `explicit-only`. Which of those actually get written is
      // decided after the new-message check, so an empty turn costs no decision call.
      if (!config.enabled || !config.retain.enabled || autoRetainEntries(config).length === 0)
        return { queued: false, sent: 0, remaining: 0 };

      const sessionMeta = await readSessionMemoryMeta(runtime.cwd, runtime.sessionFile);
      const nextRetainMode = sessionMeta.nextRetainMode;
      const sessionMemory = getEffectiveSessionMemoryMode(sessionMeta);
      if (!sessionMemory.retain || nextRetainMode === "off") {
        try {
          await markRetainedMessages(runtime, event.messages);
        } catch (error) {
          deps.setMemoryStatus(runtime, "retain-failed");
          deps.notify(
            runtime,
            `Hindsight retain cursor update failed: ${(error as Error).message}`,
            "warning",
          );
          return { queued: false, sent: 0, remaining: 0 };
        }
        if (nextRetainMode === "off") {
          await clearNextSessionRetainMode(runtime.cwd, runtime.sessionFile);
          deps.notify(
            runtime,
            "Hindsight skipped retain for this run due to next-opt-out.",
            "info",
          );
        }
        return { queued: false, sent: 0, remaining: 0 };
      }

      const messages = await newRetainMessages(runtime, event.messages);
      const messageCount = retainableMessageCount(messages);
      if (!messageCount) return { queued: false, sent: 0, remaining: 0 };

      try {
        const started = Date.now();
        deps.setMemoryStatus(runtime, "retaining");
        const routing = await routeRetain(config, messages, runtime);
        const targets = routing.bankIds;
        if (targets.length === 0) {
          await markRetainedMessages(runtime, event.messages, messages);
          deps.setMemoryStatus(runtime, "retained", 0);
          emitRetainRouting(started, routing);
          if (config.notifications.retain) {
            const refused =
              routing.dropped.length > 0 ? `; refused ${routing.dropped.join(", ")}` : "";
            const note = routing.decided
              ? `retain routing chose no bank (${routing.reason}${refused})`
              : "no automatic-retain bank has a resolvable bank id";
            deps.notify(
              runtime,
              `Hindsight skipped ${messageCount} new message${messageCount === 1 ? "" : "s"}; ${note}`,
              "info",
            );
          }
          return { queued: false, sent: 0, remaining: 0 };
        }
        let sent = 0;
        let remaining = 0;
        let queued = false;
        let reflectError: string | undefined;
        for (const bankId of targets) {
          const result = await enqueueRetainFromAgentEnd({
            event: { ...event, messages },
            cwd: runtime.cwd,
            ...(runtime.sessionFile ? { sessionFile: runtime.sessionFile } : {}),
            config,
            client: deps.getClient(),
            bankId,
            extraTags: sessionMemory.tags,
          });
          queued ||= result.queued;
          sent += result.sent;
          remaining = result.remaining;
          reflectError ??= result.reflectError;
        }
        if (queued) await markRetainedMessages(runtime, event.messages, messages);
        deps.setMemoryStatus(runtime, remaining > 0 ? "retain-queued" : "retained", remaining);
        emitRetainRouting(started, routing);
        if (config.notifications.retain) {
          deps.notify(
            runtime,
            `Hindsight retained ${messageCount} new message${messageCount === 1 ? "" : "s"} to ${targets.join(", ")}${remaining > 0 ? `; ${remaining} queued` : ""}`,
            "info",
          );
        }
        // Post-retain reflect is opt-in (retain.postRetainReflect, off by default); users who
        // enable it have opted into this extra visibility, so surface failures like other
        // opt-in feature failures in this file do, without requiring notifications.retain.
        if (reflectError) {
          deps.notify(runtime, `Hindsight post-retain reflect failed: ${reflectError}`, "warning");
        }
        return { queued, sent, remaining };
      } catch (error) {
        deps.setMemoryStatus(runtime, "retain-failed");
        deps.notify(runtime, `Hindsight retain queue failed: ${redactError(error)}`, "warning");
        return { queued: false, sent: 0, remaining: 0 };
      }
    },
  };
}
