import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Stand-in host probe: an omp-like rebrand whose config dir is `.omp` and whose agent
// dir is discoverable only through the host package. `probe.agentDir` is set per test so
// the stubbed host can point at a real temp directory.
const probe = vi.hoisted(() => ({ agentDir: "" }));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  CONFIG_DIR_NAME: ".omp",
  getAgentDir: () => probe.agentDir,
}));

import {
  globalConfigBasePath,
  hostConfigDirName,
  projectConfigBasePath,
  projectStateDir,
  resolveAgentDir,
} from "../extensions/config/paths.js";
import { resolveConfig } from "../extensions/config/config.js";
import { DEFAULT_CONFIG } from "../extensions/config/config-defaults.js";

describe("host config dir probe", () => {
  it("uses the host package's config dir name", () => {
    expect(hostConfigDirName()).toBe(".omp");
  });

  it("prefers an explicit agent dir from the env it was handed", () => {
    expect(resolveAgentDir({ PI_CODING_AGENT_DIR: "/injected/agent" })).toBe("/injected/agent");
  });

  it("honors a host config dir name from the env it was handed", () => {
    expect(resolveAgentDir({ HOME: "/home/tester", PI_CONFIG_DIR: ".myhost" })).toBe(
      "/home/tester/.myhost/agent",
    );
  });

  it("derives the agent dir from home plus the probed dir name", () => {
    expect(resolveAgentDir({ HOME: "/home/tester" })).toBe("/home/tester/.omp/agent");
  });

  it("returns undefined when the env names no location at all", () => {
    expect(resolveAgentDir({})).toBeUndefined();
  });

  it("derives the global and project hindsight bases from the probe", () => {
    expect(globalConfigBasePath({ HOME: "/home/tester" })).toBe(
      "/home/tester/.omp/agent/hindsight",
    );
    expect(projectConfigBasePath("/repo")).toBe("/repo/.omp/hindsight");
    expect(projectStateDir("/repo")).toBe("/repo/.omp/hindsight");
  });
});

describe("probe-derived default paths", () => {
  it("builds every default state path from the probed config dir", () => {
    const stateDir = `${hostConfigDirName()}/hindsight`;
    expect(DEFAULT_CONFIG.recall.lastRecallPath).toBe(`${stateDir}/last-recall.json`);
    expect(DEFAULT_CONFIG.retain.queuePath).toBe(`${stateDir}/retain-queue.jsonl`);
    expect(DEFAULT_CONFIG.import.manifestPath).toBe(`${stateDir}/import-manifest.json`);
    expect(DEFAULT_CONFIG.import.checkpointPath).toBe(`${stateDir}/import-checkpoint.json`);
  });

  it("carries no hardcoded pi prefix and no absolute home base", () => {
    const defaults = [
      DEFAULT_CONFIG.recall.lastRecallPath,
      DEFAULT_CONFIG.retain.queuePath,
      DEFAULT_CONFIG.import.manifestPath,
      DEFAULT_CONFIG.import.checkpointPath,
    ];
    for (const path of defaults) {
      expect(path.startsWith(".pi/")).toBe(false);
      expect(path.startsWith("/")).toBe(false);
      expect(path.startsWith("~")).toBe(false);
    }
  });
});

describe("resolveConfig global layer", () => {
  it("reads the global config from the dir the host probe reports", () => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    delete process.env.PI_CODING_AGENT_DIR;
    try {
      const cwd = mkdtempSync(join(tmpdir(), "pi-hindsight-probe-cwd-"));
      const agentDir = mkdtempSync(join(tmpdir(), "pi-hindsight-probe-agent-"));
      probe.agentDir = agentDir;
      writeFileSync(
        join(agentDir, "hindsight.json"),
        JSON.stringify({ recall: { maxTokens: 777 } }),
      );
      // No env argument: the live process env is probed through the host package.
      expect(resolveConfig(cwd).recall.maxTokens).toBe(777);
    } finally {
      probe.agentDir = "";
      if (previous !== undefined) process.env.PI_CODING_AGENT_DIR = previous;
    }
  });
});
