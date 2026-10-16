import { describe, expect, it, vi } from "vitest";
import { createDecisionCache } from "../extensions/decision/cache.js";
import { createDecisionLayer } from "../extensions/decision/decision.js";
import { recallTurnCacheKey } from "../extensions/lifecycle/memory-lifecycle-recall.js";
import type { DecisionBackend } from "../extensions/decision/types.js";
import type {
  DecisionBankCandidate,
  DecisionCache,
  DecisionRequest,
  DecisionResult,
} from "../extensions/decision/types.js";
import type { DecisionLayer } from "../extensions/decision/decision.js";
import type { ResolvedConfig } from "../extensions/types.js";
import {
  collectEvents,
  decisionConfig,
  fakeHost,
  hangingBackend,
  recordingBackend,
} from "./helpers/decision.js";

const BANKS = [
  { id: "coding", alias: "project", access: "read-write" },
  { id: "life", alias: "user", access: "read" },
  { id: "archive", access: "write" },
];

const READ: DecisionBankCandidate[] = [
  { id: "coding", access: "read-write", description: "repo memory" },
  { id: "life", access: "read" },
];
const WRITE: DecisionBankCandidate[] = [
  { id: "coding", access: "read-write" },
  { id: "archive", access: "write" },
];

function request(overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    messages: [{ role: "user", content: "hello", timestamp: 1 }],
    readCandidates: READ,
    writeCandidates: WRITE,
    ...overrides,
  };
}

/** Config with a concrete model and `banksFallback` pinned, since normalization drops unknown ids. */
function config(
  input: { decision?: Record<string, unknown>; banksFallback?: string[] } = {},
): ResolvedConfig {
  const decision = { model: "magpie/group/labor", ...input.decision };
  return {
    ...decisionConfig({ banks: BANKS, decision }),
    banksFallback: input.banksFallback ?? [],
  };
}

describe("decision routing", () => {
  it("answers both gates in one call and keeps candidate order", async () => {
    const events = collectEvents();
    const backend = recordingBackend({
      inject: true,
      "read:coding": true,
      "read:life": false,
      "write:coding": true,
      "write:archive": true,
    });
    const layer = createDecisionLayer({
      host: fakeHost({ backends: () => [backend] }),
      getConfig: () => config(),
      observer: events.observer,
    });

    const result = await layer.decide(request());

    expect(result).toEqual({
      inject: true,
      readBanks: ["coding"],
      writeBanks: ["coding", "archive"],
      reason: "test-backend",
    });
    expect(backend.calls).toBe(1);
    expect(backend.lastQuestions).toEqual([
      "inject",
      "read:coding",
      "read:life",
      "write:coding",
      "write:archive",
    ]);
    expect(events.decisionEvents.at(-1)).toMatchObject({
      status: "success",
      cache: "miss",
      inject: true,
      readBanks: ["coding"],
      writeBanks: ["coding", "archive"],
    });
  });

  it("drops ids nobody offered and ids the entry no longer allows", async () => {
    const events = collectEvents();
    const backend = recordingBackend({
      inject: true,
      "read:ghost": true,
      "read:archive": true,
      "write:life": true,
    });
    const layer = createDecisionLayer({
      host: fakeHost({ backends: () => [backend] }),
      getConfig: () => config(),
      observer: events.observer,
    });

    const result = await layer.decide(request());

    expect(result.readBanks).toEqual([]);
    expect(result.writeBanks).toEqual([]);
    // Telemetry extras are `unknown` behind the index signature; compare in place.
    expect(events.decisionEvents.at(-1)).toMatchObject({
      droppedBanks: ["ghost", "archive", "life"],
    });
  });

  it("drops a candidate whose bank entry is gone or disabled", async () => {
    const events = collectEvents();
    const backend = recordingBackend({ inject: true, "read:retired": true });
    const layer = createDecisionLayer({
      host: fakeHost({ backends: () => [backend] }),
      getConfig: () => config(),
      observer: events.observer,
    });

    const result = await layer.decide(
      request({ readCandidates: [{ id: "retired", access: "read" }], writeCandidates: [] }),
    );

    expect(result.readBanks).toEqual([]);
    expect(events.decisionEvents.at(-1)?.droppedBanks).toEqual(["retired"]);
  });

  it("keeps the write routing when recall injection is off", async () => {
    const backend = recordingBackend({ inject: false, "read:coding": true, "write:coding": true });
    const layer = createDecisionLayer({
      host: fakeHost({ backends: () => [backend] }),
      getConfig: () => config(),
    });

    expect(await layer.decide(request())).toEqual({
      inject: false,
      readBanks: [],
      writeBanks: ["coding"],
      reason: "test-backend",
    });
  });

  it("asks nothing when no bank is a candidate", async () => {
    const events = collectEvents();
    const backend = recordingBackend({});
    const layer = createDecisionLayer({
      host: fakeHost({ backends: () => [backend] }),
      getConfig: () => config(),
      observer: events.observer,
    });

    const result = await layer.decide(request({ readCandidates: [], writeCandidates: [] }));

    expect(result).toEqual({
      inject: false,
      readBanks: [],
      writeBanks: [],
      reason: "no-candidates",
    });
    expect(backend.calls).toBe(0);
    expect(events.decisionEvents.at(-1)?.status).toBe("skipped");
  });

  it("answers a write-only call, so retain routing reaches the model", async () => {
    const events = collectEvents();
    const backend = recordingBackend({ "write:coding": true, "write:archive": false });
    const layer = createDecisionLayer({
      host: fakeHost({ backends: () => [backend] }),
      getConfig: () => config({ banksFallback: ["life"] }),
      observer: events.observer,
    });

    const result = await layer.decide(request({ readCandidates: [], writeCandidates: WRITE }));

    // No inject gate was asked, so nothing is required of the backend but the write table.
    expect(backend.calls).toBe(1);
    expect(backend.lastQuestions).toEqual(["write:coding", "write:archive"]);
    expect(result).toEqual({
      inject: false,
      readBanks: [],
      writeBanks: ["coding"],
      reason: "test-backend",
    });
  });

  it("passes the task state into the prompt and survives an unreadable one", async () => {
    const backend = recordingBackend({ inject: true });
    const layer = createDecisionLayer({
      host: fakeHost({ backends: () => [backend] }),
      getConfig: () => config(),
      readTodo: () => {
        throw new Error("todo reader exploded");
      },
    });

    await layer.decide(request());

    expect(backend.lastState).toContain("# Last user message\nhello");
    expect(backend.lastState).toContain("Unavailable");
    expect(backend.lastState).toContain("- coding (read-write): repo memory");
  });
});

describe("decision degradation", () => {
  it("falls back to the configured fallback banks with access filtering", async () => {
    const backend = recordingBackend({ inject: true });
    backend.answer = async () => {
      throw new Error("model unavailable");
    };
    const layer = createDecisionLayer({
      host: fakeHost({ backends: () => [backend] }),
      getConfig: () =>
        config({
          decision: {
            fallback: { recallBanks: ["life", "archive"], retainBanks: ["archive", "life"] },
          },
        }),
    });

    const result = await layer.decide(request());

    expect(result).toEqual({
      inject: true,
      readBanks: ["life"],
      writeBanks: ["archive"],
      reason: "backends-failed",
    });
  });

  it("prefers `banksFallback` when no per-path fallback is configured", async () => {
    const backend = recordingBackend({});
    backend.answer = async () => {
      throw new Error("model unavailable");
    };
    const layer = createDecisionLayer({
      host: fakeHost({ backends: () => [backend] }),
      getConfig: () => config({ banksFallback: ["archive", "coding"] }),
    });

    const result = await layer.decide(request());

    // `archive` is write-only, so the read path cannot use it.
    expect(result.readBanks).toEqual(["coding"]);
    expect(result.writeBanks).toEqual(["archive", "coding"]);
  });

  it("times out a hanging rung and reports it", async () => {
    const events = collectEvents();
    const layer = createDecisionLayer({
      host: fakeHost({ backends: () => [hangingBackend()] }),
      getConfig: () => config({ decision: { timeoutMs: 5 }, banksFallback: ["coding"] }),
      observer: events.observer,
    });

    const result = await layer.decide(request());

    expect(result.reason).toBe("backends-failed");
    expect(events.decisionEvents.map((event) => event.status)).toEqual(["timeout", "error"]);
    expect(events.decisionEvents[0]?.attempt).toBe(1);
  });

  it("walks the ladder until a rung answers", async () => {
    const first = recordingBackend({});
    first.answer = async () => {
      throw new Error("first rung down");
    };
    const second = recordingBackend({ inject: true, "read:coding": true });
    const events = collectEvents();
    const layer = createDecisionLayer({
      host: fakeHost({ backends: () => [first, second] }),
      getConfig: () => config(),
      observer: events.observer,
    });

    const result = await layer.decide(request());

    expect(result.readBanks).toEqual(["coding"]);
    expect(second.calls).toBe(1);
    expect(events.decisionEvents.map((event) => event.attempt)).toEqual([1, 2]);
    expect(events.decisionEvents[0]?.error).toContain("first rung down");
  });

  it("fails the rung when the inject gate is unanswered", async () => {
    const backend = recordingBackend({ "read:coding": true });
    const events = collectEvents();
    const layer = createDecisionLayer({
      host: fakeHost({ backends: () => [backend] }),
      getConfig: () => config({ banksFallback: ["coding"] }),
      observer: events.observer,
    });

    const result = await layer.decide(request());

    expect(result.reason).toBe("backends-failed");
    expect(events.decisionEvents[0]?.error).toContain("inject gate");
  });

  it("returns the fallback routing when the layer is disabled", async () => {
    const backend = recordingBackend({ inject: false });
    const layer = createDecisionLayer({
      host: fakeHost({ backends: () => [backend] }),
      getConfig: () => config({ decision: { enabled: false }, banksFallback: ["coding"] }),
    });

    expect(await layer.decide(request())).toEqual({
      inject: true,
      readBanks: ["coding"],
      writeBanks: ["coding"],
      reason: "disabled",
    });
    expect(backend.calls).toBe(0);
  });

  it("stops early on an aborted turn", async () => {
    const backend = recordingBackend({ inject: true });
    const layer = createDecisionLayer({
      host: fakeHost({ backends: () => [backend] }),
      getConfig: () => config(),
    });
    const controller = new AbortController();
    controller.abort();

    const result = await layer.decide(request({ signal: controller.signal }));

    expect(result.reason).toBe("aborted");
    expect(backend.calls).toBe(0);
  });

  it("never throws when the host has no model at all", async () => {
    const layer = createDecisionLayer({
      host: fakeHost({ backends: () => [] }),
      getConfig: () => config({ banksFallback: ["coding"] }),
    });
    expect(await layer.decide(request())).toMatchObject({
      reason: "no-model",
      readBanks: ["coding"],
    });
  });
});

describe("decision cache", () => {
  it("reuses a result for the same user turn and re-decides after the TTL", async () => {
    let clock = 1_000;
    const backend = recordingBackend({ inject: true, "read:coding": true });
    const events = collectEvents();
    const layer = createDecisionLayer({
      host: fakeHost({ backends: () => [backend] }),
      getConfig: () => config({ decision: { cacheTtlMs: 1_000 } }),
      observer: events.observer,
      now: () => clock,
    });

    await layer.decide(request());
    clock += 500;
    const second = await layer.decide(request());
    expect(backend.calls).toBe(1);
    expect(second.readBanks).toEqual(["coding"]);
    expect(events.decisionEvents.at(-1)?.cache).toBe("hit");

    clock += 1_001;
    await layer.decide(request());
    expect(backend.calls).toBe(2);
  });

  it("accepts an injected cache, keyed by offered banks and the last user content", async () => {
    const messages = [{ role: "user", content: "hello", timestamp: 1 }];
    const preloaded: DecisionResult = {
      inject: false,
      readBanks: [],
      writeBanks: ["archive"],
      reason: "cached",
    };
    const cache = createDecisionCache(60_000, () => 0);
    cache.set(
      recallTurnCacheKey(["read:coding", "read:life", "write:coding", "write:archive"], messages),
      preloaded,
    );
    const backend = recordingBackend({ inject: true });
    const layer = createDecisionLayer({
      host: fakeHost({ backends: () => [backend] }),
      getConfig: () => config(),
      cache,
      now: () => 0,
    });

    expect(await layer.decide(request({ messages }))).toEqual(preloaded);
    expect(backend.calls).toBe(0);
  });

  it("does not cache a fallback decision", async () => {
    let attempts = 0;
    const backend = recordingBackend({});
    backend.answer = async () => {
      attempts += 1;
      throw new Error("model unavailable");
    };
    const layer = createDecisionLayer({
      host: fakeHost({ backends: () => [backend] }),
      getConfig: () => config({ banksFallback: ["coding"] }),
    });

    await layer.decide(request());
    await layer.decide(request());
    expect(attempts).toBe(2);
  });

  it("keeps a recall call and a retain call for the same turn on separate keys", async () => {
    const messages = [{ role: "user", content: "hello", timestamp: 1 }];
    const cache = createDecisionCache(60_000, () => 0);
    const backend = recordingBackend({ inject: true, "read:coding": true, "write:coding": true });
    const layer = createDecisionLayer({
      host: fakeHost({ backends: () => [backend] }),
      getConfig: () => config({ banksFallback: ["coding"] }),
      cache,
      now: () => 0,
    });
    const coding: DecisionBankCandidate[] = [{ id: "coding", access: "read-write" }];

    // The recall call offers the bank for reading only, so it asks no write question.
    const recall = await layer.decide(
      request({ readCandidates: coding, writeCandidates: [], messages }),
    );
    expect(recall.writeBanks).toEqual([]);

    // Same bank ids, same user turn, opposite direction: the recall result must not be reused.
    const retain = await layer.decide(
      request({ readCandidates: [], writeCandidates: coding, messages }),
    );

    expect(backend.calls).toBe(2);
    expect(retain.writeBanks).toEqual(["coding"]);
    expect(retain.reason).toBe("test-backend");
  });
});

describe("decision cache seam", () => {
  it("does not consult a cache for a result it will not produce", async () => {
    const reads: string[] = [];
    const cache: DecisionCache = {
      get: (key) => {
        reads.push(key);
        return undefined;
      },
      set: () => undefined,
    };
    const layer = createDecisionLayer({
      host: fakeHost({ backends: () => [recordingBackend({ inject: true })] }),
      getConfig: () => config(),
      cache,
    });

    await layer.decide(request({ readCandidates: [], writeCandidates: [] }));
    expect(reads).toEqual([]);
  });
});

describe("decision prompt budget", () => {
  /** Length of the budgeted recent-activity section of a rendered state. */
  function activityLength(state: string | undefined): number {
    const text = state ?? "";
    const start = text.indexOf("# Recent activity");
    if (start < 0) return 0;
    const end = text.indexOf("# Readable banks", start);
    return (end < 0 ? text.length : end) - start;
  }

  /** Backend that records the state it was handed, plus the options it saw. */
  function recordingOptionsBackend(): {
    backend: DecisionBackend;
    options: { maxTokens?: number }[];
    states: string[];
  } {
    const seen: { maxTokens?: number }[] = [];
    const states: string[] = [];
    return {
      options: seen,
      states,
      backend: {
        kind: "text",
        label: "test-backend",
        async answer(_questions, state, options) {
          seen.push(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens });
          states.push(state);
          return { inject: true, "read:coding": true };
        },
      },
    };
  }

  function budgetLayer(input: {
    backend: DecisionBackend;
    decision?: Record<string, unknown>;
    contextWindow?: number;
  }): DecisionLayer {
    return createDecisionLayer({
      host: fakeHost({
        backends: () => [input.backend],
        ...(input.contextWindow === undefined
          ? {}
          : { modelContextWindow: () => input.contextWindow }),
      }),
      getConfig: () => config(input.decision === undefined ? {} : { decision: input.decision }),
    });
  }

  /** A turn with recent activity after the last user message. */
  const ACTIVITY: DecisionRequest["messages"] = [
    { role: "user", content: "hello", timestamp: 1 },
    // Several separate lines, so the greedy tail fill can keep a subset: a single
    // long line is cut whole and both budgets render the same truncation.
    ...Array.from({ length: 8 }, (_unused, index) => ({
      role: "assistant" as const,
      content: `assistant line ${index} ${"x".repeat(30_000)}`,
      timestamp: 2 + index,
    })),
  ];

  it("derives the prompt budget from the model's context window", async () => {
    // A large window lets the whole fixture through; the 2k-token floor cuts it.
    const wide = recordingOptionsBackend();
    await budgetLayer({ backend: wide.backend, contextWindow: 200_000 }).decide(
      request({ messages: ACTIVITY }),
    );
    const narrow = recordingOptionsBackend();
    await budgetLayer({ backend: narrow.backend, contextWindow: 8_000 }).decide(
      request({ messages: ACTIVITY }),
    );
    expect(activityLength(wide.states[0])).toBeGreaterThan(activityLength(narrow.states[0]));
  });

  it("keeps a hand-written budget over the model-derived one", async () => {
    const recorder = recordingOptionsBackend();
    await budgetLayer({
      backend: recorder.backend,
      contextWindow: 1_000_000,
      decision: { maxContextChars: 1_000 },
    }).decide(request());
    // A 1k-char budget leaves no room for the activity section at all.
    expect(recorder.states[0]).not.toContain("# Recent activity");
  });

  it("uses the final default when the model reports no context window", async () => {
    const recorder = recordingOptionsBackend();
    await budgetLayer({ backend: recorder.backend }).decide(request({ messages: ACTIVITY }));
    const derived = recordingOptionsBackend();
    await budgetLayer({ backend: derived.backend, contextWindow: 32_000 }).decide(
      request({ messages: ACTIVITY }),
    );
    // A 32k-token window derives a quarter, 8192 chars; an unreported window
    // spends the config default instead, which is a larger budget.
    expect(activityLength(recorder.states[0])).toBeGreaterThan(activityLength(derived.states[0]));
    expect(activityLength(recorder.states[0])).toBeGreaterThan(0);
  });

  it("omits maxTokens from the backend call when it is non-positive", async () => {
    const recorder = recordingOptionsBackend();
    await budgetLayer({ backend: recorder.backend, decision: { maxTokens: 0 } }).decide(request());
    expect(recorder.options).toEqual([{}]);
  });

  it("passes maxTokens through when it is a positive number", async () => {
    const recorder = recordingOptionsBackend();
    await budgetLayer({ backend: recorder.backend, decision: { maxTokens: 64 } }).decide(request());
    expect(recorder.options).toEqual([{ maxTokens: 64 }]);
  });

  it("arms no timer and still honors the caller's signal when timeoutMs is non-positive", async () => {
    const events = collectEvents();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const backend = recordingBackend({ inject: true });
    const layer = createDecisionLayer({
      host: fakeHost({ backends: () => [backend] }),
      getConfig: () => config({ decision: { timeoutMs: -1 }, banksFallback: ["coding"] }),
      observer: events.observer,
    });
    const controller = new AbortController();
    const settled = layer.decide(request({ signal: controller.signal }));
    controller.abort();

    expect(await settled).toMatchObject({ reason: "aborted" });
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });
});
