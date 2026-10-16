import { describe, expect, it, vi } from "vitest";
import {
  coerceBoolean,
  createClassifierBackend,
  createJudgeBackend,
} from "../extensions/decision/backends.js";
import {
  createDecisionHost,
  createRuntimeDecisionHost,
  detectHostKind,
  resolveOmpRole,
  type OmpRoleRuntime,
  type OmpJudgmentRuntime,
} from "../extensions/decision/host.js";
import { parseDecisionModelSpec, resolveDecisionModel } from "../extensions/decision/model.js";
import {
  createTextBridgeBackend,
  parseTextAnswers,
  renderTextPrompt,
  TEXT_BRIDGE_PARSE_RETRIES,
  type TextBackendLike,
} from "../extensions/decision/text-bridge.js";
import type {
  DecisionBackend,
  DecisionHost,
  DecisionQuestion,
} from "../extensions/decision/types.js";
import { collectEvents, fakeHost, recordingBackend } from "./helpers/decision.js";

const QUESTIONS: DecisionQuestion[] = [
  { id: "inject", instructions: "Inject recall this turn." },
  { id: "read:coding", instructions: "Recall should read bank coding." },
];

const MODEL = { provider: "magpie", id: "group/labor", api: "openai-completions" };
const JUDGMENT_MODEL = { provider: "magpie-decisions", id: "group/decider", api: "typesafe" };

function piContext(input: {
  registry: Record<string, unknown>;
  model?: unknown;
}): Record<string, unknown> {
  return { modelRegistry: input.registry, model: input.model ?? MODEL };
}

function ompContext(input: {
  registry: Record<string, unknown>;
  models?: unknown[];
  model?: unknown;
}): Record<string, unknown> {
  return {
    modelRegistry: input.registry,
    model: input.model ?? JUDGMENT_MODEL,
    models: {
      resolve: (spec: string) =>
        (input.models ?? []).find((candidate) => {
          const model = candidate as { provider: string; id: string };
          return (
            spec === `${model.provider}/${model.id}` || spec === model.id || spec === `@${model.id}`
          );
        }),
    },
  };
}

class FakeTextJudge {
  constructor(readonly backend: TextBackendLike) {}

  async judge(): Promise<{ answers: Record<string, unknown> }> {
    const { text } = await this.backend.complete({ system: "system", user: "user" });
    return { answers: { inject: { type: "noul", noul: text.trim() === "yes" ? 0.95 : 0.05 } } };
  }
}

function ompRuntime(overrides: Partial<OmpJudgmentRuntime> = {}): OmpJudgmentRuntime {
  return {
    isJudgmentApi: (api) => api === "typesafe",
    createNativeJudge: () => ({
      judge: async () => ({ answers: { inject: { type: "noul", noul: 0.9 } } }),
    }),
    TextJudge: FakeTextJudge,
    chatTextBackend: (): TextBackendLike => ({
      api: "openai-completions",
      provider: "magpie",
      model: "group/labor",
      complete: async () => ({ text: "yes" }),
    }),
    ...overrides,
  };
}

function kinds(backends: DecisionBackend[]): string[] {
  return backends.map((backend) => `${backend.kind}:${backend.label.split("/")[0]}`);
}

/** The settings object a session carries in the fakes. */
const ROLE_SETTINGS = { model: "group/labor" };
/** The session manager the fakes identify the running session by. */
const SESSION_MANAGER = { getSessionId: () => "session-1" };

/** One agent-registry entry: a session carrying a manager and settings. */
function agentEntry(
  sessionManager: unknown,
  settings: unknown = ROLE_SETTINGS,
): { session?: unknown } {
  return { session: { sessionManager, settings } };
}

/** What the resolver was handed; tests assert on these. */
interface RoleSpy {
  /** Kinds the host registry was asked for, in order. */
  availableKinds: string[];
  /** Role specifiers the resolver received, e.g. `@judge`. */
  specs: string[];
  settings: unknown;
}

function roleSpy(): RoleSpy {
  return { availableKinds: [], specs: [], settings: undefined };
}

/** A host registry that records the kind it is asked for; the resolution target. */
function recordingRegistry(spy: RoleSpy): Record<string, unknown> {
  return {
    getAvailable: (kind?: string) => {
      spy.availableKinds.push(kind ?? "<none>");
      return [JUDGMENT_MODEL];
    },
    getDiscoverableProviders: () => [],
    refresh: () => undefined,
    // The ladder needs a handle for the ref the resolver returned.
    find: (provider: string, modelId: string) =>
      provider === JUDGMENT_MODEL.provider && modelId === JUDGMENT_MODEL.id
        ? JUDGMENT_MODEL
        : undefined,
  };
}

/**
 * A fake omp role runtime. `models` is what the resolver answers and `sessions`
 * is what the agent registry lists; both are the seams the fix relies on. The
 * resolver reads the registry it is handed, exactly as the real one does, so the
 * kind it asks for is observable.
 */
function roleRuntime(
  spy: RoleSpy,
  input: {
    models?: Array<{ model?: unknown }>;
    sessions?: Array<{ session?: unknown }>;
    reject?: boolean;
    withoutAgentRegistry?: boolean;
  } = {},
): OmpRoleRuntime {
  const list = () => input.sessions ?? [agentEntry(SESSION_MANAGER)];
  return {
    resolveScopedModels: async (parsed, registry, settings) => {
      const args = parsed as { models?: string[] };
      spy.specs.push(...(args.models ?? []));
      spy.settings = settings;
      registry.getAvailable();
      if (input.reject) throw new Error("resolver rejected");
      return input.models ?? [{ model: JUDGMENT_MODEL }];
    },
    ...(input.withoutAgentRegistry ? {} : { AgentRegistry: { global: () => ({ list }) } }),
  };
}

describe("decision model spec", () => {
  it("parses role and provider/model specs", () => {
    expect(parseDecisionModelSpec("role:judge")).toEqual({ kind: "role", name: "judge" });
    expect(parseDecisionModelSpec(" magpie/group/labor ")).toEqual({
      kind: "model",
      ref: { provider: "magpie", modelId: "group/labor" },
    });
    expect(parseDecisionModelSpec("magpie/group/nested-id")).toEqual({
      kind: "model",
      ref: { provider: "magpie", modelId: "group/nested-id" },
    });
  });

  it("rejects unusable specs", () => {
    for (const spec of ["", "   ", "role:", "magpie", "/labor", "magpie/"]) {
      expect(parseDecisionModelSpec(spec)).toBeUndefined();
    }
  });
});

describe("decision model resolution", () => {
  it("skips the role level on a role-less host, records telemetry, and uses the session model", async () => {
    const events = collectEvents();
    const backend = recordingBackend({});
    const host = fakeHost({
      kind: "pi",
      roles: false,
      sessionModel: () => ({ provider: "magpie", modelId: "group/labor" }),
      backends: () => [backend],
    });

    const resolved = await resolveDecisionModel({
      spec: "role:judge",
      host,
      observer: events.observer,
      started: 0,
    });

    expect(resolved?.source).toBe("session");
    expect(resolved?.ref).toEqual({ provider: "magpie", modelId: "group/labor" });
    expect(events.decisionEvents.map((event) => event.reason)).toContain("role-unsupported");
    expect(events.decisionEvents[0]?.status).toBe("skipped");
  });

  it("fails to a no-model skip when a role-less host has no session model either", async () => {
    const events = collectEvents();
    const resolved = await resolveDecisionModel({
      spec: "role:judge",
      host: fakeHost(),
      observer: events.observer,
    });
    expect(resolved).toBeUndefined();
    expect(events.decisionEvents.map((event) => event.reason)).toEqual([
      "role-unsupported",
      "no-model",
    ]);
  });

  it("uses the role table when the host has one", async () => {
    const events = collectEvents();
    const host = fakeHost({
      kind: "omp",
      roles: true,
      resolveRole: (name) =>
        name === "judge" ? { provider: "magpie-decisions", modelId: "group/decider" } : undefined,
      backends: () => [recordingBackend({})],
    });
    const resolved = await resolveDecisionModel({
      spec: "role:judge",
      host,
      observer: events.observer,
    });
    expect(resolved?.source).toBe("role");
    expect(events.decisionEvents.some((event) => event.reason === "role-unsupported")).toBe(false);
  });

  it("records an unresolvable role and falls through to the session model", async () => {
    const events = collectEvents();
    const host = fakeHost({
      kind: "omp",
      roles: true,
      resolveRole: () => undefined,
      sessionModel: () => ({ provider: "magpie", modelId: "group/labor" }),
      backends: () => [recordingBackend({})],
    });
    const resolved = await resolveDecisionModel({
      spec: "role:judge",
      host,
      observer: events.observer,
    });
    expect(resolved?.source).toBe("session");
    expect(events.decisionEvents.map((event) => event.reason)).toContain("role-unresolved");
  });

  it("records unusable specs and empty ladders", async () => {
    const events = collectEvents();
    expect(
      await resolveDecisionModel({ spec: "nope", host: fakeHost(), observer: events.observer }),
    ).toBeUndefined();
    expect(
      await resolveDecisionModel({
        spec: "magpie/group/labor",
        host: fakeHost({ backends: () => [] }),
        observer: events.observer,
      }),
    ).toBeUndefined();
    expect(events.decisionEvents.map((event) => event.reason)).toEqual([
      "invalid-model-spec",
      "no-backend",
    ]);
  });
});

describe("host detection and ladders", () => {
  it("detects omp by its model query facade and pi by its registry", () => {
    expect(detectHostKind({ models: { resolve: () => undefined } })).toBe("omp");
    expect(detectHostKind({ modelRegistry: {} })).toBe("pi");
    expect(detectHostKind({})).toBe("unknown");
    expect(detectHostKind(undefined)).toBe("unknown");
  });

  it("offers the native judgment rung then the text rung for a judgment-api model", () => {
    const host = createDecisionHost({
      ctx: ompContext({ registry: {}, models: [JUDGMENT_MODEL] }),
      runtime: ompRuntime(),
    });
    expect(host.kind).toBe("omp");
    expect(host.roles).toBe(true);
    expect(
      kinds(host.backends({ provider: "magpie-decisions", modelId: "group/decider" })),
    ).toEqual(["native-judge:judgment", "text:text"]);
  });

  it("offers only the text rung for a chat model and no rung for an on-device model", () => {
    const host = createDecisionHost({
      ctx: ompContext({
        registry: {},
        models: [MODEL, { provider: "local", id: "tiny", api: "local-inference" }],
      }),
      runtime: ompRuntime(),
    });
    expect(kinds(host.backends({ provider: "magpie", modelId: "group/labor" }))).toEqual([
      "text:text",
    ]);
    expect(host.backends({ provider: "local", modelId: "tiny" })).toEqual([]);
  });

  it("falls back to the bridge rung when the host ships no text judge", () => {
    const host = createDecisionHost({
      ctx: ompContext({ registry: {}, models: [MODEL] }),
      // No text judge and no chat backend: the bridge over one-shot completion is left.
      runtime: {
        isJudgmentApi: () => false,
        createNativeJudge: () => ({ judge: async () => ({ answers: {} }) }),
        completeSimple: async () => ({ content: [{ type: "text", text: "yes" }] }),
      },
    });
    expect(kinds(host.backends({ provider: "magpie", modelId: "group/labor" }))).toEqual([
      "text:bridge",
    ]);
  });

  it("offers no rung when the omp runtime is missing", () => {
    const host = createDecisionHost({ ctx: ompContext({ registry: {}, models: [MODEL] }) });
    expect(host.backends({ provider: "magpie", modelId: "group/labor" })).toEqual([]);
  });

  it("resolves both spec shapes on both hosts", async () => {
    const pi = createDecisionHost({
      ctx: piContext({
        registry: {
          find: (provider: string, modelId: string) =>
            provider === MODEL.provider && modelId === MODEL.id ? MODEL : undefined,
          complete: async () => ({
            content: [{ type: "text", text: '{"answers":{"inject":true}}' }],
          }),
        },
      }),
    });
    const omp = createDecisionHost({
      ctx: ompContext({ registry: {}, models: [MODEL, JUDGMENT_MODEL] }),
      runtime: ompRuntime(),
    });
    for (const host of [pi, omp]) {
      const viaModel = await resolveDecisionModel({ spec: "magpie/group/labor", host });
      expect(viaModel?.ref).toEqual({ provider: "magpie", modelId: "group/labor" });
      expect(viaModel?.source).toBe("model");
      expect(viaModel?.backends.length).toBeGreaterThan(0);
    }
    // pi has no role table, so the role spec reaches the session model; omp resolves the role.
    expect((await resolveDecisionModel({ spec: "role:judge", host: pi }))?.source).toBe("session");
    expect((await resolveDecisionModel({ spec: "role:group/decider", host: omp }))?.source).toBe(
      "role",
    );
  });
});

describe("omp rungs", () => {
  it("answers the question table through a native judge", async () => {
    const runtime = ompRuntime({
      isJudgmentApi: () => true,
      createNativeJudge: () => ({
        judge: async (request) => {
          const answers: Record<string, unknown> = {};
          for (const id of Object.keys(request.questions)) {
            answers[id] = { type: "noul", noul: id === "inject" ? 0.8 : 0.1 };
          }
          return { answers };
        },
      }),
    });
    const host = createDecisionHost({
      ctx: ompContext({ registry: {}, models: [JUDGMENT_MODEL] }),
      runtime,
    });
    const [native] = host.backends({ provider: "magpie-decisions", modelId: "group/decider" });
    const answers = await native!.answer(QUESTIONS, "state", { maxTokens: 64 });
    expect(answers).toEqual({ inject: true, "read:coding": false });
  });

  it("answers through the text judge when the host ships one", async () => {
    const host = createDecisionHost({
      ctx: ompContext({ registry: {}, models: [MODEL] }),
      runtime: ompRuntime(),
    });
    const [text] = host.backends({ provider: "magpie", modelId: "group/labor" });
    expect(text!.kind).toBe("text");
    expect(await text!.answer(QUESTIONS, "state", { maxTokens: 64 })).toEqual({ inject: true });
  });

  it("passes the credential resolver and model headers to the native judge", async () => {
    const seen: unknown[] = [];
    const runtime = ompRuntime({
      isJudgmentApi: () => true,
      createNativeJudge: (_model, connection) => {
        seen.push(connection);
        return { judge: async () => ({ answers: { inject: { noul: 1 } } }) };
      },
    });
    const host = createDecisionHost({
      ctx: ompContext({
        registry: {
          resolver: () => "resolved-key",
          resolveModelHeaders: async () => ({ "x-proxy": "1" }),
        },
        models: [JUDGMENT_MODEL],
      }),
      runtime,
      sessionId: "session-1",
    });
    const [native] = host.backends({ provider: "magpie-decisions", modelId: "group/decider" });
    await native!.answer(QUESTIONS, "state", { maxTokens: 64 });
    expect(seen).toEqual([{ apiKey: "resolved-key", headers: { "x-proxy": "1" } }]);
  });
});

describe("pi rungs", () => {
  it("offers classifier then text, and reads classifier answers", async () => {
    const host = createDecisionHost({
      ctx: piContext({
        registry: {
          find: () => MODEL,
          classify: async () => ({ answers: { inject: { type: "bool", value: true } } }),
          complete: async () => ({
            content: [{ type: "text", text: '{"answers":{"inject":false,"read:coding":true}}' }],
          }),
        },
      }),
    });
    const rungs = host.backends({ provider: "magpie", modelId: "group/labor" });
    expect(rungs.map((rung) => rung.kind)).toEqual(["classifier", "text"]);
    expect(await rungs[0]!.answer(QUESTIONS, "state", { maxTokens: 64 })).toEqual({ inject: true });
    expect(await rungs[1]!.answer(QUESTIONS, "state", { maxTokens: 64 })).toEqual({
      inject: false,
      "read:coding": true, // the text rung never had to answer the bank gate here
    });
  });

  it("offers only the text rung when the host has no classifier", async () => {
    const host = createDecisionHost({
      ctx: piContext({
        registry: {
          find: () => MODEL,
          complete: async () => ({ content: [{ type: "text", text: "{}" }] }),
        },
      }),
    });
    expect(
      host.backends({ provider: "magpie", modelId: "group/labor" }).map((rung) => rung.kind),
    ).toEqual(["text"]);
  });

  it("offers no rung for a model the registry cannot find", () => {
    const host = createDecisionHost({ ctx: piContext({ registry: { find: () => undefined } }) });
    expect(host.backends({ provider: "ghost", modelId: "ghost" })).toEqual([]);
  });

  it("reports no answers when a classifier response is unreadable", async () => {
    const host = createDecisionHost({
      ctx: piContext({ registry: { find: () => MODEL, classify: async () => "not a table" } }),
    });
    const [classifier] = host.backends({ provider: "magpie", modelId: "group/labor" });
    expect(await classifier!.answer(QUESTIONS, "state", { maxTokens: 64 })).toEqual({});
  });
});

describe("text bridge", () => {
  it("renders the question table and the state", () => {
    const prompt = renderTextPrompt(QUESTIONS, "# State\nbody");
    expect(prompt.user).toContain("inject: Inject recall this turn.");
    expect(prompt.user).toContain("read:coding: Recall should read bank coding.");
    expect(prompt.system).toContain("JSON");
  });

  it("parses fenced, wrapped, and flat replies", () => {
    expect(parseTextAnswers('{"answers":{"inject":true}}', ["inject"])).toEqual({ inject: true });
    expect(parseTextAnswers('```json\n{"inject":"no"}\n```', ["inject"])).toEqual({
      inject: false,
    });
    expect(parseTextAnswers('Sure: {"inject":1} done', ["inject"])).toEqual({ inject: true });
    expect(parseTextAnswers("no json here", ["inject"])).toBeUndefined();
    expect(
      parseTextAnswers('{"answers":{"inject":true}}', ["inject", "read:coding"]),
    ).toBeUndefined();
  });

  it("retries the parse failure and then fails the rung", async () => {
    let calls = 0;
    const backend = createTextBridgeBackend(
      async () => {
        calls += 1;
        return "I cannot answer that.";
      },
      { label: "bridge" },
    );
    await expect(backend.answer(QUESTIONS, "state", { maxTokens: 64 })).rejects.toThrow(
      /did not answer every question/u,
    );
    expect(calls).toBe(TEXT_BRIDGE_PARSE_RETRIES + 1);
  });

  it("recovers on a retry after a malformed first reply", async () => {
    const replies = ["hmm", '{"answers":{"inject":true}}'];
    const backend = createTextBridgeBackend(async () => replies.shift() ?? "", { label: "bridge" });
    expect(await backend.answer([QUESTIONS[0]!], "state", { maxTokens: 64 })).toEqual({
      inject: true,
    });
  });
});

describe("answer coercion", () => {
  it("reads probabilities, typed answers, booleans, and words", () => {
    expect(coerceBoolean(0.51)).toBe(true);
    expect(coerceBoolean(0.49)).toBe(false);
    expect(coerceBoolean(true)).toBe(true);
    expect(coerceBoolean("YES")).toBe(true);
    expect(coerceBoolean("0")).toBe(false);
    expect(coerceBoolean({ type: "noul", noul: 0.7 })).toBe(true);
    expect(coerceBoolean({ answer: { value: false } })).toBe(false);
    expect(coerceBoolean("maybe")).toBeUndefined();
    expect(coerceBoolean({})).toBeUndefined();
    expect(coerceBoolean(Number.NaN)).toBeUndefined();
    expect(coerceBoolean(null)).toBeUndefined();
  });

  it("uses the default 0.5 threshold when none is passed", () => {
    expect(coerceBoolean(0.5)).toBe(true);
    expect(coerceBoolean(0.499)).toBe(false);
  });

  it("moves the yes point with a configured threshold", () => {
    // A stricter gate: a weak probability is no longer a yes.
    expect(coerceBoolean(0.6, 0.9)).toBe(false);
    expect(coerceBoolean(0.9, 0.9)).toBe(true);
    // A looser gate: a weak probability now counts.
    expect(coerceBoolean(0.3, 0.2)).toBe(true);
  });

  it("applies the threshold inside a nested answer object", () => {
    expect(coerceBoolean({ type: "noul", noul: 0.7 }, 0.9)).toBe(false);
    expect(coerceBoolean({ type: "noul", noul: 0.95 }, 0.9)).toBe(true);
  });

  it("keeps an unanswered question undefined instead of guessing", async () => {
    const backend = createJudgeBackend({
      judge: { judge: async () => ({ answers: { inject: { noul: 0.9 } } }) },
      kind: "native-judge",
      label: "judgment",
    });
    expect(await backend.answer(QUESTIONS, "state", { maxTokens: 32 })).toEqual({
      inject: true,
      "read:coding": undefined,
    });
  });

  it("maps classifier answer tables and tolerates junk", async () => {
    const backend = createClassifierBackend({
      classify: async () => ({ answers: { "read:coding": { answer: "yes" } } }),
      label: "classify",
    });
    expect(await backend.answer(QUESTIONS, "state", { maxTokens: 32 })).toEqual({
      inject: undefined,
      "read:coding": true,
    });
    const junk = createClassifierBackend({ classify: async () => undefined, label: "classify" });
    expect(await junk.answer(QUESTIONS, "state", { maxTokens: 32 })).toEqual({});
  });
});

describe("host adapters stay isolated", () => {
  it("returns an empty ladder when host lookups throw", () => {
    const host: DecisionHost = createDecisionHost({
      ctx: piContext({
        registry: {
          find: () => {
            throw new Error("registry exploded");
          },
        },
      }),
    });
    expect(host.backends({ provider: "magpie", modelId: "group/labor" })).toEqual([]);
  });

  it("ignores a role lookup that throws and tries the alias form", async () => {
    const host = createDecisionHost({
      ctx: {
        modelRegistry: {},
        model: MODEL,
        models: {
          resolve: (spec: string) => {
            if (spec === "judge") throw new Error("unknown role");
            return spec === "@judge" ? MODEL : undefined;
          },
        },
      },
      runtime: ompRuntime(),
      // No scoped resolver: this path is the facade fallback, not the host.
      loadRoleRuntime: async () => undefined,
    });
    await expect(host.resolveRole("judge")).resolves.toEqual({
      provider: "magpie",
      modelId: "group/labor",
    });
  });
});

describe("omp scoped role resolution", () => {
  it("resolves a judge role through the scoped resolver and asks for every kind", async () => {
    const spy = roleSpy();
    const ref = await resolveOmpRole({
      role: "judge",
      registry: recordingRegistry(spy) as never,
      sessionManager: SESSION_MANAGER,
      runtime: roleRuntime(spy),
    });

    // The role reaches the resolver as its `@` alias form, and the judge model
    // comes back even though it is not a chat model.
    expect(ref).toEqual({ provider: JUDGMENT_MODEL.provider, modelId: JUDGMENT_MODEL.id });
    expect(spy.specs).toEqual(["@judge"]);
    // The core of the upstream fix: a bare `getAvailable()` would default to
    // `chat` and hide the judge model.
    expect(spy.availableKinds).toEqual(["all"]);
    expect(spy.settings).toEqual(ROLE_SETTINGS);
  });

  it("resolves the native-judge rung for a role-resolved judge model", async () => {
    const spy = roleSpy();
    const host = createDecisionHost({
      ctx: {
        modelRegistry: recordingRegistry(spy),
        model: MODEL,
        sessionManager: SESSION_MANAGER,
        models: { resolve: () => undefined },
      },
      runtime: ompRuntime(),
      loadRoleRuntime: async () => roleRuntime(spy),
    });

    const resolved = await resolveDecisionModel({ spec: "role:judge", host });
    expect(resolved?.source).toBe("role");
    expect(resolved?.ref).toEqual({
      provider: JUDGMENT_MODEL.provider,
      modelId: JUDGMENT_MODEL.id,
    });
    expect(resolved?.backends.map((backend) => backend.kind)).toEqual(["native-judge", "text"]);
  });

  it("falls back to the facade when no session matches the session manager", async () => {
    const spy = roleSpy();
    const host = createDecisionHost({
      ctx: {
        modelRegistry: recordingRegistry(spy),
        model: MODEL,
        sessionManager: SESSION_MANAGER,
        models: {
          resolve: (spec: string) => (spec === "@judge" ? JUDGMENT_MODEL : undefined),
        },
      },
      runtime: ompRuntime(),
      // The registry lists only a different session, so no settings are found.
      loadRoleRuntime: async () => roleRuntime(spy, { sessions: [agentEntry({ other: true })] }),
    });

    // The resolver was never consulted; the facade answered instead.
    expect(spy.specs).toEqual([]);
    await expect(host.resolveRole("judge")).resolves.toEqual({
      provider: JUDGMENT_MODEL.provider,
      modelId: JUDGMENT_MODEL.id,
    });
  });

  it("falls back to the facade when the host ships no scoped resolver", async () => {
    const host = createDecisionHost({
      ctx: {
        modelRegistry: { getAvailable: () => [] },
        model: MODEL,
        sessionManager: SESSION_MANAGER,
        models: { resolve: (spec: string) => (spec === "@judge" ? JUDGMENT_MODEL : undefined) },
      },
      runtime: ompRuntime(),
      loadRoleRuntime: async () => undefined,
    });

    await expect(host.resolveRole("judge")).resolves.toEqual({
      provider: JUDGMENT_MODEL.provider,
      modelId: JUDGMENT_MODEL.id,
    });
  });

  it("falls back to the facade when the agent registry is missing from the module", async () => {
    const spy = roleSpy();
    const host = createDecisionHost({
      ctx: {
        modelRegistry: recordingRegistry(spy),
        model: MODEL,
        sessionManager: SESSION_MANAGER,
        models: { resolve: (spec: string) => (spec === "@judge" ? JUDGMENT_MODEL : undefined) },
      },
      runtime: ompRuntime(),
      loadRoleRuntime: async () => roleRuntime(spy, { withoutAgentRegistry: true }),
    });

    expect(spy.specs).toEqual([]);
    await expect(host.resolveRole("judge")).resolves.toEqual({
      provider: JUDGMENT_MODEL.provider,
      modelId: JUDGMENT_MODEL.id,
    });
  });

  it("degrades to undefined, without throwing, when every level fails", async () => {
    for (const runtime of [
      // A resolver that rejects.
      roleRuntime(roleSpy(), { reject: true }),
      // A resolver that answers nothing.
      roleRuntime(roleSpy(), { models: [] }),
      roleRuntime(roleSpy(), { models: [{ model: undefined }] }),
    ]) {
      const spy = roleSpy();
      const host = createDecisionHost({
        ctx: {
          modelRegistry: recordingRegistry(spy),
          model: MODEL,
          sessionManager: SESSION_MANAGER,
          // A facade that never resolves, so the chain must end at undefined.
          models: { resolve: () => undefined },
        },
        runtime: ompRuntime(),
        loadRoleRuntime: async () => runtime,
      });
      await expect(host.resolveRole("judge")).resolves.toBeUndefined();
    }
  });

  it("degrades to undefined when the role runtime itself cannot be loaded", async () => {
    const host = createDecisionHost({
      ctx: {
        modelRegistry: { getAvailable: () => [] },
        model: MODEL,
        models: { resolve: () => undefined },
      },
      runtime: ompRuntime(),
      loadRoleRuntime: async () => {
        throw new Error("module exploded");
      },
    });

    await expect(host.resolveRole("judge")).resolves.toBeUndefined();
  });

  it("falls back to the session model when a role resolves to nothing", async () => {
    const events = collectEvents();
    const host = createDecisionHost({
      ctx: {
        modelRegistry: {
          getAvailable: () => [],
          find: (provider: string, modelId: string) =>
            provider === MODEL.provider && modelId === MODEL.id ? MODEL : undefined,
        },
        model: MODEL,
        sessionManager: SESSION_MANAGER,
        models: { resolve: () => undefined },
      },
      runtime: ompRuntime(),
      loadRoleRuntime: async () => roleRuntime(roleSpy(), { models: [] }),
    });

    const resolved = await resolveDecisionModel({
      spec: "role:judge",
      host,
      observer: events.observer,
    });
    // The role level was tried and missed, so the session model takes over.
    expect(resolved?.source).toBe("session");
    expect(events.decisionEvents.map((event) => event.reason)).toContain("role-unresolved");
  });
});

describe("pi never loads omp surfaces", () => {
  it("keeps roles disabled and reaches no omp role module", async () => {
    const loadRoleRuntime = vi.fn(async () => roleRuntime(roleSpy()));
    const host = await createRuntimeDecisionHost({
      ctx: {
        model: MODEL,
        modelRegistry: {
          find: () => MODEL,
          complete: async () => ({ role: "assistant", content: "yes" }),
        },
      },
      loadRoleRuntime,
    });

    expect(host.kind).toBe("pi");
    expect(host.roles).toBe(false);
    const resolved = await resolveDecisionModel({ spec: "role:judge", host });
    expect(resolved?.source).toBe("session");
    // The pi host has no role path at all, so the loader was never invoked.
    expect(loadRoleRuntime).not.toHaveBeenCalled();
  });
});
