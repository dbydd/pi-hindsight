import type { BankAccess } from "../types.js";

/**
 * Narrow types for the decision layer.
 *
 * The layer answers two questions with one model call: whether this turn injects
 * recall, and which banks receive the read/write routing. Everything the layer
 * needs from a host is a port declared here, so the module never imports a host
 * package for control flow and every port stays replaceable in tests.
 */

/** A concrete provider/model pair a decision model resolves to. */
export interface DecisionModelRef {
  provider: string;
  modelId: string;
}

/** Which rung of the backend ladder produced an answer; telemetry and diagnostics only. */
export type DecisionBackendKind = "native-judge" | "classifier" | "text";

/** One boolean question. The id is the answer key the backend must echo back. */
export interface DecisionQuestion {
  id: string;
  /** A yes/no statement the backend evaluates against the rendered state. */
  instructions: string;
}

/** Answers keyed by question id. A missing key means the backend did not answer that question. */
export type DecisionAnswers = Record<string, boolean | undefined>;

export interface DecisionBackendOptions {
  signal?: AbortSignal;
  /**
   * Output budget. Omitted (or `<= 0`) means the backend keeps its own cap —
   * `decision.maxTokens <= 0` in config, which is the "no ceiling" setting.
   */
  maxTokens?: number;
  /**
   * Probability at or above which a numeric answer counts as "yes" —
   * `decision.threshold`, threaded so every backend coerces at the same point.
   */
  threshold?: number;
}

/**
 * The one interface all four backends implement: state plus a question table in,
 * one answer per question id out. Transport failures throw; an unanswered
 * question is reported as a missing key rather than a throw.
 */
export interface DecisionBackend {
  readonly kind: DecisionBackendKind;
  /** Backend description for logs and telemetry, e.g. `typesafe/jev-latest`. */
  readonly label: string;
  answer(
    questions: readonly DecisionQuestion[],
    state: string,
    options: DecisionBackendOptions,
  ): Promise<DecisionAnswers>;
}

/** One bank the model may route to. Only eligible (enabled + access-compatible) banks are offered. */
export interface DecisionBankCandidate {
  id: string;
  access: BankAccess;
  /** Shown to the model so it can judge what the bank holds. */
  description?: string;
}

/** The transcript fields the context builder and the cache key read. */
export interface DecisionMessage {
  role?: string;
  content?: unknown;
  timestamp?: number;
}

/** What the work is, how its result is measured, and how far it must go to count as done. */
export interface TodoGoal {
  objective: string;
  measure?: string;
  doneWhen?: string;
}

/** One open task, as projected from a host todo surface. */
export interface TodoOpenItem {
  phase?: string;
  title: string;
  explanation?: string | null;
}

/**
 * Task state for the decision prompt. `unknown` means the reader could not read
 * the host's todo state — never "the list is empty", which is `kind: "ok"` with
 * no open items.
 */
export type TodoState =
  | { kind: "ok"; goal: TodoGoal | null; openItems: TodoOpenItem[] }
  | { kind: "unknown" };

export interface DecisionRequest {
  messages: readonly DecisionMessage[];
  /** Enabled + read-capable (or read-write) bank entries. */
  readCandidates: readonly DecisionBankCandidate[];
  /** Enabled + write-capable (or read-write) bank entries. */
  writeCandidates: readonly DecisionBankCandidate[];
  /** Pre-read task state; falls back to the layer's own reader. */
  todo?: TodoState;
  signal?: AbortSignal;
}

export interface DecisionResult {
  /**
   * Whether automatic recall should inject this turn. Only meaningful when the
   * request offered read candidates: a write-only call is never asked the inject
   * gate, and reports `false` because no read gate was decided.
   */
  inject: boolean;
  /** Bank ids selected for the read (recall) path, in candidate order. */
  readBanks: string[];
  /** Bank ids selected for the write (retain) path, in candidate order. */
  writeBanks: string[];
  /** Why this result was produced: the winning backend label, or a fallback reason. */
  reason?: string;
}

/** TTL result cache; injectable so tests control time and reuse. */
export interface DecisionCache {
  get(key: string): DecisionResult | undefined;
  set(key: string, result: DecisionResult): void;
}

export type HostKind = "omp" | "pi" | "unknown";

/**
 * A host adapter resolves the configured model and offers the backend ladder for
 * it. Building the ladder is host-specific; trying rungs in order is not.
 */
export interface DecisionHost {
  readonly kind: HostKind;
  /** True when the host resolves role aliases (`role:<name>`); false on role-less hosts. */
  readonly roles: boolean;
  /**
   * Resolve a role name to a model ref. Only consulted when `roles` is true.
   * Async on hosts whose role resolution loads host modules (omp); synchronous
   * hosts and the degraded host answer directly.
   */
  resolveRole(name: string): DecisionModelRef | undefined | Promise<DecisionModelRef | undefined>;
  /**
   * The host's current session model. A role-less host uses it when a `role:`
   * spec cannot be resolved, so the default config still yields a model.
   */
  sessionModel?(): DecisionModelRef | undefined;
  /**
   * The resolved model's context window in tokens, or `undefined` when the host
   * reports none. The decision layer derives its prompt budget from it, so a
   * host that cannot answer costs budget size, never the turn.
   */
  modelContextWindow?(ref: DecisionModelRef): number | undefined;
  /** Ordered ladder for a ref: first rung that answers wins, later rungs cover failures. */
  backends(ref: DecisionModelRef): DecisionBackend[];
}
