import type { DecisionCache, DecisionMessage, DecisionResult } from "./types.js";

/** TTL result cache. `now` is injectable so tests control expiry. */
export function createDecisionCache(
  ttlMs: number | (() => number),
  now: () => number = Date.now,
): DecisionCache {
  const entries = new Map<string, { result: DecisionResult; timestamp: number }>();
  const ttl = () => (typeof ttlMs === "function" ? ttlMs() : ttlMs);
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (now() - entry.timestamp > ttl()) {
        entries.delete(key);
        return undefined;
      }
      return entry.result;
    },
    set(key, result) {
      entries.set(key, { result, timestamp: now() });
    },
  };
}

export type { DecisionCache, DecisionMessage };
