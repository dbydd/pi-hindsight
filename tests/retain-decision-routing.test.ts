import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEndEvent } from "@earendil-works/pi-coding-agent";
import { bankRetainMode } from "../extensions/config/banks.js";
import { DEFAULT_CONFIG } from "../extensions/config/config-defaults.js";
import { isRecord, normalizeConfig } from "../extensions/config/config-normalize.js";
import { createDecisionLayer, type DecisionLayer } from "../extensions/decision/decision.js";
import { degradedDecisionHost } from "../extensions/decision/host.js";
import type {
  DecisionBackend,
  DecisionHost,
  DecisionRequest,
  DecisionResult,
} from "../extensions/decision/types.js";
import { createMemoryLifecycle } from "../extensions/lifecycle/memory-lifecycle.js";
import { createRetainTurnPolicy } from "../extensions/lifecycle/memory-lifecycle-retain.js";
import type { RuntimeSnapshot } from "../extensions/lifecycle/memory-lifecycle-runtime.js";
import type {
  RetrievalObserver,
  RetrievalTelemetry,
} from "../extensions/lifecycle/retrieval-telemetry.js";
import type { HindsightLikeClient, ResolvedConfig } from "../extensions/types.js";
import type * as BankOperations from "../extensions/banks/bank-operations.js";

const mocked = vi.hoisted(() => ({
  client: {
    retain: vi.fn(async (..._args: unknown[]) => undefined),
    recall: vi.fn(async (..._args: unknown[]) => ({ results: [] })),
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

const PROJECT_BANK = "project-bank";
/** `enqueueRetainFromAgentEnd` probes append support; that call is not a transcript write. */
const APPEND_PROBE = "Pi Hindsight append capability probe. Safe to ignore.";

/** Coding (always by default), an unused user bank, and a plain extra entry. */
const BANKS: ResolvedConfig["banks"] = [
  { id: "coding", alias: "project", bankId: PROJECT_BANK },
  { id: "life", alias: "user", bankId: "life-bank" },
  { id: "notes", bankId: "notes-bank" },
];

const codingWith = (patch: Record<string, unknown>) => ({ ...BANKS[0]!, ...patch });

/** Normalized config with `banks`/`decision` overrides, resolved against real entries. */
function retainConfig(
  patch: {
    banks?: unknown;
    decision?: unknown;
    banksFallback?: unknown;
    notifications?: unknown;
  } = {},
): ResolvedConfig {
  const banks = patch.banks ?? BANKS;
  const decision = {
    ...DEFAULT_CONFIG.decision,
    ...(isRecord(patch.decision) ? patch.decision : {}),
  };
  const notifications = {
    ...DEFAULT_CONFIG.notifications,
    ...(isRecord(patch.notifications) ? patch.notifications : {}),
  };
  const merged = {
    ...DEFAULT_CONFIG,
    banks,
    decision,
    notifications,
    ...(patch.banksFallback !== undefined ? { banksFallback: patch.banksFallback } : {}),
  } as ResolvedConfig;
  return normalizeConfig(merged, {
    banks,
    decision,
    notifications,
    banksFallback: patch.banksFallback,
  });
}

function tempRepo(prefix: string): string {
  const cwd = mkdtempSync(join(tmpdir(), `pi-hindsight-${prefix}-`));
  mkdirSync(join(cwd, ".git"));
  return cwd;
}

function runtimeFor(cwd: string): RuntimeSnapshot {
  return {
    cwd,
    sessionFile: join(cwd, "session.jsonl"),
    ui: { setStatus: vi.fn(), notify: vi.fn() },
  };
}

function turnEvent(): AgentEndEvent {
  return {
    messages: [
      { id: "u1", role: "user", content: "remember how retain routing works", timestamp: 1 },
      { id: "a1", role: "assistant", content: "retain routing noted", timestamp: 2 },
    ],
  } as unknown as AgentEndEvent;
}

/** Client that records the bank of every transcript write it receives. */
function createStore(): { client: HindsightLikeClient; writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    client: {
      retain: async (bankId) => {
        writes.push(bankId);
      },
      recall: async () => [],
      reflect: async () => ({}),
    },
  };
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
      return { inject: false, readBanks: [], writeBanks: [], reason: "fake", ...result };
    },
  };
}

function retainedPolicy(args: {
  config: ResolvedConfig;
  client: HindsightLikeClient;
  layer?: DecisionLayer;
  events?: RetrievalTelemetry[];
  notifications?: string[];
}) {
  const observer: RetrievalObserver = (event) => {
    args.events?.push(event);
  };
  return createRetainTurnPolicy({
    ...(args.events ? { observer } : {}),
    getConfig: () => args.config,
    getClient: () => args.client,
    getProjectBankId: () => PROJECT_BANK,
    ...(args.layer ? { getDecisionLayer: () => args.layer } : {}),
    setMemoryStatus: () => undefined,
    notify: (_runtime, message) => {
      args.notifications?.push(message);
    },
  });
}

function retainEvents(events: RetrievalTelemetry[]): RetrievalTelemetry[] {
  return events.filter((event) => event.phase === "retain");
}

describe("retain write modes", () => {
  it("defaults the coding entry to always and every other entry to explicit-only", () => {
    const config = retainConfig();
    expect(bankRetainMode(config, config.banks[0]!)).toBe("always");
    expect(bankRetainMode(config, config.banks[1]!)).toBe("explicit-only");
    expect(bankRetainMode(config, config.banks[2]!)).toBe("explicit-only");
  });

  it("keeps an entry that names no role but leads the array as the coding entry", () => {
    const config = retainConfig({ banks: [{ id: "solo", bankId: "solo-bank" }] });
    expect(bankRetainMode(config, config.banks[0]!)).toBe("always");
  });

  it("maps the legacy user retain mode onto the user entry", () => {
    const banks = [
      { id: "coding", alias: "project" },
      { id: "life", alias: "user", bankId: "life-bank" },
    ];
    const resolved = (legacy: Record<string, unknown>, entries: unknown) =>
      normalizeConfig({ ...DEFAULT_CONFIG, banks: entries } as ResolvedConfig, {
        banks: entries,
        ...legacy,
      });

    expect(resolved({ userRetain: { mode: "explicit-only" } }, banks).banks[1]!.retain).toEqual({
      mode: "explicit-only",
    });
    expect(resolved({ globalRetain: { mode: "explicit-only" } }, banks).banks[1]!.retain).toEqual({
      mode: "explicit-only",
    });
    // Nothing is materialized without the legacy field.
    expect(resolved({}, banks).banks[1]!.retain).toBeUndefined();
    // A mode the entry states itself wins over the legacy field.
    const explicit = [banks[0], { ...banks[1]!, retain: { mode: "decision" } }];
    expect(resolved({ userRetain: { mode: "explicit-only" } }, explicit).banks[1]!.retain).toEqual({
      mode: "decision",
    });
  });
});

describe("retain routing", () => {
  it("writes the coding bank and never calls the model when no entry is decision-routed", async () => {
    const decision = fakeDecision();
    const store = createStore();
    const events: RetrievalTelemetry[] = [];
    const policy = retainedPolicy({
      config: retainConfig(),
      client: store.client,
      layer: decision,
      events,
    });

    const result = await policy.retain(turnEvent(), runtimeFor(tempRepo("retain-default")));

    expect(decision.calls).toHaveLength(0);
    expect(store.writes).toEqual([PROJECT_BANK]);
    expect(result).toMatchObject({ queued: true, sent: 1 });
    // The `always` path keeps its empty telemetry: only a decision run or an
    // empty routing is worth a retain span.
    expect(retainEvents(events)).toEqual([]);
  });

  it("writes an `always` entry without calling the model", async () => {
    const decision = fakeDecision();
    const store = createStore();
    const policy = retainedPolicy({
      config: retainConfig({
        banks: [BANKS[0], { id: "notes", bankId: "notes-bank", retain: { mode: "always" } }],
      }),
      client: store.client,
      layer: decision,
    });

    await policy.retain(turnEvent(), runtimeFor(tempRepo("retain-always")));

    expect(decision.calls).toHaveLength(0);
    expect(store.writes).toEqual([PROJECT_BANK, "notes-bank"]);
  });

  it("never writes an `explicit-only` entry, even beside a routed one", async () => {
    const store = createStore();
    const decision = fakeDecision({ writeBanks: ["notes"] });
    const policy = retainedPolicy({
      config: retainConfig({
        banks: [
          codingWith({ retain: { mode: "explicit-only" } }),
          { id: "life", alias: "user", bankId: "life-bank", retain: { mode: "always" } },
          { id: "notes", bankId: "notes-bank" },
        ],
      }),
      client: store.client,
      layer: decision,
    });

    await policy.retain(turnEvent(), runtimeFor(tempRepo("retain-explicit-only")));

    expect(store.writes).toEqual(["life-bank"]);
    expect(decision.calls).toHaveLength(0);
  });

  it("writes nothing when every entry is explicit-only", async () => {
    const decision = fakeDecision();
    const store = createStore();
    const notifications: string[] = [];
    const result = await retainedPolicy({
      config: retainConfig({
        banks: [
          codingWith({ retain: { mode: "explicit-only" } }),
          { id: "notes", bankId: "notes-bank" },
        ],
        notifications: { retain: true },
      }),
      client: store.client,
      layer: decision,
      notifications,
    }).retain(turnEvent(), runtimeFor(tempRepo("retain-none")));

    expect(decision.calls).toHaveLength(0);
    expect(store.writes).toEqual([]);
    expect(result).toMatchObject({ queued: false, sent: 0 });
    expect(notifications).toEqual([]);
  });

  it("never writes an entry with retain.enabled false", async () => {
    const decision = fakeDecision({ writeBanks: ["notes"] });
    const store = createStore();
    const policy = retainedPolicy({
      config: retainConfig({
        banks: [
          BANKS[0],
          { id: "notes", bankId: "notes-bank", retain: { enabled: false, mode: "decision" } },
        ],
      }),
      client: store.client,
      layer: decision,
    });

    await policy.retain(turnEvent(), runtimeFor(tempRepo("retain-disabled")));

    expect(decision.calls).toHaveLength(0);
    expect(store.writes).toEqual([PROJECT_BANK]);
  });

  it("offers only decision entries and writes the ones the model picks", async () => {
    const decision = fakeDecision({ writeBanks: ["notes"] });
    const store = createStore();
    const events: RetrievalTelemetry[] = [];
    const policy = retainedPolicy({
      config: retainConfig({
        banks: [BANKS[0], { id: "notes", bankId: "notes-bank", retain: { mode: "decision" } }],
      }),
      client: store.client,
      layer: decision,
      events,
    });

    await policy.retain(turnEvent(), runtimeFor(tempRepo("retain-decision-pick")));

    expect(decision.calls[0]?.readCandidates).toEqual([]);
    expect(decision.calls[0]?.writeCandidates).toEqual([{ id: "notes", access: "read-write" }]);
    expect(store.writes).toEqual([PROJECT_BANK, "notes-bank"]);
    expect(retainEvents(events)).toEqual([
      expect.objectContaining({
        status: "success",
        reason: "decision",
        bankIds: [PROJECT_BANK, "notes-bank"],
        decisionReason: "fake",
      }),
    ]);
  });

  it("keeps an `always` entry when the model picks nothing", async () => {
    const decision = fakeDecision({ writeBanks: [] });
    const store = createStore();
    const policy = retainedPolicy({
      config: retainConfig({
        banks: [BANKS[0], { id: "notes", bankId: "notes-bank", retain: { mode: "decision" } }],
      }),
      client: store.client,
      layer: decision,
    });

    await policy.retain(turnEvent(), runtimeFor(tempRepo("retain-mixed-empty")));

    expect(store.writes).toEqual([PROJECT_BANK]);
  });

  it("skips the write and names the reason when the model picks no bank", async () => {
    const decision = fakeDecision({ writeBanks: [] });
    const store = createStore();
    const events: RetrievalTelemetry[] = [];
    const notifications: string[] = [];
    const result = await retainedPolicy({
      config: retainConfig({
        banks: [
          codingWith({ retain: { mode: "explicit-only" } }),
          { id: "notes", bankId: "notes-bank", retain: { mode: "decision" } },
        ],
        notifications: { retain: true },
      }),
      client: store.client,
      layer: decision,
      events,
      notifications,
    }).retain(turnEvent(), runtimeFor(tempRepo("retain-decision-empty")));

    expect(store.writes).toEqual([]);
    expect(result).toMatchObject({ queued: false, sent: 0 });
    expect(retainEvents(events)).toEqual([
      expect.objectContaining({ status: "skipped", reason: "decision", bankIds: [] }),
    ]);
    expect(notifications).toEqual([
      expect.stringContaining("retain routing chose no bank (decision)"),
    ]);
  });

  it("skips an entry that has no resolvable bank id and reports it", async () => {
    const decision = fakeDecision({ writeBanks: ["notes"] });
    const store = createStore();
    const events: RetrievalTelemetry[] = [];
    const policy = retainedPolicy({
      config: retainConfig({
        banks: [
          BANKS[0],
          { id: "orphan", retain: { mode: "always" } },
          { id: "notes", bankId: "notes-bank", retain: { mode: "decision" } },
        ],
      }),
      client: store.client,
      layer: decision,
      events,
    });

    await policy.retain(turnEvent(), runtimeFor(tempRepo("retain-orphan")));

    expect(store.writes).toEqual([PROJECT_BANK, "notes-bank"]);
    expect(retainEvents(events)[0]?.droppedBanks).toEqual(["orphan"]);
  });

  it("skips the turn when the only routable entry has no bank id", async () => {
    const store = createStore();
    const notifications: string[] = [];
    const events: RetrievalTelemetry[] = [];
    const result = await retainedPolicy({
      config: retainConfig({
        banks: [
          codingWith({ retain: { mode: "explicit-only" } }),
          { id: "orphan", retain: { mode: "always" } },
        ],
        notifications: { retain: true },
      }),
      client: store.client,
      events,
      notifications,
    }).retain(turnEvent(), runtimeFor(tempRepo("retain-orphan-only")));

    expect(store.writes).toEqual([]);
    expect(result).toMatchObject({ queued: false, sent: 0 });
    expect(retainEvents(events)).toEqual([
      expect.objectContaining({
        status: "skipped",
        reason: "no-bank-id",
        droppedBanks: ["orphan"],
      }),
    ]);
    expect(notifications).toEqual([
      expect.stringContaining("no automatic-retain bank has a resolvable bank id"),
    ]);
  });
});

describe("retain routing degradation", () => {
  /** Decision-routed entry beside a coding entry that never writes on its own. */
  const decisionOnly = (extra: Record<string, unknown> = {}) =>
    retainConfig({
      banks: [
        codingWith({ retain: { mode: "explicit-only" } }),
        { id: "notes", bankId: "notes-bank", retain: { mode: "decision" } },
        { id: "archive", bankId: "archive-bank", retain: { mode: "decision" } },
      ],
      ...extra,
    });

  it("routes to banksFallback when no decision layer is wired", async () => {
    const store = createStore();
    const events: RetrievalTelemetry[] = [];
    const config = decisionOnly({ banksFallback: ["notes"] });

    await retainedPolicy({ config, client: store.client, events }).retain(
      turnEvent(),
      runtimeFor(tempRepo("retain-no-layer")),
    );

    expect(store.writes).toEqual(["notes-bank"]);
    expect(retainEvents(events)[0]).toMatchObject({
      status: "success",
      reason: "decision-layer-unavailable",
      bankIds: ["notes-bank"],
    });
  });

  it("reports a configured fallback id that no candidate accepts", async () => {
    const store = createStore();
    const events: RetrievalTelemetry[] = [];
    // `life` is explicit-only, so naming it in `banksFallback` must not write it,
    // and the refusal has to be visible instead of silent.
    const config = retainConfig({
      banks: [
        codingWith({ retain: { mode: "explicit-only" } }),
        { id: "life", alias: "user", bankId: "life-bank" },
        { id: "notes", bankId: "notes-bank", retain: { mode: "decision" } },
      ],
      banksFallback: ["life", "notes"],
    });

    await retainedPolicy({ config, client: store.client, events }).retain(
      turnEvent(),
      runtimeFor(tempRepo("retain-fallback-refused")),
    );

    expect(store.writes).toEqual(["notes-bank"]);
    expect(retainEvents(events)[0]).toMatchObject({
      reason: "decision-layer-unavailable",
      bankIds: ["notes-bank"],
      droppedBanks: ["life"],
    });
  });

  it("prefers decision.fallback.retainBanks over banksFallback", async () => {
    const store = createStore();
    const config = decisionOnly({
      banksFallback: ["archive"],
      decision: { fallback: { retainBanks: ["notes"] } },
    });

    await retainedPolicy({ config, client: store.client }).retain(
      turnEvent(),
      runtimeFor(tempRepo("retain-fallback-order")),
    );

    expect(store.writes).toEqual(["notes-bank"]);

    const other = createStore();
    await retainedPolicy({
      config: decisionOnly({ banksFallback: ["archive"] }),
      client: other.client,
    }).retain(turnEvent(), runtimeFor(tempRepo("retain-fallback-banks")));

    expect(other.writes).toEqual(["archive-bank"]);
  });

  it("falls back to the configured banks when the model cannot be reached", async () => {
    const store = createStore();
    const events: RetrievalTelemetry[] = [];
    const config = decisionOnly({ banksFallback: ["notes"] });
    const layer = createDecisionLayer({
      host: degradedDecisionHost(),
      getConfig: () => config,
      observer: (event) => {
        events.push(event);
      },
    });

    await retainedPolicy({ config, client: store.client, layer, events }).retain(
      turnEvent(),
      runtimeFor(tempRepo("retain-no-model")),
    );

    expect(store.writes).toEqual(["notes-bank"]);
    expect(retainEvents(events)[0]).toMatchObject({
      reason: "decision",
      bankIds: ["notes-bank"],
      decisionReason: "no-model",
    });
    // The model call itself is decision's own span, not repeated here.
    expect(
      events.some(
        (event) =>
          event.phase === "decision" && event.status === "skipped" && event.reason === "no-model",
      ),
    ).toBe(true);
  });

  it("refuses a fallback bank that is not a write candidate", async () => {
    const store = createStore();
    const events: RetrievalTelemetry[] = [];
    const notifications: string[] = [];
    // `life` is explicit-only, so a fallback that names it must be refused
    // rather than silently written.
    const withRefused = retainConfig({
      banks: [
        codingWith({ retain: { mode: "explicit-only" } }),
        { id: "notes", bankId: "notes-bank", retain: { mode: "decision" } },
        { id: "life", alias: "user", bankId: "life-bank" },
      ],
      decision: { fallback: { retainBanks: ["life"] } },
      notifications: { retain: true },
    });
    const layer = createDecisionLayer({
      host: degradedDecisionHost(),
      getConfig: () => withRefused,
    });

    await retainedPolicy({
      config: withRefused,
      client: store.client,
      layer,
      events,
      notifications,
    }).retain(turnEvent(), runtimeFor(tempRepo("retain-refused")));

    expect(store.writes).toEqual([]);
    expect(retainEvents(events)[0]).toMatchObject({
      status: "skipped",
      bankIds: [],
      droppedBanks: ["life"],
    });
    expect(notifications).toEqual([expect.stringContaining("refused life")]);

    // A fallback naming a routable entry still reaches it.
    await retainedPolicy({
      config: retainConfig({
        banks: [
          codingWith({ retain: { mode: "explicit-only" } }),
          { id: "notes", bankId: "notes-bank", retain: { mode: "decision" } },
        ],
        decision: { fallback: { retainBanks: ["notes"] } },
      }),
      client: store.client,
    }).retain(turnEvent(), runtimeFor(tempRepo("retain-fallback-kept")));

    expect(store.writes).toEqual(["notes-bank"]);
  });
});

describe("retain decision wiring through the lifecycle", () => {
  const originalHome = process.env.HOME;

  beforeEach(() => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "pi-hindsight-retain-home-"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  /** Project config that closes the setup gate, with the banks the test asks for. */
  function writeConfig(cwd: string, banks: unknown): void {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "hindsight.json"),
      JSON.stringify({
        setupComplete: true,
        hindsight: { baseUrl: "http://unused.test" },
        banks,
      }),
    );
  }

  function ctxFor(cwd: string) {
    return {
      cwd,
      ui: { setStatus: vi.fn(), notify: vi.fn() },
      sessionManager: {
        getSessionFile: () => join(cwd, "session.jsonl"),
        getSessionId: () => "session-retain-routing",
      },
    };
  }

  /** Transcript writes that reached the client, ignoring the append-capability probe. */
  function retainedBanks(): string[] {
    return (mocked.client.retain.mock.calls as unknown[][])
      .filter(([, content]) => typeof content !== "string" || !content.includes(APPEND_PROBE))
      .map(([bankId]) => (typeof bankId === "string" ? bankId : ""));
  }

  function answeringHost(answer: boolean): DecisionHost {
    const backend: DecisionBackend = {
      kind: "text",
      label: "test-backend",
      answer: async (questions) =>
        Object.fromEntries(questions.map((question) => [question.id, answer])),
    };
    return {
      kind: "pi",
      roles: false,
      resolveRole: () => undefined,
      sessionModel: () => ({ provider: "magpie", modelId: "group/labor" }),
      backends: () => [backend],
    };
  }

  it("writes the coding bank and builds no decision host without a decision entry", async () => {
    const cwd = tempRepo("retain-wiring-default");
    writeConfig(cwd, [{ id: "coding", alias: "project", bankId: "test-coding", derive: "manual" }]);
    const loadDecisionHost = vi.fn(async () => answeringHost(true));
    const lifecycle = createMemoryLifecycle(cwd, undefined, { loadDecisionHost });
    const ctx = ctxFor(cwd);

    await lifecycle.initialize(ctx);
    mocked.client.retain.mockClear();
    await lifecycle.retain(turnEvent(), ctx);

    expect(loadDecisionHost).not.toHaveBeenCalled();
    expect(retainedBanks()).toEqual(["test-coding"]);
  });

  it("builds the decision host and routes the write when an entry is decision-routed", async () => {
    const cwd = tempRepo("retain-wiring-decision");
    writeConfig(cwd, [
      { id: "coding", alias: "project", bankId: "test-coding", derive: "manual" },
      { id: "notes", bankId: "test-notes", retain: { mode: "decision" } },
    ]);
    const loadDecisionHost = vi.fn(async () => answeringHost(true));
    const events: RetrievalTelemetry[] = [];
    const lifecycle = createMemoryLifecycle(
      cwd,
      (event) => {
        events.push(event);
      },
      { loadDecisionHost },
    );
    const ctx = ctxFor(cwd);

    await lifecycle.initialize(ctx);
    mocked.client.retain.mockClear();
    await lifecycle.retain(turnEvent(), ctx);

    expect(loadDecisionHost).toHaveBeenCalledTimes(1);
    expect(retainedBanks()).toEqual(["test-coding", "test-notes"]);
    expect(retainEvents(events)).toMatchObject([
      { status: "success", reason: "decision", bankIds: ["test-coding", "test-notes"] },
    ]);
  });
});
