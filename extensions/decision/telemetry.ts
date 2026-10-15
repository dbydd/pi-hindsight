import { redactError } from "../utils/sanitize.js";
import {
  emitRetrieval,
  telemetryEvent,
  type RetrievalObserver,
  type RetrievalTelemetry,
} from "../lifecycle/retrieval-telemetry.js";
import { DecisionTimeoutError } from "./errors.js";

/**
 * Decision telemetry rides the existing retrieval-telemetry shape (`phase:
 * "decision"`), so one observer sees recall, injection, and decision spans and
 * exporter failures stay contained by `emitRetrieval`.
 */
export interface DecisionEventFields {
  status: RetrievalTelemetry["status"];
  /** Diagnostics: an explicit undefined is allowed so callers can pass optional values through. */
  cache?: RetrievalTelemetry["cache"] | undefined;
  /** Why this result: a fallback reason, or a special-case skip. */
  reason?: string | undefined;
  /** Resolved model, `provider/modelId`. */
  model?: string | undefined;
  /** Rung that answered or failed, `kind/label`. */
  backend?: string | undefined;
  /** Every rung of the ladder, in order. */
  ladder?: string[] | undefined;
  /** 1-based rung index, set for per-rung events. */
  attempt?: number | undefined;
  inject?: boolean | undefined;
  readBanks?: string[] | undefined;
  writeBanks?: string[] | undefined;
  /** Ids a backend named that were not offered (or are no longer eligible). */
  droppedBanks?: string[] | undefined;
}

export function emitDecision(
  observer: RetrievalObserver | undefined,
  started: number,
  fields: DecisionEventFields,
): void {
  emitRetrieval(observer, () =>
    telemetryEvent(started, {
      phase: "decision",
      mode: "automatic",
      cache: fields.cache ?? "none",
      ...definedFields(fields),
    }),
  );
}

/** Status plus redacted cause for a failed rung. */
export function decisionFailure(error: unknown): { status: "timeout" | "error"; error: string } {
  return {
    status: error instanceof DecisionTimeoutError ? "timeout" : "error",
    error: redactError(error),
  };
}

/** Drop undefined values so `exactOptionalPropertyTypes` never sees an explicit undefined. */
function definedFields(fields: DecisionEventFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
