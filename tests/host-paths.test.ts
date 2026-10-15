import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  agentDirFromSessionFile,
  globalConfigBasePath,
  hostConfigDirName,
  probeHostDirs,
  projectConfigBasePath,
  projectStateDir,
  resetHostProbe,
  resolveAgentDir,
  setRuntimeSessionFile,
} from "../extensions/config/paths.js";
import { resolveConfig } from "../extensions/config/config.js";
import { DEFAULT_CONFIG } from "../extensions/config/config-defaults.js";

// Real session-file shapes: both hosts write `<config dir>/agent/sessions/<project>/<file>.jsonl`.
const OMP_AGENT_DIR = "/Users/dbydd/.omp/agent";
const PI_AGENT_DIR = "/Users/dbydd/.pi/agent";
const OMP_SESSION = `${OMP_AGENT_DIR}/sessions/--private-tmp--/2026-09-10T00-32-58-842Z_01a088bb-69da-73f5-a980-f77cc63312ad.jsonl`;
const PI_SESSION = `${PI_AGENT_DIR}/sessions/--Users-dbydd--/2026-06-19T11-50-05-962Z_019edfb7-818a-7b1e-b519-456d02261e2a.jsonl`;

describe("agentDirFromSessionFile", () => {
  it("derives the omp agent dir from an omp session path", () => {
    expect(agentDirFromSessionFile(OMP_SESSION)).toBe(OMP_AGENT_DIR);
  });

  it("derives the pi agent dir from a pi session path", () => {
    expect(agentDirFromSessionFile(PI_SESSION)).toBe(PI_AGENT_DIR);
  });

  it("returns undefined for anything that is not a session file", () => {
    expect(agentDirFromSessionFile(undefined)).toBeUndefined();
    expect(agentDirFromSessionFile("")).toBeUndefined();
    // In-memory session: no file at all.
    expect(agentDirFromSessionFile("/Users/dbydd/.omp/agent/hindsight.json")).toBeUndefined();
    // File is not a session JSONL.
    expect(
      agentDirFromSessionFile(`${OMP_AGENT_DIR}/sessions/--private-tmp--/session.json`),
    ).toBeUndefined();
    // No `sessions` segment: `<config dir>/agent/<project>/<file>.jsonl`.
    expect(
      agentDirFromSessionFile(`${OMP_AGENT_DIR}/--private-tmp--/2026-09-10T00-32-58-842Z_x.jsonl`),
    ).toBeUndefined();
    // No `agent` segment: `<config dir>/sessions/<project>/<file>.jsonl`.
    expect(
      agentDirFromSessionFile(
        "/Users/dbydd/.omp/sessions/--private-tmp--/2026-09-10T00-32_x.jsonl",
      ),
    ).toBeUndefined();
    // Project dir missing entirely.
    expect(
      agentDirFromSessionFile(`${OMP_AGENT_DIR}/sessions/2026-09-10T00-32-58-842Z_x.jsonl`),
    ).toBeUndefined();
  });
});

describe("session-derived host paths", () => {
  it("resolves an omp session to .omp paths", () => {
    expect(hostConfigDirName({ sessionFile: OMP_SESSION })).toBe(".omp");
    expect(projectConfigBasePath("/repo", { sessionFile: OMP_SESSION })).toBe(
      "/repo/.omp/hindsight",
    );
    expect(projectStateDir("/repo", { sessionFile: OMP_SESSION })).toBe("/repo/.omp/hindsight");
    expect(globalConfigBasePath({ env: { HOME: "/home/tester" }, sessionFile: OMP_SESSION })).toBe(
      `${OMP_AGENT_DIR}/hindsight`,
    );
  });

  it("resolves a pi session to .pi paths", () => {
    expect(hostConfigDirName({ sessionFile: PI_SESSION })).toBe(".pi");
    expect(projectConfigBasePath("/repo", { sessionFile: PI_SESSION })).toBe("/repo/.pi/hindsight");
    expect(projectStateDir("/repo", { sessionFile: PI_SESSION })).toBe("/repo/.pi/hindsight");
    expect(globalConfigBasePath({ env: { HOME: "/home/tester" }, sessionFile: PI_SESSION })).toBe(
      `${PI_AGENT_DIR}/hindsight`,
    );
  });
});

describe("env ladder", () => {
  it("lets an explicit agent dir override the session shape", () => {
    expect(
      resolveAgentDir({
        env: { PI_CODING_AGENT_DIR: "/injected/agent" },
        sessionFile: OMP_SESSION,
      }),
    ).toBe("/injected/agent");
  });

  it("lets the host config dir name override the session shape", () => {
    const options = {
      env: { HOME: "/home/tester", PI_CONFIG_DIR: ".myhost" },
      sessionFile: OMP_SESSION,
    };
    expect(hostConfigDirName(options)).toBe(".myhost");
    expect(resolveAgentDir({ env: { HOME: "/home/tester", PI_CONFIG_DIR: ".myhost" } })).toBe(
      "/home/tester/.myhost/agent",
    );
    expect(projectStateDir("/repo", options)).toBe("/repo/.myhost/hindsight");
  });

  it("falls back to <home>/<config dir>/agent for an injected env", () => {
    expect(resolveAgentDir({ env: { HOME: "/home/tester" } })).toBe("/home/tester/.pi/agent");
    expect(hostConfigDirName({ env: { HOME: "/home/tester" } })).toBe(".pi");
  });

  it("returns undefined when the env names no location and no session is known", () => {
    expect(resolveAgentDir({ env: {} })).toBeUndefined();
    expect(globalConfigBasePath({ env: {} })).toBeUndefined();
  });
});

describe("omp dirs probe", () => {
  beforeEach(() => {
    resetHostProbe();
  });

  it("uses the omp dirs package when no session file is known", async () => {
    await probeHostDirs(async () => ({
      CONFIG_DIR_NAME: ".omp",
      getAgentDir: () => OMP_AGENT_DIR,
    }));
    expect(hostConfigDirName()).toBe(".omp");
    expect(resolveAgentDir()).toBe(OMP_AGENT_DIR);
    expect(globalConfigBasePath()).toBe(`${OMP_AGENT_DIR}/hindsight`);
  });

  it("never consults the probe for an injected env", async () => {
    await probeHostDirs(async () => ({
      CONFIG_DIR_NAME: ".omp",
      getAgentDir: () => OMP_AGENT_DIR,
    }));
    expect(hostConfigDirName({ env: { HOME: "/home/tester" } })).toBe(".pi");
    expect(resolveAgentDir({ env: { HOME: "/home/tester" } })).toBe("/home/tester/.pi/agent");
  });

  it("keeps the fallback when the omp package is absent, as under pi", async () => {
    await probeHostDirs(async () => {
      throw new Error("@oh-my-pi/pi-utils is not installed");
    });
    expect(hostConfigDirName({ env: { HOME: "/home/tester" } })).toBe(".pi");
    expect(resolveAgentDir({ env: { HOME: "/home/tester" } })).toBe("/home/tester/.pi/agent");
  });
});

describe("default state paths", () => {
  it("follow the live session's host instead of the import-time constant", () => {
    setRuntimeSessionFile(OMP_SESSION);
    expect(DEFAULT_CONFIG.recall.lastRecallPath).toBe(".omp/hindsight/last-recall.json");
    expect(DEFAULT_CONFIG.retain.queuePath).toBe(".omp/hindsight/retain-queue.jsonl");
    expect(DEFAULT_CONFIG.import.manifestPath).toBe(".omp/hindsight/import-manifest.json");
    expect(DEFAULT_CONFIG.import.checkpointPath).toBe(".omp/hindsight/import-checkpoint.json");

    setRuntimeSessionFile(PI_SESSION);
    expect(DEFAULT_CONFIG.recall.lastRecallPath).toBe(".pi/hindsight/last-recall.json");

    setRuntimeSessionFile(undefined);
    expect(DEFAULT_CONFIG.recall.lastRecallPath).toBe(".pi/hindsight/last-recall.json");
  });

  it("never carries an absolute or home-based default", () => {
    setRuntimeSessionFile(OMP_SESSION);
    const defaults = [
      DEFAULT_CONFIG.recall.lastRecallPath,
      DEFAULT_CONFIG.retain.queuePath,
      DEFAULT_CONFIG.import.manifestPath,
      DEFAULT_CONFIG.import.checkpointPath,
    ];
    for (const path of defaults) {
      expect(path.startsWith("/")).toBe(false);
      expect(path.startsWith("~")).toBe(false);
      expect(path.startsWith(".pi/")).toBe(false);
    }
    setRuntimeSessionFile(undefined);
  });
});

describe("resolveConfig with a live session file", () => {
  it("reads the global config from the session-derived agent dir", () => {
    const home = mkdtempSync(join(tmpdir(), "pi-hindsight-omp-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "pi-hindsight-omp-cwd-"));
    const agentDir = join(home, ".omp", "agent");
    const projectDir = join(agentDir, "sessions", "--repo--");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(agentDir, "hindsight.json"), JSON.stringify({ recall: { maxTokens: 777 } }));
    const sessionFile = join(projectDir, "2026-01-02T03-04-05-678Z_01a00000-0000.jsonl");

    const config = resolveConfig(cwd, { HOME: home }, sessionFile);
    expect(config.recall.maxTokens).toBe(777);
    expect(projectStateDir(cwd, { env: { HOME: home }, sessionFile })).toBe(
      join(cwd, ".omp", "hindsight"),
    );
  });

  it("leaves the global layer empty when the session shape is unknown", () => {
    const home = mkdtempSync(join(tmpdir(), "pi-hindsight-unknown-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "pi-hindsight-unknown-cwd-"));
    mkdirSync(join(home, ".omp", "agent"), { recursive: true });
    writeFileSync(
      join(home, ".omp", "agent", "hindsight.json"),
      JSON.stringify({ recall: { maxTokens: 777 } }),
    );

    // An in-memory session has no file, so `.omp` is not discoverable from this env.
    expect(resolveConfig(cwd, { HOME: home }, undefined).recall.maxTokens).toBe(
      DEFAULT_CONFIG.recall.maxTokens,
    );
  });
});
