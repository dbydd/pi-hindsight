import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDecisionLayer, type DecisionLayer } from "../extensions/decision/decision.js";
import { createRuntimeDecisionHost, degradedDecisionHost } from "../extensions/decision/host.js";
import { resolveDecisionModel } from "../extensions/decision/model.js";
import type { DecisionRequest, DecisionResult } from "../extensions/decision/types.js";
import { DEFAULT_CONFIG } from "../extensions/config/config-defaults.js";
import { isRecord, normalizeConfig } from "../extensions/config/config-normalize.js";
import { createRecallTurnPolicy } from "../extensions/lifecycle/memory-lifecycle-recall.js";
import { createMemoryLifecycle } from "../extensions/lifecycle/memory-lifecycle.js";
import { selectMemoryScopes } from "../extensions/operations/memory-scope.js";
import type { RetrievalTelemetry } from "../extensions/lifecycle/retrieval-telemetry.js";
import type { RuntimeSnapshot } from "../extensions/lifecycle/memory-lifecycle-runtime.js";
import type { HindsightLikeClient, ResolvedConfig } from "../extensions/types.js";
import type * as BankOperations from "../extensions/banks/bank-operations.js";

const mocked = vi.hoisted(() => ({
  client: {
    retain: vi.fn(async (..._args: unknown[]) => undefined),
    recall: vi.fn(async (..._args: unknown[]) => ({ results: [{ text: "remembered fact" }] })),
    reflect: vi.fn(async (..._args: unknown[]) => ({})),
    createBank: vi.fn(async (..._args: unknown[]) => undefined),
    getBankProfile: vi.fn(async (..._args: unknown[]) => ({})),
    deleteDocument: vi.fn(async (..._args: unknown[]) => ({ success: true })),
  },
  ensureGlobalBank: vi.fn(async () => undefined),
  ensureProjectBank: vi.fn(async () => undefined),
  checkHindsight: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../extensions/client/client.js", () => ({
  createHindsightClient: () => mocked.client,
  checkHindsight: mocked.checkHindsight,
}));

vi.mock("../extensions/banks/bank-operations.js", async (importOriginal) => {
  const actual = await importOriginal<typeof BankOperations>();
  return {
    ...actual,
    ensureGlobalBank: mocked.ensureGlobalBank,
    ensureProjectBank: mocked.ensureProjectBank,
  };
});

const MODEL = { provider: "magpie", id: "group/labor", api: "openai-completions" };

/** Readable coding + life entries and one write-only entry the recall path must skip. */
const BANKS: ResolvedConfig["banks"] = [
  { id: "coding", alias: "project", bankId: "coding-bank", description: "repo memory" },
  { id: "life", alias: "user", bankId: "life-bank" },
  { id: "archive", access: "write", bankId: "archive-bank" },
];

/** Normalized config with `recall`/`decision` overrides, resolved against real entries. */
function recallConfig(
  patch: { recall?: unknown; decision?: unknown; banksFallback?: unknown; banks?: unknown } = {},
): ResolvedConfig {
  const banks = patch.banks ?? BANKS;
  const recall = { ...DEFAULT_CONFIG.recall, ...(isRecord(patch.recall) ? patch.recall : {}) };
  const decision = {
    ...DEFAULT_CONFIG.decision,
    ...(isRecord(patch.decision) ? patch.decision : {}),
  };
  const merged = {
    ...DEFAULT_CONFIG,
    banks,
    recall,
    decision,
    ...(patch.banksFallback !== undefined ? { banksFallback: patch.banksFallback } : {}),
  } as ResolvedConfig;
  return normalizeConfig(merged, {
    banks,
    recall,
    decision,
    banksFallback: patch.banksFallback,
  });
}

function runtimeFor(cwd: string): RuntimeSnapshot {
  mkdirSync(join(cwd, ".git"));
  return { cwd, ui: { setStatus: () => undefined, notify: () => undefined } };
}

function tempRepo(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `pi-hindsight-${prefix}-`));
}

/** Decision layer whose answers are fixed; records every request it receives. */
function fakeDecision(
  result: Partial<DecisionResult> = {},
): DecisionLayer & { calls: DecisionRequest[] } {
  const calls: DecisionRequest[] = [];
  return {
    calls,
    async decide(request) {
      calls.push(request);
      return { inject: true, readBanks: [], writeBanks: [], reason: "fake", ...result };
    },
  };
}

function policyFor(
  config: ResolvedConfig,
  layer?: DecisionLayer,
  events: RetrievalTelemetry[] = [],
) {
  const recall = vi.fn(async (..._args: unknown[]) => ({
    results: [{ text: "remembered fact" }],
  }));
  const client: HindsightLikeClient = {
    retain: vi.fn(async () => undefined),
    recall,
    reflect: vi.fn(async () => ({})),
  };
  const policy = createRecallTurnPolicy({
    observer: (event) => {
      events.push(event);
    },
    getConfig: () => config,
    getClient: () => client,
    ...(layer ? { getDecisionLayer: () => layer } : {}),
    setMemoryStatus: () => undefined,
    notify: () => undefined,
  });
  return { policy, recall, events };
}

function turn(content: string) {
  return { messages: [{ role: "user", content, timestamp: 1 }] } as never;
}

function bankIdsRead(recall: { mock: { calls: unknown[][] } }): unknown[] {
  return recall.mock.calls.map((call) => call[0]);
}

function skipReasons(events: RetrievalTelemetry[]): string[] {
  return events
    .filter((event) => event.phase === "injection" && event.status === "skipped")
    .map((event) => String(event.reason));
}

function injectedTurns(events: RetrievalTelemetry[]): number {
  return events.filter((event) => event.phase === "injection" && event.status === "success").length;
}

/** Text of the first patched message; `unknown` because a patch carries host messages. */
function firstMessageContent(patch: { messages: unknown[] } | undefined): string {
  const first = patch?.messages[0];
  if (!first || typeof first !== "object" || !("content" in first)) return "";
  return String(first.content);
}

describe("recall gate configuration", () => {
  it("defaults to every-turn with all banks", () => {
    const config = recallConfig();
    expect(config.recall.mode).toBe("every-turn");
    expect(config.recall.bankMode).toBe("all");
    expect(config.recall.everyNTurns).toBe(5);
    expect(config.recall.minIntervalMs).toBe(0);
  });

  it("keeps explicit values and drops unusable ones", () => {
    expect(
      recallConfig({
        recall: { mode: "interval", bankMode: "decision", everyNTurns: 3, minIntervalMs: 1_000 },
      }).recall,
    ).toMatchObject({
      mode: "interval",
      bankMode: "decision",
      everyNTurns: 3,
      minIntervalMs: 1_000,
    });
    expect(
      recallConfig({
        recall: { mode: "sometimes", bankMode: "some", everyNTurns: 0, minIntervalMs: -1 },
      }).recall,
    ).toMatchObject({
      mode: "every-turn",
      bankMode: "all",
      everyNTurns: 5,
      minIntervalMs: 0,
    });
  });
});

describe("recall timing modes", () => {
  it("keeps the fixed scope set and never calls the decision model by default", async () => {
    const decision = fakeDecision({ inject: false, readBanks: [] });
    const config = recallConfig();
    const runtime = runtimeFor(tempRepo("gates-default"));
    const { policy, recall, events } = policyFor(config, decision);

    const patch = await policy.recall(turn("what did we decide?"), runtime);

    expect(decision.calls).toHaveLength(0);
    expect(bankIdsRead(recall)).toEqual(["coding-bank", "life-bank"]);
    expect(firstMessageContent(patch)).toContain("<hindsight-memory>");
    expect(injectedTurns(events)).toBe(1);
  });

  it("manual mode never recalls automatically", async () => {
    const config = recallConfig({ recall: { mode: "manual" } });
    const { policy, recall, events } = policyFor(config);

    const patch = await policy.recall(turn("any turn"), runtimeFor(tempRepo("gates-manual")));

    expect(patch).toBeUndefined();
    expect(recall).not.toHaveBeenCalled();
    expect(skipReasons(events)).toEqual(["manual"]);
  });

  it("interval mode recalls only on the configured turn cadence", async () => {
    const config = recallConfig({ recall: { mode: "interval", everyNTurns: 3 } });
    const runtime = runtimeFor(tempRepo("gates-interval"));
    const { policy, recall, events } = policyFor(config);

    for (let index = 1; index <= 6; index++) {
      await policy.recall(turn(`turn ${index}`), runtime);
    }

    expect(skipReasons(events)).toEqual(["interval", "interval", "interval", "interval"]);
    expect(injectedTurns(events)).toBe(2);
    expect(bankIdsRead(recall)).toEqual(["coding-bank", "life-bank", "coding-bank", "life-bank"]);
  });

  it("interval mode also honors the minimum time between recalls", async () => {
    const spy = vi.spyOn(Date, "now");
    const config = recallConfig({
      recall: { mode: "interval", everyNTurns: 1, minIntervalMs: 60_000 },
    });
    const runtime = runtimeFor(tempRepo("gates-interval-time"));
    const { policy, events } = policyFor(config);

    spy.mockReturnValue(1_000);
    await policy.recall(turn("turn 1"), runtime);
    spy.mockReturnValue(5_000);
    await policy.recall(turn("turn 2"), runtime);
    spy.mockReturnValue(70_000);
    await policy.recall(turn("turn 3"), runtime);
    spy.mockRestore();

    expect(skipReasons(events)).toEqual(["interval"]);
    expect(injectedTurns(events)).toBe(2);
  });

  it("decision mode skips the turn when gate A answers no", async () => {
    const decision = fakeDecision({ inject: false });
    const config = recallConfig({ recall: { mode: "decision" } });
    const { policy, recall, events } = policyFor(config, decision);

    const patch = await policy.recall(turn("chit chat"), runtimeFor(tempRepo("gates-gate-a")));

    expect(patch).toBeUndefined();
    expect(recall).not.toHaveBeenCalled();
    expect(skipReasons(events)).toEqual(["decision-no-inject"]);
    expect(decision.calls[0]?.readCandidates.map((candidate) => candidate.id)).toEqual([
      "coding",
      "life",
    ]);
  });

  it("decision mode keeps the fixed scope set when gate A answers yes", async () => {
    const decision = fakeDecision({ inject: true, readBanks: ["life"] });
    const config = recallConfig({ recall: { mode: "decision" } });
    const { policy, recall } = policyFor(config, decision);

    await policy.recall(turn("fix the queue"), runtimeFor(tempRepo("gates-gate-a-yes")));

    expect(decision.calls).toHaveLength(1);
    expect(bankIdsRead(recall)).toEqual(["coding-bank", "life-bank"]);
  });

  it("falls back to the fixed scope path when no decision layer is wired", async () => {
    const config = recallConfig({ recall: { mode: "decision", bankMode: "decision" } });
    const { policy, recall } = policyFor(config);

    await policy.recall(turn("still works"), runtimeFor(tempRepo("gates-no-layer")));

    expect(bankIdsRead(recall)).toEqual(["coding-bank", "life-bank"]);
  });
});

describe("recall bank routing", () => {
  it("offers enabled readable entries and reads only the model's banks", async () => {
    const decision = fakeDecision({ readBanks: ["life"] });
    const config = recallConfig({ recall: { bankMode: "decision" } });
    const runtime = runtimeFor(tempRepo("gates-banks"));
    const { policy, recall } = policyFor(config, decision);

    await policy.recall(turn("what are my preferences?"), runtime);

    expect(decision.calls[0]?.readCandidates).toEqual([
      { id: "coding", access: "read-write", description: "repo memory" },
      { id: "life", access: "read-write" },
    ]);
    expect(decision.calls[0]?.writeCandidates).toEqual([]);
    expect(bankIdsRead(recall)).toEqual(["life-bank"]);
    // Scope tag derivation is untouched by routing: the bank keeps its own tags.
    const expected = selectMemoryScopes(runtime.cwd, config).find(
      (scope) => scope.entryId === "life",
    );
    expect(recall.mock.calls[0]?.[2]).toMatchObject({ tagGroups: expected?.tagGroups });
  });

  it("skips the turn when the model reads no bank at all", async () => {
    const decision = fakeDecision({ readBanks: [] });
    const config = recallConfig({ recall: { bankMode: "decision" } });
    const { policy, recall, events } = policyFor(config, decision);

    const patch = await policy.recall(
      turn("nothing today"),
      runtimeFor(tempRepo("gates-no-banks")),
    );

    expect(patch).toBeUndefined();
    expect(recall).not.toHaveBeenCalled();
    expect(skipReasons(events)).toEqual(["decision-no-banks"]);
  });

  it("routes to the fallback banks when the decision layer cannot answer", async () => {
    const config = recallConfig({
      recall: { mode: "decision", bankMode: "decision" },
      banksFallback: ["coding"],
    });
    const events: RetrievalTelemetry[] = [];
    // A host with no backend is exactly "the model could not be reached".
    const layer = createDecisionLayer({
      host: degradedDecisionHost(),
      getConfig: () => config,
      observer: (event) => {
        events.push(event);
      },
    });
    const { policy, recall } = policyFor(config, layer, events);

    await policy.recall(
      turn("keep the memory chain alive"),
      runtimeFor(tempRepo("gates-fallback")),
    );

    expect(bankIdsRead(recall)).toEqual(["coding-bank"]);
    expect(
      events.some(
        (event) =>
          event.phase === "decision" && event.status === "skipped" && event.reason === "no-model",
      ),
    ).toBe(true);
  });
});

describe("decision host construction", () => {
  it("builds the pi host and resolves the session model for a role spec", async () => {
    const host = await createRuntimeDecisionHost({
      ctx: {
        model: MODEL,
        modelRegistry: {
          find: () => MODEL,
          complete: async () => ({ role: "assistant", content: "yes" }),
        },
      },
    });

    expect(host.kind).toBe("pi");
    expect(host.roles).toBe(false);
    const resolved = await resolveDecisionModel({ spec: "role:judge", host });
    expect(resolved?.source).toBe("session");
    expect(resolved?.backends.map((backend) => backend.kind)).toEqual(["text"]);
  });

  it("degrades to an always-fallback host when the context cannot be read", async () => {
    const hostile = {
      get modelRegistry(): unknown {
        throw new Error("stale session context");
      },
    };
    const host = await createRuntimeDecisionHost({ ctx: hostile });

    expect(host.kind).toBe("unknown");
    expect(host.roles).toBe(false);
    expect(host.backends({ provider: "magpie", modelId: "group/labor" })).toEqual([]);
    await expect(resolveDecisionModel({ spec: "role:judge", host })).resolves.toBeUndefined();
  });
});

describe("decision wiring through the lifecycle", () => {
  const originalHome = process.env.HOME;

  beforeEach(() => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "pi-hindsight-gates-home-"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  /** Project config that closes the setup gate for domain-tagged mode. */
  function writeConfig(cwd: string, extra: Record<string, unknown>): void {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "hindsight.json"),
      JSON.stringify({
        setupComplete: true,
        hindsight: { baseUrl: "http://unused.test" },
        banks: [
          { id: "coding", alias: "project", bankId: "test-coding", derive: "manual" },
          { id: "life", alias: "user", enabled: false, bankId: "test-life" },
        ],
        ...extra,
      }),
    );
  }

  it("recalls through the fallback banks when host construction fails", async () => {
    const cwd = tempRepo("gates-host-failure");
    mkdirSync(join(cwd, ".git"));
    writeConfig(cwd, {
      recall: { mode: "decision", bankMode: "decision" },
      banksFallback: ["coding"],
    });
    const ctx = {
      cwd,
      ui: { setStatus: vi.fn(), notify: vi.fn() },
      sessionManager: {
        getSessionFile: () => join(cwd, "session.jsonl"),
        getSessionId: () => "session-1",
      },
    };
    const events: RetrievalTelemetry[] = [];
    const lifecycle = createMemoryLifecycle(
      cwd,
      (event) => {
        events.push(event);
      },
      {
        loadDecisionHost: () => {
          throw new Error("host constructor exploded");
        },
        readTodo: () => ({ kind: "unknown" }),
      },
    );

    await lifecycle.initialize(ctx);
    const patch = await lifecycle.recall(turn("what did we decide?"), ctx);

    expect(
      bankIdsRead(mocked.client.recall as unknown as { mock: { calls: unknown[][] } }),
    ).toEqual(["test-coding"]);
    expect(firstMessageContent(patch)).toContain("<hindsight-memory>");
    expect(events.some((event) => event.phase === "decision" && event.status === "skipped")).toBe(
      true,
    );
  });

  it("never builds a decision host when no recall gate asks for one", async () => {
    const cwd = tempRepo("gates-host-unused");
    mkdirSync(join(cwd, ".git"));
    writeConfig(cwd, {});
    const ctx = {
      cwd,
      ui: { setStatus: vi.fn(), notify: vi.fn() },
      sessionManager: {
        getSessionFile: () => join(cwd, "session.jsonl"),
        getSessionId: () => "session-2",
      },
    };
    const loadDecisionHost = vi.fn(async () => undefined);
    const lifecycle = createMemoryLifecycle(cwd, undefined, { loadDecisionHost });

    await lifecycle.initialize(ctx);
    await lifecycle.recall(turn("what did we decide?"), ctx);

    expect(loadDecisionHost).not.toHaveBeenCalled();
    expect(mocked.client.recall).toHaveBeenCalledTimes(1);
    expect(mocked.client.recall.mock.calls[0]?.[0]).toBe("test-coding");
  });
});
