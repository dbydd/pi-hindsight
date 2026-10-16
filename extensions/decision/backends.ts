import { isRecord } from "../config/is-record.js";
import type {
  DecisionAnswers,
  DecisionBackend,
  DecisionBackendKind,
  DecisionQuestion,
} from "./types.js";

/**
 * Backend wrappers for the host-native typed surfaces. Both take a narrow port,
 * so the mapping from our question table to a host's dialect stays testable
 * without a host.
 */

/** Structural view of an omp `Judge` — a native judgment api or its text judge. */
export interface JudgePortRequest {
  state: string;
  questions: Record<string, { type: "noul"; instructions: string }>;
}

export interface JudgePortOptions {
  signal?: AbortSignal;
  /** Honored by our text transport; a native judgment api keeps its own budget. */
  maxTokens?: number;
}

export interface JudgePort {
  judge(
    request: JudgePortRequest,
    options?: JudgePortOptions,
  ): Promise<{ answers: Record<string, unknown> }>;
}

/** Rungs that answer a typed question table: omp's native judge and omp's text judge. */
export function createJudgeBackend(input: {
  judge: JudgePort;
  kind: DecisionBackendKind;
  label: string;
}): DecisionBackend {
  return {
    kind: input.kind,
    label: input.label,
    async answer(questions, state, options) {
      const request: JudgePortRequest = {
        state,
        questions: Object.fromEntries(
          questions.map((question) => [
            question.id,
            { type: "noul" as const, instructions: question.instructions },
          ]),
        ),
      };
      const result = await input.judge.judge(request, {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.maxTokens !== undefined && options.maxTokens > 0
          ? { maxTokens: options.maxTokens }
          : {}),
      });
      return collectAnswers(questions, result?.answers);
    },
  };
}

export interface ClassifierPortInput {
  state: string;
  questions: { id: string; instructions: string }[];
  /** Omitted means the classifier keeps its own output cap. */
  maxTokens?: number;
  signal?: AbortSignal;
}

/** Structural view of the pi classifier surface (`ModelRegistry.classify`). */
export type ClassifierPort = (input: ClassifierPortInput) => Promise<unknown>;

export function createClassifierBackend(input: {
  classify: ClassifierPort;
  label: string;
}): DecisionBackend {
  return {
    kind: "classifier",
    label: input.label,
    async answer(questions, state, options) {
      const raw = await input.classify({
        state,
        questions: questions.map((question) => ({
          id: question.id,
          instructions: question.instructions,
        })),
        ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const answers = isRecord(raw) && isRecord(raw.answers) ? raw.answers : raw;
      return isRecord(answers) ? collectAnswers(questions, answers) : {};
    },
  };
}

/** Map raw answers onto the question ids; an unanswered id stays undefined. */
function collectAnswers(questions: readonly DecisionQuestion[], raw: unknown): DecisionAnswers {
  const source = isRecord(raw) ? raw : {};
  const answers: DecisionAnswers = {};
  for (const question of questions) answers[question.id] = coerceBoolean(source[question.id]);
  return answers;
}

/** Object shapes an answer may arrive in; order picks the most explicit field first. */
const ANSWER_KEYS = ["answer", "value", "bool", "noul", "probability", "choice", "result"];

/** Word and digit forms a text backend may answer with. */
const BOOL_TOKENS: Record<string, boolean> = {
  true: true,
  yes: true,
  y: true,
  "1": true,
  false: false,
  no: false,
  n: false,
  "0": false,
};

/**
 * Tolerant boolean coercion. A judgment api answers a `noul` question with a
 * probability, a classifier with a typed answer object, and a text bridge with
 * a JSON boolean; all three land here, and anything unreadable stays undefined so
 * the rung reports a missing answer instead of guessing.
 */
export function coerceBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value >= 0.5 : undefined;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    return Object.hasOwn(BOOL_TOKENS, text) ? BOOL_TOKENS[text] : undefined;
  }
  if (isRecord(value)) {
    for (const key of ANSWER_KEYS) {
      if (!(key in value)) continue;
      const coerced = coerceBoolean(value[key]);
      if (coerced !== undefined) return coerced;
    }
  }
  return undefined;
}
