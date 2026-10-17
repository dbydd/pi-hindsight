import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../extensions/config/config.js";
import { codingBankEntry, userBankEntry } from "../extensions/config/banks.js";
import { snapshotRuntime } from "../extensions/lifecycle/memory-lifecycle-runtime.js";
import { subagentProfileName } from "../extensions/utils/agent-profile.js";

/** A repo with a project `.omp` dir, plus an isolated global agent dir. */
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hindsight-subagent-"));
  const agentDir = mkdtempSync(join(tmpdir(), "pi-hindsight-agent-"));
  mkdirSync(join(cwd, ".omp"));
  return {
    cwd,
    env: { PI_CONFIG_DIR: ".omp", PI_CODING_AGENT_DIR: agentDir } as NodeJS.ProcessEnv,
    global: (name: string, value: unknown) =>
      writeFileSync(join(agentDir, `${name}.json`), JSON.stringify(value)),
    project: (name: string, value: unknown) =>
      writeFileSync(join(cwd, ".omp", `${name}.json`), JSON.stringify(value)),
  };
}

describe("subagent profile layers", () => {
  it("applies a matching profile and leaves an unmatched one on hindsight.json", () => {
    const f = fixture();
    f.project("hindsight", { recall: { maxTokens: 111 }, retain: { updateMode: "replace" } });
    f.project("hindsight-subagent", {
      profiles: {
        engineer: { recall: { maxTokens: 222 } },
      },
    });

    const engineer = resolveConfig(f.cwd, f.env, undefined, "engineer");
    const theorist = resolveConfig(f.cwd, f.env, undefined, "theorist");

    expect(engineer.recall.maxTokens).toBe(222);
    expect(engineer.retain.updateMode).toBe("replace");
    expect(theorist.recall.maxTokens).toBe(111);
  });

  it("ignores the profile file for a main session", () => {
    const f = fixture();
    f.project("hindsight", { recall: { maxTokens: 111 } });
    f.project("hindsight-subagent", {
      profiles: { engineer: { recall: { maxTokens: 999 } } },
    });

    expect(resolveConfig(f.cwd, f.env).recall.maxTokens).toBe(111);
  });

  it("keeps project hindsight above a global subagent profile", () => {
    const f = fixture();
    f.global("hindsight-subagent", {
      profiles: { engineer: { recall: { maxTokens: 300 }, decision: { threshold: 0.9 } } },
    });
    f.project("hindsight", { recall: { maxTokens: 200 } });

    const config = resolveConfig(f.cwd, f.env, undefined, "engineer");

    expect(config.recall.maxTokens).toBe(200);
    expect(config.decision.threshold).toBe(0.9);
  });

  it("keeps project hindsight above a project subagent profile only where the profile speaks", () => {
    const f = fixture();
    f.project("hindsight", { recall: { maxTokens: 200, topK: 7 } });
    f.project("hindsight-subagent", { profiles: { engineer: { recall: { maxTokens: 50 } } } });

    const config = resolveConfig(f.cwd, f.env, undefined, "engineer");

    expect(config.recall.maxTokens).toBe(50);
    expect(config.recall.topK).toBe(7);
  });

  it("merges banks by id so a profile changes one entry and keeps the rest", () => {
    const f = fixture();
    f.project("hindsight", {
      banks: [
        { id: "coding", alias: "project", bankId: "main-bank" },
        { id: "research", bankId: "research-bank", access: "read" },
        { id: "life", alias: "user", bankId: "life-bank" },
      ],
    });
    f.project("hindsight-subagent", {
      profiles: {
        engineer: {
          banks: [
            { id: "coding", bankId: "engineer-bank" },
            { id: "research", enabled: false },
          ],
        },
      },
    });

    const config = resolveConfig(f.cwd, f.env, undefined, "engineer");

    expect(codingBankEntry(config)?.bankId).toBe("engineer-bank");
    expect(config.banks.find((entry) => entry.id === "research")).toMatchObject({
      bankId: "research-bank",
      access: "read",
      enabled: false,
    });
    expect(userBankEntry(config)?.bankId).toBe("life-bank");
  });

  it("ignores a profile file with no profiles map", () => {
    const f = fixture();
    f.project("hindsight", { recall: { maxTokens: 111 } });
    f.project("hindsight-subagent", { recall: { maxTokens: 999 } });

    expect(resolveConfig(f.cwd, f.env, undefined, "engineer").recall.maxTokens).toBe(111);
  });
});

describe("subagentProfileName", () => {
  it("reads the omp subagent name", () => {
    expect(subagentProfileName({ agent: { kind: "sub", name: "Engineer" } })).toBe("Engineer");
  });

  it("returns nothing for a main session, a pi context, or a blank name", () => {
    expect(subagentProfileName({ agent: { kind: "main", name: "main" } })).toBeUndefined();
    expect(subagentProfileName({ cwd: "/repo", modelRegistry: {} })).toBeUndefined();
    expect(subagentProfileName({ agent: { kind: "sub", name: "  " } })).toBeUndefined();
    expect(subagentProfileName(undefined)).toBeUndefined();
  });
});

describe("runtime snapshot", () => {
  const ui = { setStatus: () => undefined, notify: () => undefined };

  it("carries the subagent profile into the session runtime", () => {
    const runtime = snapshotRuntime({
      cwd: "/repo",
      ui,
      agent: { kind: "sub", name: "engineer" },
    });
    expect(runtime?.agentName).toBe("engineer");
  });

  it("leaves the profile off a main session", () => {
    const runtime = snapshotRuntime({ cwd: "/repo", ui, agent: { kind: "main", name: "main" } });
    expect(runtime).not.toHaveProperty("agentName");
  });
});
