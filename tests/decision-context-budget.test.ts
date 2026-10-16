import { describe, expect, it } from "vitest";
import { defaultMaxContextChars } from "../extensions/decision/context-budget.js";

describe("defaultMaxContextChars", () => {
  it("takes a quarter of the context window, clamped and scaled to characters", () => {
    // 32k tokens: 8k tokens of budget, 4 chars per token.
    expect(defaultMaxContextChars({ contextWindow: 32_000 })).toBe(32_000);
    // 1M tokens: the 12k-token ceiling applies, not the quarter.
    expect(defaultMaxContextChars({ contextWindow: 1_000_000 })).toBe(48_000);
    // 200k tokens: a quarter is 50k, so the ceiling still applies.
    expect(defaultMaxContextChars({ contextWindow: 200_000 })).toBe(48_000);
  });

  it("holds the floor on a small window", () => {
    // 4k tokens: a quarter is 1k, so the 2k-token floor applies.
    expect(defaultMaxContextChars({ contextWindow: 4_000 })).toBe(8_192);
    // A 1-token window and the fallback window land on the same clamped floor.
    expect(defaultMaxContextChars({ contextWindow: 1 })).toBe(8_192);
  });

  it("falls back to the default window when the model reports nothing usable", () => {
    expect(defaultMaxContextChars(undefined)).toBe(32_768);
    expect(defaultMaxContextChars({})).toBe(32_768);
    expect(defaultMaxContextChars({ contextWindow: 0 })).toBe(32_768);
    expect(defaultMaxContextChars({ contextWindow: -5 })).toBe(32_768);
    expect(defaultMaxContextChars({ contextWindow: Number.NaN })).toBe(32_768);
    expect(defaultMaxContextChars({ contextWindow: Number.POSITIVE_INFINITY })).toBe(32_768);
    expect(defaultMaxContextChars({ contextWindow: null as unknown as number })).toBe(32_768);
  });

  it("ignores maxTokens, which bounds output and not the input window", () => {
    expect(defaultMaxContextChars({ maxTokens: 64 })).toBe(32_768);
    expect(defaultMaxContextChars({ contextWindow: 32_000, maxTokens: 64 })).toBe(32_000);
  });
});
