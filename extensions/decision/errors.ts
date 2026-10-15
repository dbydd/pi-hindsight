/**
 * Failures the decision ladder classifies. Both are expected — a rung that
 * times out or answers nothing moves to the next rung, and the ladder ends at
 * the configured fallback routing instead of breaking the calling turn.
 */

/** A rung exceeded `decision.timeoutMs`. */
export class DecisionTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`decision model timed out after ${timeoutMs}ms`);
    this.name = "DecisionTimeoutError";
  }
}

/** A backend answered, but not every required question was answered. */
export class DecisionAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecisionAnswerError";
  }
}
