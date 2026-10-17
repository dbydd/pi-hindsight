import { HttpSystemOneProvider } from "system-one-core";
import { DEFAULT_DECISION_THRESHOLD } from "../types.js";
import { coerceBoolean } from "./backends.js";
import type { DecisionAnswers, DecisionBackend, DecisionQuestion } from "./types.js";

/**
 * System One decision backend. The decision layer speaks noul questions, which
 * is System One's native form, so this rung adds no reshaping beyond the call
 * itself: the same state and question table every other backend gets arrive
 * here unchanged.
 *
 * Transport failures throw, the same as the other rungs, so the layer's ladder
 * policy keeps working: this rung failing costs routing quality, never memory.
 */

/** Narrow view of the provider this rung calls, so tests need no fetch. */
export interface SystemOneAnswerSource {
  evaluate(
    request: {
      state: string;
      questions: Record<string, { type: "noul"; instructions: string }>;
      model?: string;
    },
    options?: { signal?: AbortSignal; model?: string },
  ): Promise<{ answers: Record<string, { type: "noul"; noul: number }> }>;
}

export interface SystemOneBackendInput {
  source: SystemOneAnswerSource;
  label: string;
  /** Sends `model` on each request when set; otherwise the provider's default stands. */
  model?: string;
}

export function createSystemOneBackend(input: SystemOneBackendInput): DecisionBackend {
  return {
    kind: "systemone",
    label: input.label,
    async answer(questions, state, options) {
      const response = await input.source.evaluate(
        {
          state,
          questions: Object.fromEntries(
            questions.map((question) => [
              question.id,
              { type: "noul" as const, instructions: question.instructions },
            ]),
          ),
          ...(input.model ? { model: input.model } : {}),
        },
        {
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
      const threshold = options.threshold ?? DEFAULT_DECISION_THRESHOLD;
      const answers: DecisionAnswers = {};
      for (const question of questions) {
        const answer = response.answers?.[question.id];
        answers[question.id] =
          answer?.noul === undefined ? undefined : coerceBoolean(answer.noul, threshold);
      }
      return answers;
    },
  };
}

export interface HttpSystemOneOptions {
  baseUrl: string;
  model?: string;
  apiKey?: string;
  timeoutMs?: number;
  /** Provider-level fetch override; used by tests and custom transports. */
  fetch?: typeof fetch;
}

/** Build the rung against the published HTTP provider, pointed at one gateway. */
export function createHttpSystemOneBackend(
  options: HttpSystemOneOptions,
  label: string,
): DecisionBackend {
  const provider = new HttpSystemOneProvider({
    baseUrl: options.baseUrl,
    ...(options.model ? { defaultModel: options.model } : {}),
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options.timeoutMs !== undefined && options.timeoutMs > 0
      ? { timeoutMs: options.timeoutMs }
      : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return createSystemOneBackend({
    source: {
      evaluate: (request, evaluateOptions) =>
        provider.evaluate(
          {
            state: request.state,
            questions: Object.fromEntries(
              Object.entries(request.questions).map(([id, question]) => [id, { ...question }]),
            ),
            ...(request.model ? { model: request.model } : {}),
          },
          evaluateOptions,
        ) as Promise<{ answers: Record<string, { type: "noul"; noul: number }> }>,
    },
    label,
  });
}

export type { DecisionAnswers, DecisionQuestion };
