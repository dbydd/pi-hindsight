import { describe, expect, it } from "vitest";
import { createDecisionHost } from "../extensions/decision/host.js";
import type { DecisionHost } from "../extensions/decision/types.js";
import { DEFAULT_CONFIG } from "../extensions/config/config-defaults.js";
import { normalizeConfig } from "../extensions/config/config-normalize.js";
import type { ResolvedConfig } from "../extensions/types.js";

/** pi is detected by its registry and omp by its model facade. */
function piHost(systemOne: unknown): DecisionHost {
  return createDecisionHost({
    ctx: {
      modelRegistry: { find: () => ({ provider: "magpie", id: "group/decider", api: "typesafe" }) },
    },
    getSystemOne: () => systemOne as never,
  });
}

function rungsOf(host: DecisionHost): string[] {
  const model = { provider: "magpie", modelId: "group/decider" };
  return host.backends(model).map((rung) => `${rung.kind}/${rung.label}`);
}

describe("systemOne rung placement", () => {
  it("adds no rung when the transport is disabled", () => {
    const host = piHost(DEFAULT_CONFIG.decision.systemOne);
    expect(rungsOf(host)).toEqual([]);
  });

  it("adds no rung when the section is missing", () => {
    expect(rungsOf(piHost(undefined))).toEqual([]);
  });

  it("runs before the text bridge on pi", () => {
    const registry = {
      find: () => ({ provider: "magpie", id: "group/decider", api: "typesafe" }),
      complete: async () => ({}),
    };
    const host = createDecisionHost({
      ctx: { modelRegistry: registry },
      getSystemOne: () =>
        ({ enabled: true, baseUrl: "http://127.0.0.1:3425", model: "group/decider" }) as never,
    });
    expect(rungsOf(host)).toEqual([
      "systemone/systemone/group/decider",
      "text/bridge/magpie/group/decider",
    ]);
  });

  it("runs before the text bridge on omp and after the native judgment rung", () => {
    const runtime = {
      isJudgmentApi: () => true,
      createNativeJudge: () => ({ judge: async () => ({ answers: {} }) }),
      completeSimple: async () => ({ content: "" }),
    };
    const host = createDecisionHost({
      ctx: {
        models: { resolve: () => undefined },
        modelRegistry: {
          find: () => ({ provider: "magpie", id: "group/decider", api: "typesafe" }),
        },
      },
      runtime,
      getSystemOne: () =>
        ({ enabled: true, baseUrl: "http://127.0.0.1:3425", model: "group/decider" }) as never,
    });
    expect(rungsOf(host)).toEqual([
      "native-judge/judgment/magpie/group/decider",
      "systemone/systemone/group/decider",
      "text/bridge/magpie/group/decider",
    ]);
  });
});

describe("systemOne config normalization", () => {
  function normalize(systemOne: unknown): ResolvedConfig["decision"]["systemOne"] {
    const config = {
      ...DEFAULT_CONFIG,
      decision: { ...DEFAULT_CONFIG.decision, systemOne },
    } as ResolvedConfig;
    return normalizeConfig(config, { decision: { systemOne } }).decision.systemOne;
  }

  it("defaults to disabled with the local gateway and its decision group", () => {
    const config = { ...DEFAULT_CONFIG } as ResolvedConfig;
    expect(normalizeConfig(config, {}).decision.systemOne).toEqual({
      enabled: false,
      baseUrl: "http://127.0.0.1:3425",
      model: "group/decider",
    });
  });

  it("keeps written values and a usable env var name", () => {
    expect(
      normalize({
        enabled: true,
        baseUrl: "http://gateway:9000",
        model: "group/other",
        apiKeyEnvVar: "GATEWAY_KEY",
      }),
    ).toEqual({
      enabled: true,
      baseUrl: "http://gateway:9000",
      model: "group/other",
      apiKeyEnvVar: "GATEWAY_KEY",
    });
  });

  it("drops an env var name that is not a valid identifier", () => {
    expect(normalize({ enabled: true, apiKeyEnvVar: "not a name" })).toEqual({
      enabled: true,
      baseUrl: "http://127.0.0.1:3425",
      model: "group/decider",
    });
  });

  it("falls back to the defaults for unusable endpoint and model values", () => {
    expect(normalize({ enabled: true, baseUrl: "", model: 42 })).toEqual({
      enabled: true,
      baseUrl: "http://127.0.0.1:3425",
      model: "group/decider",
    });
  });
});
