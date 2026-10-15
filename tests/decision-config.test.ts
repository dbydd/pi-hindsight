import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../extensions/config/config.js";
import { DEFAULT_CONFIG } from "../extensions/config/config-defaults.js";
import { normalizeConfig } from "../extensions/config/config-normalize.js";
import type { ResolvedConfig } from "../extensions/types.js";

/** `banks` stays untyped so fixtures can pass plain literals; the resolver validates them. */
function normalize(decision: unknown, banks: unknown = DEFAULT_CONFIG.banks): ResolvedConfig {
  const config = { ...DEFAULT_CONFIG, banks, decision } as ResolvedConfig;
  return normalizeConfig(config, { banks, decision });
}

function repo(config: unknown): string {
  const cwd = mkdtempSync(join(tmpdir(), "pi-hindsight-decision-"));
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(join(cwd, ".pi", "hindsight.json"), JSON.stringify(config));
  return cwd;
}

describe("decision config normalization", () => {
  it("defaults to a role model with the documented budgets", () => {
    expect(normalize(undefined).decision).toEqual({
      enabled: true,
      model: "role:judge",
      maxTokens: 200,
      timeoutMs: 3_000,
      maxContextChars: 6_000,
      cacheTtlMs: 60_000,
      fallback: { recallBanks: [], retainBanks: [] },
    });
  });

  it("keeps explicit values and an explicit provider/model spec", () => {
    const config = normalize({
      enabled: false,
      model: "magpie/group/labor",
      maxTokens: 64,
      timeoutMs: 1_500,
      maxContextChars: 500,
      cacheTtlMs: 1_000,
      fallback: { recallBanks: ["life"], retainBanks: ["coding"] },
    });
    expect(config.decision).toMatchObject({
      enabled: false,
      model: "magpie/group/labor",
      maxTokens: 64,
      timeoutMs: 1_500,
      maxContextChars: 500,
      cacheTtlMs: 1_000,
      fallback: { recallBanks: ["life"], retainBanks: ["coding"] },
    });
  });

  it("falls back to defaults for unusable values", () => {
    expect(normalize("junk").decision).toEqual(DEFAULT_CONFIG.decision);
    expect(
      normalize({ model: "", maxTokens: -5, timeoutMs: 0, maxContextChars: 1.5 }).decision,
    ).toMatchObject({
      model: "role:judge",
      maxTokens: 200,
      timeoutMs: 3_000,
      maxContextChars: 6_000,
    });
  });

  it("drops fallback bank ids that are not configured and dedupes them", () => {
    const banks = [
      { id: "coding", alias: "project", bankId: "coding-bank" },
      { id: "life", alias: "user", bankId: "life-bank" },
    ];
    const config = normalize(
      { fallback: { recallBanks: ["coding", "ghost", "coding"], retainBanks: "nope" } },
      banks,
    );
    expect(config.decision.fallback).toEqual({ recallBanks: ["coding"], retainBanks: [] });
  });

  it("reads the decision section from a project config layer", () => {
    const cwd = repo({
      banks: [{ id: "coding", alias: "project", bankId: "coding-bank" }],
      decision: {
        model: "magpie/group/labor",
        timeoutMs: 900,
        fallback: { recallBanks: ["coding"] },
      },
    });
    const config = resolveConfig(cwd, { ...process.env, HOME: tmpdir() });
    expect(config.decision.model).toBe("magpie/group/labor");
    expect(config.decision.timeoutMs).toBe(900);
    expect(config.decision.fallback.recallBanks).toEqual(["coding"]);
    expect(config.decision.maxTokens).toBe(DEFAULT_CONFIG.decision.maxTokens);
  });
});
