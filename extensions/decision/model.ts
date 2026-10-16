import { emitDecision } from "./telemetry.js";
import type { RetrievalObserver } from "../lifecycle/retrieval-telemetry.js";
import type { DecisionBackend, DecisionHost, DecisionModelRef } from "./types.js";

/**
 * Model resolution for `decision.model`.
 *
 * Two spec shapes are supported. `role:<name>` is the role table a host may or
 * may not have; a host without one (pi) skips that level with a telemetry span
 * and uses its session model, so the default config still decides instead of
 * failing every turn. `<provider>/<modelId>` is available on every host.
 *
 * Role resolution is async on hosts that load their role table from host
 * modules, so this resolves a promise; every caller already runs async.
 */

const ROLE_PREFIX = "role:";

export type DecisionModelSpec =
  | { kind: "role"; name: string }
  | { kind: "model"; ref: DecisionModelRef };

export function parseDecisionModelSpec(spec: string): DecisionModelSpec | undefined {
  const trimmed = spec.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith(ROLE_PREFIX)) {
    const name = trimmed.slice(ROLE_PREFIX.length).trim();
    return name ? { kind: "role", name } : undefined;
  }
  const separator = trimmed.indexOf("/");
  if (separator <= 0) return undefined;
  const provider = trimmed.slice(0, separator).trim();
  const modelId = trimmed.slice(separator + 1).trim();
  if (!provider || !modelId) return undefined;
  return { kind: "model", ref: { provider, modelId } };
}

/** Which level produced the ref: the role table, the session model, or the spec itself. */
export type DecisionModelSource = "role" | "session" | "model";

export interface ResolvedDecisionModel {
  ref: DecisionModelRef;
  /** Ordered ladder for the ref; the caller tries rungs in order. */
  backends: DecisionBackend[];
  source: DecisionModelSource;
  /**
   * The resolved model's context window in tokens, when the host reports one.
   * The caller derives its prompt budget from it; `undefined` means the host
   * carries no usable figure and the fallback applies.
   */
  contextWindow?: number;
}

export interface ResolveDecisionModelInput {
  spec: string;
  host: DecisionHost;
  /** Telemetry sink; `undefined` is explicit so callers can pass an optional one through. */
  observer?: RetrievalObserver | undefined;
  started?: number;
}

/** Resolve the configured model to a ladder, or undefined when no rung is available. */
export async function resolveDecisionModel(
  input: ResolveDecisionModelInput,
): Promise<ResolvedDecisionModel | undefined> {
  const started = input.started ?? Date.now();
  const observer = input.observer;
  const parsed = parseDecisionModelSpec(input.spec);
  if (!parsed) {
    emitDecision(observer, started, {
      status: "skipped",
      reason: "invalid-model-spec",
      ladder: [],
    });
    return undefined;
  }

  let ref: DecisionModelRef | undefined;
  let source: DecisionModelSource;
  if (parsed.kind === "role") {
    source = "role";
    if (input.host.roles) {
      ref = await input.host.resolveRole(parsed.name);
      if (!ref)
        emitDecision(observer, started, {
          status: "skipped",
          reason: "role-unresolved",
          model: parsed.name,
        });
    } else {
      // Role-less host: this level is skipped, never an error.
      emitDecision(observer, started, {
        status: "skipped",
        reason: "role-unsupported",
        model: parsed.name,
      });
    }
    if (!ref) {
      ref = input.host.sessionModel?.();
      source = "session";
    }
  } else {
    ref = parsed.ref;
    source = "model";
  }

  if (!ref) {
    emitDecision(observer, started, { status: "skipped", reason: "no-model" });
    return undefined;
  }
  const model = `${ref.provider}/${ref.modelId}`;
  const backends = safeBackends(input.host, ref);
  if (backends.length === 0) {
    emitDecision(observer, started, { status: "skipped", reason: "no-backend", model });
    return undefined;
  }
  const window = contextWindow(input.host, ref);
  return { ref, backends, source, ...(window === undefined ? {} : { contextWindow: window }) };
}

/**
 * The resolved model's context window, read through the host registry. Both
 * hosts keep it on the catalogued model (`contextWindow`), and a host that
 * reports none simply leaves it unset so the caller falls back.
 */
function contextWindow(host: DecisionHost, ref: DecisionModelRef): number | undefined {
  const reported = host.modelContextWindow?.(ref);
  return typeof reported === "number" && Number.isFinite(reported) && reported > 0
    ? reported
    : undefined;
}

function safeBackends(host: DecisionHost, ref: DecisionModelRef): DecisionBackend[] {
  try {
    return host.backends(ref);
  } catch {
    // A host that cannot build a ladder for this ref simply has no rung.
    return [];
  }
}
