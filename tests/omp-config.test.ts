import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../extensions/config/config.js";
import {
  OMP_MEMORY_BACKEND_KEY,
  readHostMemoryBackend,
  readOmpSetting,
  resetOmpSetting,
  setOmpSetting,
  type OmpRunResult,
  type OmpRunner,
} from "../extensions/config/omp-config.js";
import { createControlOperations } from "../extensions/operations/memory-control-operations.js";
import { formatDebugReport } from "../extensions/utils/diagnostics.js";
import type { HindsightLikeClient } from "../extensions/types.js";

/** Runner fake that records argv so tests assert the exact omp invocation. */
function recordingRunner(result: OmpRunResult) {
  const calls: string[][] = [];
  const runner: OmpRunner = async (args) => {
    calls.push(args);
    return result;
  };
  return { runner, calls };
}

function controlDeps(overrides: {
  getHostMemoryBackend?: () => Promise<{
    host: "omp" | "pi";
    backend?: string;
    redundant: boolean;
    available: boolean;
  }>;
}) {
  return createControlOperations({
    getClient: () =>
      ({
        retain: async () => undefined,
        recall: async () => [],
        reflect: async () => ({}),
      }) as unknown as HindsightLikeClient,
    getConfig: () => DEFAULT_CONFIG,
    getProjectBankId: () => "bank",
    ...overrides,
  });
}

describe("omp-config reads", () => {
  it("does not spawn on non-omp hosts and reports the pi shape", async () => {
    let spawned = false;
    const result = await readHostMemoryBackend({
      hostDirName: ".pi",
      runner: async () => {
        spawned = true;
        return { ok: true, stdout: "hindsight\n", stderr: "" };
      },
    });
    expect(spawned).toBe(false);
    expect(result).toEqual({ host: "pi", redundant: false, available: false });
  });

  it("reads the effective value through `config get`", async () => {
    const { runner, calls } = recordingRunner({ ok: true, stdout: "off\n", stderr: "" });
    expect(await readOmpSetting(OMP_MEMORY_BACKEND_KEY, { runner })).toBe("off");
    expect(calls).toEqual([["config", "get", OMP_MEMORY_BACKEND_KEY]]);
  });

  it("collapses (not set), empty output, non-zero exit, timeout, and spawn errors to undefined", async () => {
    expect(
      await readOmpSetting("k", {
        runner: async () => ({ ok: true, stdout: "(not set)\n", stderr: "" }),
      }),
    ).toBeUndefined();
    expect(
      await readOmpSetting("k", {
        runner: async () => ({ ok: true, stdout: "   \n", stderr: "" }),
      }),
    ).toBeUndefined();
    expect(
      await readOmpSetting("k", {
        runner: async () => ({
          ok: false,
          stdout: "",
          stderr: "Unknown setting: k",
          error: "omp exited with code 1",
        }),
      }),
    ).toBeUndefined();
    expect(
      await readOmpSetting("k", {
        runner: async () => ({
          ok: false,
          stdout: "",
          stderr: "",
          error: "omp config get k timed out after 2000ms",
        }),
      }),
    ).toBeUndefined();
    // A runner that rejects (spawn ENOENT) is a failure, never a throw.
    expect(
      await readOmpSetting("k", {
        runner: async () => {
          throw new Error("spawn omp ENOENT");
        },
      }),
    ).toBeUndefined();
  });
});

describe("omp memory backend state", () => {
  it("marks non-off backends redundant and the off default clean", async () => {
    const read = (stdout: string) =>
      readHostMemoryBackend({
        hostDirName: ".omp",
        runner: async () => ({ ok: true, stdout, stderr: "" }),
      });
    expect(await read("hindsight\n")).toEqual({
      host: "omp",
      backend: "hindsight",
      redundant: true,
      available: true,
    });
    expect(await read("local\n")).toEqual({
      host: "omp",
      backend: "local",
      redundant: true,
      available: true,
    });
    expect(await read("off\n")).toEqual({
      host: "omp",
      backend: "off",
      redundant: false,
      available: true,
    });
  });

  it("reports available=false when the omp CLI cannot answer on the omp host", async () => {
    const result = await readHostMemoryBackend({
      hostDirName: ".omp",
      runner: async () => ({ ok: false, stdout: "", stderr: "", error: "spawn omp ENOENT" }),
    });
    expect(result).toEqual({ host: "omp", redundant: false, available: false });
  });
});

describe("omp-config writes", () => {
  it("invokes the correct argv for set and reset", async () => {
    const set = recordingRunner({ ok: true, stdout: "Set memory.backend = off\n", stderr: "" });
    expect(await setOmpSetting(OMP_MEMORY_BACKEND_KEY, "off", { runner: set.runner })).toEqual({
      ok: true,
      key: OMP_MEMORY_BACKEND_KEY,
      value: "off",
    });
    expect(set.calls).toEqual([["config", "set", OMP_MEMORY_BACKEND_KEY, "off"]]);

    const reset = recordingRunner({ ok: true, stdout: "", stderr: "" });
    expect(await resetOmpSetting(OMP_MEMORY_BACKEND_KEY, { runner: reset.runner })).toEqual({
      ok: true,
      key: OMP_MEMORY_BACKEND_KEY,
    });
    expect(reset.calls).toEqual([["config", "reset", OMP_MEMORY_BACKEND_KEY]]);
  });

  it("surfaces a readable failure without throwing", async () => {
    const failed = await setOmpSetting(OMP_MEMORY_BACKEND_KEY, "off", {
      runner: async () => ({ ok: false, stdout: "", stderr: "", error: "omp exited with code 1" }),
    });
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("code 1");
    const rejected = await resetOmpSetting(OMP_MEMORY_BACKEND_KEY, {
      runner: async () => {
        throw new Error("spawn omp ENOENT");
      },
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toContain("ENOENT");
  });

  it("re-reads after a write and reports the verified state", async () => {
    let backend = "hindsight";
    const runner: OmpRunner = async (args) => {
      if (args[1] === "get") return { ok: true, stdout: `${backend}\n`, stderr: "" };
      if (args[1] === "reset") {
        backend = "off";
        return { ok: true, stdout: "", stderr: "" };
      }
      if (args[1] === "set") {
        backend = args[3] ?? backend;
        return { ok: true, stdout: "", stderr: "" };
      }
      return { ok: false, stdout: "", stderr: "", error: "unexpected" };
    };
    const before = await readHostMemoryBackend({ hostDirName: ".omp", runner });
    expect(before.redundant).toBe(true);
    expect((await resetOmpSetting(OMP_MEMORY_BACKEND_KEY, { runner })).ok).toBe(true);
    expect(await readHostMemoryBackend({ hostDirName: ".omp", runner })).toEqual({
      host: "omp",
      backend: "off",
      redundant: false,
      available: true,
    });
  });
});

describe("host memory backend status facts", () => {
  it("carries the omp fact through operations.status", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-hindsight-omp-backend-"));
    const omp = await controlDeps({
      getHostMemoryBackend: async () => ({
        host: "omp",
        backend: "hindsight",
        redundant: true,
        available: true,
      }),
    }).status(cwd);
    expect(omp.hostMemoryBackend).toEqual({
      host: "omp",
      backend: "hindsight",
      redundant: true,
      available: true,
    });

    const pi = await controlDeps({
      getHostMemoryBackend: async () => ({ host: "pi", redundant: false, available: false }),
    }).status(cwd);
    expect(pi.hostMemoryBackend).toEqual({ host: "pi", redundant: false, available: false });
  });

  it("defaults to the pi shape without spawning when no reader is injected", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-hindsight-omp-backend-default-"));
    const status = await controlDeps({}).status(cwd);
    expect(status.hostMemoryBackend).toEqual({ host: "pi", redundant: false, available: false });
  });
});

describe("doctor host memory backend hint", () => {
  function report(
    hostMemoryBackend?: Parameters<typeof formatDebugReport>[0]["hostMemoryBackend"],
  ) {
    return JSON.parse(
      formatDebugReport({
        cwd: process.cwd(),
        projectBankId: "bank",
        config: DEFAULT_CONFIG,
        queueLength: 0,
        ...(hostMemoryBackend ? { hostMemoryBackend } : {}),
      }),
    ) as Record<string, any>;
  }

  it("prints the exact fix command when omp's built-in backend is redundant", () => {
    const out = report({ host: "omp", backend: "hindsight", redundant: true, available: true });
    expect(out.hostMemoryBackend.action).toContain("omp config reset memory.backend");
  });

  it("stays quiet when the built-in backend is off, and null without the fact", () => {
    const off = report({ host: "omp", backend: "off", redundant: false, available: true });
    expect(off.hostMemoryBackend.action).toBeNull();
    expect(report().hostMemoryBackend).toBeNull();
  });
});
