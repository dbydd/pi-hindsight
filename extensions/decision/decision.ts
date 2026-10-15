import { bankEntryEnabled, bankEntryFor, canReadBank, canWriteBank } from "../config/banks.js";
import { recallTurnCacheKey } from "../lifecycle/memory-lifecycle-recall.js";
import type { RetrievalObserver } from "../lifecycle/retrieval-telemetry.js";
import type { BankConfigEntry, ResolvedConfig } from "../types.js";
import { createDecisionCache } from "./cache.js";
import { buildDecisionState } from "./context.js";
import { DecisionAnswerError, DecisionTimeoutError } from "./errors.js";
import { resolveDecisionModel } from "./model.js";
import { decisionFailure, emitDecision } from "./telemetry.js";
import { UNKNOWN_TODO } from "./todo-state.js";
import type {
  DecisionAnswers,
  DecisionBankCandidate,
  DecisionCache,
  DecisionHost,
  DecisionQuestion,
  DecisionRequest,
  DecisionResult,
  TodoState,
} from "./types.js";

/**
 * The decision layer: one model call decides whether this turn injects recall
 * and which banks take the read and write routing.
 *
 * Failure policy is the whole point of the shape below. Every rung may fail, the
 * ladder ends at the configured fallback banks, and no path throws into the
 * caller or returns "inject nothing" because a model was unreachable: a broken
 * decision model must cost routing quality, never memory itself.
 */

/** Gate A: whether automatic recall injects this turn. */
export const INJECT_QUESTION_ID = "inject";
/** Gate B prefixes; the bank id is appended. */
export const READ_QUESTION_PREFIX = "read:";
export const WRITE_QUESTION_PREFIX = "write:";

export interface DecisionLayerDeps {
  host: DecisionHost;
  getConfig(): ResolvedConfig;
  observer?: RetrievalObserver;
  /** Result cache; defaults to a TTL cache over `decision.cacheTtlMs`. */
  cache?: DecisionCache;
  now?: () => number;
  /** Task-state reader; a throw or a missing reader yields `unknown`. */
  readTodo?(): TodoState | Promise<TodoState>;
}

export interface DecisionLayer {
  decide(request: DecisionRequest): Promise<DecisionResult>;
}

export function createDecisionLayer(deps: DecisionLayerDeps): DecisionLayer {
  const now = deps.now ?? Date.now;
  const cache = deps.cache ?? createDecisionCache(() => deps.getConfig().decision.cacheTtlMs, now);

  return {
    async decide(request: DecisionRequest): Promise<DecisionResult> {
      const started = now();
      const config = deps.getConfig();
      const settings = config.decision;
      const fallback = (reason: string, status: "skipped" | "error" | "timeout" = "skipped") =>
        fallbackDecision({ config, reason, status, observer: deps.observer, started });

      if (!config.enabled || !settings.enabled) return fallback("disabled");
      if (request.signal?.aborted) return fallback("aborted");

      const questions = buildQuestions(request.readCandidates, request.writeCandidates);
      if (questions.length === 0) {
        emitDecision(deps.observer, started, {
          status: "skipped",
          reason: "no-candidates",
          ladder: [],
        });
        return { inject: false, readBanks: [], writeBanks: [], reason: "no-candidates" };
      }

      // Key shape follows the recall cache: offered bank ids plus the newest user
      // message content, so an auto-continue retry reuses this decision. Ids carry
      // their direction, because the recall call (read candidates) and the retain
      // call (write candidates) of one turn can offer the same ids with different
      // question tables and must not share a cached result.
      const cacheKey = recallTurnCacheKey(
        [
          ...request.readCandidates.map((candidate) => `read:${candidate.id}`),
          ...request.writeCandidates.map((candidate) => `write:${candidate.id}`),
        ],
        request.messages,
      );
      const cached = cache.get(cacheKey);
      if (cached) {
        emitDecision(deps.observer, started, {
          status: "success",
          cache: "hit",
          reason: cached.reason,
          inject: cached.inject,
          readBanks: cached.readBanks,
          writeBanks: cached.writeBanks,
          ladder: [],
        });
        return cached;
      }

      const state = buildDecisionState({
        messages: request.messages,
        todo: request.todo ?? (await readTodoState(deps)),
        readCandidates: request.readCandidates,
        writeCandidates: request.writeCandidates,
        maxContextChars: settings.maxContextChars,
      });

      const resolved = resolveDecisionModel({
        spec: settings.model,
        host: deps.host,
        observer: deps.observer,
        started,
      });
      if (!resolved) return fallback("no-model");
      const model = `${resolved.ref.provider}/${resolved.ref.modelId}`;
      const ladder = resolved.backends.map((rung) => `${rung.kind}/${rung.label}`);

      for (let index = 0; index < resolved.backends.length; index++) {
        const backend = resolved.backends[index]!;
        try {
          const answers = await withTimeout(
            (signal) => backend.answer(questions, state, { signal, maxTokens: settings.maxTokens }),
            settings.timeoutMs,
            request.signal,
          );
          const interpreted = interpretAnswers(answers, request, config, backend.label);
          emitDecision(deps.observer, started, {
            status: "success",
            cache: "miss",
            model,
            backend: backend.label,
            ladder,
            attempt: index + 1,
            inject: interpreted.result.inject,
            readBanks: interpreted.result.readBanks,
            writeBanks: interpreted.result.writeBanks,
            reason: interpreted.result.reason,
            ...(interpreted.droppedBanks.length > 0
              ? { droppedBanks: interpreted.droppedBanks }
              : {}),
          });
          cache.set(cacheKey, interpreted.result);
          return interpreted.result;
        } catch (error) {
          if (request.signal?.aborted) return fallback("aborted");
          emitDecision(deps.observer, started, {
            ...decisionFailure(error),
            model,
            backend: backend.label,
            ladder,
            attempt: index + 1,
          });
        }
      }

      return fallback("backends-failed", "error");
    },
  };
}

/** One question per decision: gate A, then gate B for every offered bank. */
function buildQuestions(
  readCandidates: readonly DecisionBankCandidate[],
  writeCandidates: readonly DecisionBankCandidate[],
): DecisionQuestion[] {
  const questions: DecisionQuestion[] = [];
  if (readCandidates.length > 0) {
    questions.push({
      id: INJECT_QUESTION_ID,
      instructions: "This turn must inject automatic memory recall before the answer is generated.",
    });
  }
  for (const candidate of readCandidates) {
    questions.push({
      id: `${READ_QUESTION_PREFIX}${candidate.id}`,
      instructions: `Automatic recall should read bank "${candidate.id}" for this turn.`,
    });
  }
  for (const candidate of writeCandidates) {
    questions.push({
      id: `${WRITE_QUESTION_PREFIX}${candidate.id}`,
      instructions: `Retaining this turn's memory should write to bank "${candidate.id}".`,
    });
  }
  return questions;
}

/**
 * Turn answers into a result. When read candidates were offered, gate A must be
 * answered — a backend that skips it is a failed rung, not a silent "no recall".
 * A write-only call (retain routing) is never asked gate A, so nothing is
 * required of it and `inject` stays false: no read gate was decided. Bank answers
 * run through the second filter here: anything the prompt did not offer, or
 * offered for a bank that is no longer enabled and access-compatible, is dropped
 * and reported.
 */
function interpretAnswers(
  answers: DecisionAnswers,
  request: DecisionRequest,
  config: ResolvedConfig,
  backendLabel: string,
): { result: DecisionResult; droppedBanks: string[] } {
  const askedInject = request.readCandidates.length > 0;
  if (askedInject && answers[INJECT_QUESTION_ID] === undefined) {
    throw new DecisionAnswerError(`backend "${backendLabel}" did not answer the inject gate`);
  }
  const inject = askedInject && answers[INJECT_QUESTION_ID] === true;
  const read = pickBanks({
    prefix: READ_QUESTION_PREFIX,
    answers,
    candidates: request.readCandidates,
    allowed: canReadBank,
    config,
  });
  const write = pickBanks({
    prefix: WRITE_QUESTION_PREFIX,
    answers,
    candidates: request.writeCandidates,
    allowed: canWriteBank,
    config,
  });
  return {
    result: {
      inject,
      // Gate A off means nothing is read this turn, whatever the bank answers said.
      readBanks: inject ? read.ids : [],
      writeBanks: write.ids,
      reason: backendLabel,
    },
    droppedBanks: [...new Set([...read.dropped, ...write.dropped])],
  };
}

function pickBanks(input: {
  prefix: string;
  answers: DecisionAnswers;
  candidates: readonly DecisionBankCandidate[];
  allowed: (entry: BankConfigEntry) => boolean;
  config: ResolvedConfig;
}): { ids: string[]; dropped: string[] } {
  const ids: string[] = [];
  const dropped: string[] = [];
  const offered = new Set(input.candidates.map((candidate) => candidate.id));
  for (const candidate of input.candidates) {
    const entry = bankEntryFor(input.config, candidate.id);
    if (!entry || !bankEntryEnabled(entry) || !input.allowed(entry)) {
      dropped.push(candidate.id);
      continue;
    }
    if (input.answers[`${input.prefix}${candidate.id}`] === true) ids.push(candidate.id);
  }
  for (const key of Object.keys(input.answers)) {
    if (!key.startsWith(input.prefix)) continue;
    const id = key.slice(input.prefix.length);
    if (!offered.has(id)) dropped.push(id);
  }
  return { ids, dropped };
}

/** Safe default when the model cannot decide: keep recall on, route to the fallback banks. */
function fallbackDecision(input: {
  config: ResolvedConfig;
  reason: string;
  status: "skipped" | "error" | "timeout";
  observer?: RetrievalObserver | undefined;
  started: number;
}): DecisionResult {
  const result: DecisionResult = {
    inject: true,
    readBanks: fallbackBanks(input.config, "recall"),
    writeBanks: fallbackBanks(input.config, "retain"),
    reason: input.reason,
  };
  emitDecision(input.observer, input.started, {
    status: input.status,
    reason: input.reason,
    inject: result.inject,
    readBanks: result.readBanks,
    writeBanks: result.writeBanks,
  });
  return result;
}

/** `decision.fallback.*` when configured, else `banksFallback`, filtered to eligible entries. */
function fallbackBanks(config: ResolvedConfig, path: "recall" | "retain"): string[] {
  const configured =
    path === "recall" ? config.decision.fallback.recallBanks : config.decision.fallback.retainBanks;
  const allowed = path === "recall" ? canReadBank : canWriteBank;
  const ids = configured.length > 0 ? configured : config.banksFallback;
  return ids.filter((id) => {
    const entry = bankEntryFor(config, id);
    return Boolean(entry && bankEntryEnabled(entry) && allowed(entry));
  });
}

async function readTodoState(deps: DecisionLayerDeps): Promise<TodoState> {
  if (!deps.readTodo) return UNKNOWN_TODO;
  try {
    return (await deps.readTodo()) ?? UNKNOWN_TODO;
  } catch {
    // An unreadable task state is `unknown`, and the prompt says exactly that.
    return UNKNOWN_TODO;
  }
}

/**
 * Race one rung against `decision.timeoutMs` and the caller's signal, so a
 * backend that ignores its signal still cannot hold the turn open.
 */
async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<T> {
  const abortReason = () => signal?.reason ?? new Error("decision aborted");
  if (signal?.aborted) throw abortReason();
  const controller = new AbortController();
  let rejectRace: ((error: unknown) => void) | undefined;
  const fail = (error: unknown) => {
    controller.abort(error);
    rejectRace?.(error);
  };
  const timer = setTimeout(() => fail(new DecisionTimeoutError(timeoutMs)), timeoutMs);
  const onAbort = () => fail(abortReason());
  signal?.addEventListener("abort", onAbort, { once: true });
  const race = new Promise<never>((_settle, reject) => {
    rejectRace = reject;
  });
  try {
    return await Promise.race([run(controller.signal), race]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
