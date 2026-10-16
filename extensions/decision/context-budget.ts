/**
 * Character budget for the decision prompt, derived from the selected model.
 *
 * `decision.maxContextChars` bounds only the recent-activity section of the
 * prompt (see `context.ts`), so it is an input-side number: it has to fit the
 * model's context window, not its output budget. The host model carries
 * `contextWindow` in tokens; this module turns that into a conservative
 * character figure.
 */

/**
 * Token budget used when the model reports no context window: the whole 8k
 * window, since nothing is known about how much of a larger window exists. The
 * result is 32768 characters.
 */
export const FALLBACK_CONTEXT_TOKENS = 8192;

/** Token budget floor: never ask for less than 2k tokens of recent activity. */
const MIN_CONTEXT_TOKENS = 2048;

/** Token budget ceiling: never ask for more than 12k tokens of recent activity. */
const MAX_CONTEXT_TOKENS = 12_000;

/**
 * Conservative characters-per-token for English prose with code. Tokenizers
 * average ~4 characters per token, so the character budget is 4x the token
 * budget: the trimmer cuts before the model overflows.
 */
const CHARS_PER_TOKEN = 4;

/** The model fields the derivation reads; `undefined` when the host reports none. */
export interface ContextWindowSource {
  contextWindow?: number;
  maxTokens?: number;
}

/**
 * The `decision.maxContextChars` default for a resolved model.
 *
 * A quarter of the reported context window, clamped to 2k–12k tokens, times 4
 * characters per token. A model that reports no usable window spends the whole
 * `FALLBACK_CONTEXT_TOKENS` instead of a quarter of it, because nothing is
 * known about how large a window it actually has.
 */
export function defaultMaxContextChars(model: ContextWindowSource | undefined): number {
  // A host model reports `contextWindow` as a number or `null`; anything else is
  // unusable, and the fallback keeps the budget conservative.
  const reported = model?.contextWindow;
  const usable =
    typeof reported === "number" && Number.isFinite(reported) && reported > 0
      ? reported
      : undefined;
  const tokens =
    usable === undefined
      ? FALLBACK_CONTEXT_TOKENS
      : Math.round(Math.min(Math.max(usable / 4, MIN_CONTEXT_TOKENS), MAX_CONTEXT_TOKENS));
  return tokens * CHARS_PER_TOKEN;
}
