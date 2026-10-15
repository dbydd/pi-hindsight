import { describe, expect, it } from "vitest";
import { createDecisionCache } from "../extensions/decision/cache.js";
import { createDecisionLayer } from "../extensions/decision/decision.js";
import { recallTurnCacheKey } from "../extensions/lifecycle/memory-lifecycle-recall.js";
import type {
  DecisionBankCandidate,
  DecisionCache,
  DecisionRequest,
  DecisionResult,
} from "../extensions/decision/types.js";
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
    cache.set(recallTurnCacheKey(["coding", "life", "coding", "archive"], messages), preloaded);
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
