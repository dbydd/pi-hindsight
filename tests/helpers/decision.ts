import { DEFAULT_CONFIG } from "../../extensions/config/config-defaults.js";
import { normalizeConfig, isRecord } from "../../extensions/config/config-normalize.js";
import type {
  RetrievalObserver,
  RetrievalTelemetry,
} from "../../extensions/lifecycle/retrieval-telemetry.js";
import type {
  DecisionBackend,
  DecisionBackendKind,
  DecisionHost,
  DecisionQuestion,
} from "../../extensions/decision/types.js";
import type { ResolvedConfig } from "../../extensions/types.js";

/** Normalized config with `decision`/`banks` overrides, resolved against real entries. */
export function decisionConfig(
  input: { banks?: unknown; decision?: unknown } = {},
): ResolvedConfig {
  const decision = {
    ...DEFAULT_CONFIG.decision,
    ...(isRecord(input.decision) ? input.decision : {}),
  };
  const raw = { banks: input.banks ?? DEFAULT_CONFIG.banks, decision };
  return normalizeConfig({ ...DEFAULT_CONFIG, banks: raw.banks, decision } as ResolvedConfig, raw);
}

/** Backend that answers from a fixed table and records every call. */
export interface RecordingBackend extends DecisionBackend {
  calls: number;
  lastState?: string;
  lastQuestions: string[];
}

export function recordingBackend(
  answers:
    | Record<string, boolean | undefined>
    | ((questions: readonly DecisionQuestion[]) => Record<string, boolean | undefined>),
  meta: { kind?: DecisionBackendKind; label?: string } = {},
): RecordingBackend {
  const backend: RecordingBackend = {
    kind: meta.kind ?? "text",
    label: meta.label ?? "test-backend",
    calls: 0,
    lastQuestions: [],
    async answer(questions, state) {
      backend.calls += 1;
      backend.lastState = state;
      backend.lastQuestions = questions.map((question) => question.id);
      return typeof answers === "function" ? answers(questions) : { ...answers };
    },
  };
  return backend;
}

/** Backend that never settles, for timeout coverage. */
export function hangingBackend(): DecisionBackend {
  return {
    kind: "text",
    label: "hanging",
    answer: () => new Promise(() => {}),
  };
}

export function fakeHost(overrides: Partial<DecisionHost> = {}): DecisionHost {
  return {
    kind: "pi",
    roles: false,
    resolveRole: async () => undefined,
    backends: () => [],
    ...overrides,
  };
}

export interface CollectedEvents {
  events: RetrievalTelemetry[];
  observer: RetrievalObserver;
  decisionEvents: RetrievalTelemetry[];
}

export function collectEvents(): CollectedEvents {
  const collected: CollectedEvents = {
    events: [],
    decisionEvents: [],
    observer: (event) => {
      collected.events.push(event);
      if (event.phase === "decision") collected.decisionEvents.push(event);
    },
  };
  return collected;
}
