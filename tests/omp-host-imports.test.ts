import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { probeHostDirs, hostConfigDirName, resolveAgentDir } from "../extensions/config/paths.js";
import { loadOmpJudgmentRuntime, loadOmpRoleRuntime } from "../extensions/decision/host.js";

/**
 * The real ladders, run where no `@oh-my-pi/*` module exists — which is every tree
 * that is not a working omp install, and the case that used to be reached through a
 * computed specifier so it never loaded even on omp. Each candidate fails to
 * resolve here, so the whole ladder is exercised end to end, and the answer has to
 * be the same absence the pi and unknown hosts have always seen.
 *
 * Ladder semantics that need a candidate to *succeed* live in
 * `omp-host-ladder.test.ts`, which stubs the module reads.
 */
describe("omp host loaders without an omp install", () => {
  it("resolves no judgment runtime", async () => {
    await expect(loadOmpJudgmentRuntime()).resolves.toBeUndefined();
  });

  it("resolves no role runtime", async () => {
    await expect(loadOmpRoleRuntime()).resolves.toBeUndefined();
  });

  it("keeps the package fallback for host dirs", async () => {
    await probeHostDirs();
    expect(hostConfigDirName()).toBe(".pi");
    expect(resolveAgentDir()).toBe(join(process.env.HOME ?? "", ".pi", "agent"));
  });
});

/**
 * Every host `import()` must stay a literal. omp is one bundled file whose
 * `@oh-my-pi/*` specifiers were rewritten at build time, so a variable resolves
 * against bare node at runtime and misses even on omp — which silently disabled
 * both judgment rungs before that shape was fixed. Guarding the source text keeps
 * nobody reaching for a loop here again.
 */
describe("host module imports", () => {
  const files = [
    join(import.meta.dirname, "..", "extensions", "decision", "host.ts"),
    join(import.meta.dirname, "..", "extensions", "config", "paths.ts"),
  ];

  it.each(files)("keeps every specifier in %s a literal", (file) => {
    const source = readFileSync(file, "utf8");
    // Strip comments: the JSDoc above these imports discusses `import()` in prose.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const imports = code.match(/\bimport\s*\(\s*[^)\n]*\)/g) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    for (const expression of imports) {
      expect(expression, `${file}: ${expression}`).toMatch(/^import\s*\(\s*"/);
    }
  });

  it.each(files)("takes no omp package statically in %s", (file) => {
    const source = readFileSync(file, "utf8");
    expect(source).not.toMatch(/^import[^;]*from\s+"@oh-my-pi\//m);
    expect(source).not.toMatch(/^import\s+"@oh-my-pi\//m);
  });
});
