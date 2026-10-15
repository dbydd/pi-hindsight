import { coerceBoolean } from "./backends.js";
import { isRecord } from "../config/is-record.js";
import { DecisionAnswerError } from "./errors.js";
import type { DecisionAnswers, DecisionBackend, DecisionQuestion } from "./types.js";

/**
 * The text bridge: any chat model that completes text can answer the question
 * table when the host has no typed judgment surface for it. Strict JSON is
 * required rather than keyword sniffing, so a chatty reply is a parse failure
 * (retried, then a rung failure) instead of a silent wrong answer.
 */

/** Format-correction attempts after a reply cannot be parsed. */
export const TEXT_BRIDGE_PARSE_RETRIES = 2;

/** Fallback budget for transports that cannot carry a per-call token cap. */
const DEFAULT_MAX_TOKENS = 512;

export interface TextCompleteInput {
  system: string;
  user: string;
  retry?: boolean;
  signal?: AbortSignal;
  maxTokens: number;
}

/** Completes one rendered prompt; throws on transport failure. */
export type TextCompletePort = (input: TextCompleteInput) => Promise<string>;

/** omp `TextBackend` shape, so omp's `TextJudge` can drive our completion port. */
export interface TextBackendLike {
  readonly api: string;
  readonly provider: string;
  readonly model: string;
  readonly parseRetries?: number;
  complete(
    prompt: { system: string; user: string; retry?: boolean },
    options?: { signal?: AbortSignal; maxTokens?: number },
  ): Promise<{ text: string }>;
}

const SYSTEM_PROMPT = [
  "You answer a fixed table of yes/no questions about one coding session.",
  'Reply with a single JSON object and nothing else: {"answers": {"<question-id>": true, "<question-id>": false}}.',
  "Every question id must appear exactly once, with true for yes and false for no. No prose, no markdown fences.",
].join("\n");

const RETRY_PROMPT = `${SYSTEM_PROMPT}\nYour previous reply was not a JSON object answering every question id. Reply again with strict JSON only.`;

export function renderTextPrompt(
  questions: readonly DecisionQuestion[],
  state: string,
  retry = false,
): { system: string; user: string } {
  const rows = questions.map((question) => `${question.id}: ${question.instructions}`);
  return {
    system: retry ? RETRY_PROMPT : SYSTEM_PROMPT,
    user: `# State\n${state}\n# Questions\n${rows.join("\n")}`,
  };
}

/** Parse a reply into one answer per id; undefined when any id is unreadable. */
export function parseTextAnswers(
  text: string,
  ids: readonly string[],
): DecisionAnswers | undefined {
  const payload = extractJsonObject(text);
  if (!payload) return undefined;
  const source = isRecord(payload.answers) ? payload.answers : payload;
  const answers: DecisionAnswers = {};
  for (const id of ids) {
    const value = coerceBoolean(source[id]);
    if (value === undefined) return undefined;
    answers[id] = value;
  }
  return answers;
}

export function createTextBridgeBackend(
  port: TextCompletePort,
  meta: { label: string; parseRetries?: number },
): DecisionBackend {
  const parseRetries = meta.parseRetries ?? TEXT_BRIDGE_PARSE_RETRIES;
  return {
    kind: "text",
    label: meta.label,
    async answer(questions, state, options) {
      const ids = questions.map((question) => question.id);
      let lastReply = "";
      for (let attempt = 0; attempt <= parseRetries; attempt++) {
        const prompt = renderTextPrompt(questions, state, attempt > 0);
        lastReply = await port({
          ...prompt,
          maxTokens: options.maxTokens,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        const answers = parseTextAnswers(lastReply, ids);
        if (answers) return answers;
      }
      throw new DecisionAnswerError(
        `text bridge reply did not answer every question: ${truncate(lastReply)}`,
      );
    },
  };
}

/** Wrap the same completion port as an omp `TextBackend` for omp's `TextJudge`. */
export function createTextBackendAdapter(
  port: TextCompletePort,
  meta: { api: string; provider: string; model: string; parseRetries?: number },
): TextBackendLike {
  return {
    api: meta.api,
    provider: meta.provider,
    model: meta.model,
    parseRetries: meta.parseRetries ?? TEXT_BRIDGE_PARSE_RETRIES,
    complete(prompt, options) {
      return port({
        system: prompt.system,
        user: prompt.user,
        maxTokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(prompt.retry ? { retry: true } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
      }).then((text) => ({ text }));
    },
  };
}

/** Parse a JSON object out of a reply, tolerating fences and surrounding prose. */
function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?/u, "")
    .replace(/```$/u, "")
    .trim();
  for (const candidate of [trimmed, unfenced]) {
    const parsed = tryParseJson(candidate);
    if (parsed) return parsed;
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  return tryParseJson(trimmed.slice(start, end + 1));
}

function tryParseJson(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function truncate(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
}
