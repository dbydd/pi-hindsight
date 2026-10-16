import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Ladder semantics, driven by stubbing the host module reads.
 *
 * The first judgment candidate and the last role candidate are deliberately never
 * stubbed: no `@oh-my-pi/*` package exists in any tree this suite runs in, so those
 * rungs fail to resolve for real. That is what proves a *missing* module continues
 * down the ladder; the stubs cover the other answers — a resolved module with the
 * right shape, one with the wrong shape, and nothing at all.
 *
 * `vi.doMock` rather than `vi.mock`: the stubs change per case, and only a
 * do-mock plus a fresh import re-runs the factory.
 */

const JUDGMENT_RUNG = {
  isJudgmentApi: () => false,
  createNativeJudge: () => ({ judge: async () => ({ answers: {} }) }),
  rung: "pi-coding-agent/judgment",
};

/** A module that resolves but cannot serve the judgment surface. */
const WRONG_JUDGMENT_SHAPE = { rung: "wrong" };

const ROLE_ROOT_RUNG = { resolveScopedModels: async () => [], rung: "pi-coding-agent" };
const ROLE_SUB_RUNG = {
  resolveScopedModels: async () => [],
  rung: "registry/agent-registry",
};

afterEach(() => {
  vi.doUnmock("@oh-my-pi/pi-coding-agent/judgment");
  vi.doUnmock("@oh-my-pi/pi-coding-agent");
  vi.doUnmock("@oh-my-pi/pi-coding-agent/registry/agent-registry");
  vi.resetModules();
});

async function host(): Promise<typeof import("../extensions/decision/host.js")> {
  vi.resetModules();
  return await import("../extensions/decision/host.js");
}

describe("judgment ladder", () => {
  it("continues past a missing candidate and returns the next one", async () => {
    vi.doMock("@oh-my-pi/pi-coding-agent/judgment", () => JUDGMENT_RUNG);
    const { loadOmpJudgmentRuntime: load } = await host();
    await expect(load()).resolves.toMatchObject({ rung: "pi-coding-agent/judgment" });
  });

  it("steps past a resolved module whose shape is wrong", async () => {
    vi.doMock("@oh-my-pi/pi-coding-agent/judgment", () => WRONG_JUDGMENT_SHAPE);
    const { loadOmpJudgmentRuntime: load } = await host();
    await expect(load()).resolves.toBeUndefined();
  });

  it("matches the pi-ai rung when the host ships it", async () => {
    vi.doMock("@oh-my-pi/pi-ai/judgment", () => ({
      ...JUDGMENT_RUNG,
      rung: "pi-ai/judgment",
    }));
    vi.doMock("@oh-my-pi/pi-coding-agent/judgment", () => JUDGMENT_RUNG);
    const { loadOmpJudgmentRuntime: load } = await host();
    // Both stubs answer; the first winner proves the ladder returns on the first
    // usable rung instead of collecting every candidate.
    await expect(load()).resolves.toMatchObject({ rung: "pi-ai/judgment" });
  });
});

describe("role ladder", () => {
  it("stops at the first candidate that has the shape", async () => {
    vi.doMock("@oh-my-pi/pi-coding-agent", () => ROLE_ROOT_RUNG);
    vi.doMock("@oh-my-pi/pi-coding-agent/registry/agent-registry", () => ROLE_SUB_RUNG);
    const { loadOmpRoleRuntime: load } = await host();
    await expect(load()).resolves.toMatchObject({ rung: "pi-coding-agent" });
  });

  it("steps past a resolved module whose shape is wrong", async () => {
    vi.doMock("@oh-my-pi/pi-coding-agent", () => ({}));
    vi.doMock("@oh-my-pi/pi-coding-agent/registry/agent-registry", () => ROLE_SUB_RUNG);
    const { loadOmpRoleRuntime: load } = await host();
    await expect(load()).resolves.toMatchObject({ rung: "registry/agent-registry" });
  });

  it("is undefined when no candidate resolves or has the shape", async () => {
    vi.doMock("@oh-my-pi/pi-coding-agent", () => ({}));
    vi.doMock("@oh-my-pi/pi-coding-agent/registry/agent-registry", () => ({}));
    const { loadOmpRoleRuntime: load } = await host();
    await expect(load()).resolves.toBeUndefined();
  });
});

/**
 * A bare `resolveOmpRole({role, registry, sessionManager})` — no `runtime`, no
 * `load` — must reach the production loader. Reading the absent override as "no
 * runtime" made this call answer nothing, which reads as a broken ladder rather
 * than a left-out argument.
 */
describe("resolveOmpRole with no override", () => {
  it("resolves through the production loader", async () => {
    const sessionManager = {};
    const settings = { model: "@judge" };
    let seenSpecs: string[] = [];

    vi.doMock("@oh-my-pi/pi-coding-agent", () => ({
      resolveScopedModels: async (parsed: unknown, _registry: unknown, read: unknown) => {
        seenSpecs = (parsed as { models?: string[] }).models ?? [];
        expect(read).toBe(settings);
        return [{ model: { provider: "magpie-decisions", id: "group/decider" } }];
      },
      AgentRegistry: {
        global: () => ({ list: () => [{ session: { sessionManager, settings } }] }),
      },
    }));

    const { resolveOmpRole } = await host();
    await expect(
      resolveOmpRole({
        role: "judge",
        registry: { getAvailable: () => [] },
        sessionManager,
      }),
    ).resolves.toEqual({ provider: "magpie-decisions", modelId: "group/decider" });
    // The role arrives as its `@` alias and the settings came from this session's
    // registry entry, so the whole production path ran rather than a shortcut.
    expect(seenSpecs).toEqual(["@judge"]);
  });
});
