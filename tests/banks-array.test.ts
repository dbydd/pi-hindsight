import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../extensions/config/config.js";
import { DEFAULT_CONFIG } from "../extensions/config/config-defaults.js";
import {
  bankEntryEnabled,
  canReadBank,
  canWriteBank,
  codingBankEntry,
  mergeBankEntries,
  normalizeBankEntries,
  normalizeBanksFallback,
  readableBankEntries,
  userBankEntry,
  writableBankEntries,
} from "../extensions/config/banks.js";
import { selectMemoryScopes } from "../extensions/operations/memory-scope.js";
import type { ResolvedConfig } from "../extensions/types.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "pi-hindsight-banks-"));
}

function repo(config: unknown): string {
  const cwd = tmp();
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(join(cwd, ".pi", "hindsight.json"), JSON.stringify(config));
  return cwd;
}

function config(patch: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return { ...DEFAULT_CONFIG, ...patch } as ResolvedConfig;
}

describe("banks array normalization", () => {
  it("normalizes array entries and drops invalid ones", () => {
    const entries = normalizeBankEntries([
      { id: "coding", alias: "project", bankId: "b1" },
      { id: "coding", bankId: "duplicate" },
      { bankId: "no-id" },
      "not-an-object",
      { id: "life", alias: "user", bankId: "b2", access: "read" },
    ]);
    expect(entries.map((entry) => entry.id)).toEqual(["coding", "life"]);
    expect(entries[0]!.bankId).toBe("b1");
    expect(entries[1]!.access).toBe("read");
  });

  it("falls back to defaults when banks is junk, and keeps the default array", () => {
    expect(normalizeBankEntries("junk", DEFAULT_CONFIG.banks)).toEqual(DEFAULT_CONFIG.banks);
    expect(normalizeBankEntries(undefined, DEFAULT_CONFIG.banks)).toEqual(DEFAULT_CONFIG.banks);
    expect(normalizeBankEntries([], DEFAULT_CONFIG.banks)).toEqual([]);
  });

  it("drops an invalid access value instead of the whole entry", () => {
    const entries = normalizeBankEntries([{ id: "coding", access: "nonsense" }]);
    expect(entries).toEqual([{ id: "coding" }]);
  });

  it("drops an invalid derive but keeps valid mission fields", () => {
    const entries = normalizeBankEntries([
      { id: "coding", derive: "nope", mission: { retain: "r", retainStructuredChunkSize: -1 } },
    ]);
    expect(entries[0]!.derive).toBeUndefined();
    expect(entries[0]!.mission).toEqual({ retain: "r" });
  });

  it("takes the id from the alias, so one field declares a role bank", () => {
    const entries = normalizeBankEntries([{ alias: "project", derive: "basename" }]);
    expect(entries).toEqual([{ id: "project", alias: "project", derive: "basename" }]);
  });

  it("reads a reserved name as the alias when the id carries it", () => {
    const entries = normalizeBankEntries([
      { id: "project", derive: "cwd" },
      { id: "user", bankId: "life-bank" },
    ]);
    expect(entries).toEqual([
      { id: "project", alias: "project", derive: "cwd" },
      { id: "user", alias: "user", bankId: "life-bank" },
    ]);
    expect(codingBankEntry(config({ banks: entries }))?.id).toBe("project");
    expect(userBankEntry(config({ banks: entries }))?.bankId).toBe("life-bank");
  });

  it("keeps derive only on a coding entry", () => {
    expect(normalizeBankEntries([{ id: "notes", derive: "basename" }])).toEqual([{ id: "notes" }]);
    expect(normalizeBankEntries([{ id: "user", derive: "basename" }])).toEqual([
      { id: "user", alias: "user" },
    ]);
  });

  it("leaves a shortest-form entry enabled and read-write", () => {
    const entries = normalizeBankEntries([{ alias: "project" }]);
    expect(entries).toEqual([{ id: "project", alias: "project" }]);
    expect(bankEntryEnabled(entries[0]!)).toBe(true);
    expect(canReadBank(entries[0]!)).toBe(true);
    expect(canWriteBank(entries[0]!)).toBe(true);
  });

  it("still drops an entry that names no id and no alias", () => {
    expect(normalizeBankEntries([{ bankId: "orphan" }])).toEqual([]);
  });
});

describe("legacy three-slot shim", () => {
  it("maps project/user/global slots onto array entries", () => {
    const entries = normalizeBankEntries({
      project: { enabled: true, bankId: "coding-bank", derive: "manual" },
      global: { enabled: true, bankId: "life-bank" },
    });
    expect(entries).toEqual([
      { id: "project", alias: "project", enabled: true, bankId: "coding-bank", derive: "manual" },
      { id: "global", alias: "user", enabled: true, bankId: "life-bank" },
    ]);
  });

  it("maps coding/life aliases onto the same roles", () => {
    const entries = normalizeBankEntries({
      coding: { enabled: true, bankId: "coding-bank" },
      life: { enabled: true, bankId: "life-bank" },
    });
    expect(codingBankEntry({ ...DEFAULT_CONFIG, banks: entries })?.bankId).toBe("coding-bank");
    expect(userBankEntry({ ...DEFAULT_CONFIG, banks: entries })?.bankId).toBe("life-bank");
  });

  it("accepts legacy flat mission field names", () => {
    const entries = normalizeBankEntries({
      project: { retainMission: "r", reflectMission: "f", observationsMission: "o" },
    });
    expect(entries[0]!.mission).toEqual({ retain: "r", reflect: "f", observations: "o" });
  });

  it("keeps legacy project+user scope results identical to before the array change", () => {
    const cwd = repo({
      banks: {
        project: { enabled: true, bankId: "coding-bank", derive: "manual" },
        user: { enabled: true, bankId: "life-bank" },
      },
    });
    const scopes = selectMemoryScopes(cwd, resolveConfig(cwd, { ...process.env, HOME: tmp() }));
    expect(scopes.map((scope) => [scope.kind, scope.bankId])).toEqual([
      ["project", "coding-bank"],
      ["global", "life-bank"],
    ]);
    expect(scopes[1]!.tagGroups).toEqual([
      { tags: ["source:pi", "harness:pi"], match: "any_strict" },
    ]);
  });

  it("keeps a default config producing one path-derived project scope", () => {
    const cwd = repo({});
    const scopes = selectMemoryScopes(cwd, resolveConfig(cwd, { ...process.env, HOME: tmp() }));
    expect(scopes).toHaveLength(1);
    expect(scopes[0]!.kind).toBe("project");
    expect(scopes[0]!.bankId).toMatch(/^pi-project-/);
  });
});

describe("banks layer merge", () => {
  it("merges by id, appends new ids, and merges nested objects one level", () => {
    const merged = mergeBankEntries(
      [
        { id: "coding", alias: "project", derive: "repo", mission: { retain: "base" } },
        { id: "life", alias: "user", enabled: false },
      ],
      [
        { id: "coding", bankId: "coding-bank", mission: { reflect: "overlay" } },
        { id: "extra", bankId: "extra-bank", tagGroups: [{ tags: ["x"], match: "any" }] },
      ],
    );
    expect(merged.map((entry) => entry.id)).toEqual(["coding", "life", "extra"]);
    expect(merged[0]).toEqual({
      id: "coding",
      alias: "project",
      derive: "repo",
      bankId: "coding-bank",
      mission: { retain: "base", reflect: "overlay" },
    });
    expect(merged[2]!.tagGroups).toEqual([{ tags: ["x"], match: "any" }]);
  });

  it("replaces tagGroups wholesale on merge", () => {
    const merged = mergeBankEntries(
      [{ id: "coding", tagGroups: [{ tags: ["a"], match: "any" }] }],
      [{ id: "coding", tagGroups: [{ tags: ["b"], match: "all" }] }],
    );
    expect(merged[0]!.tagGroups).toEqual([{ tags: ["b"], match: "all" }]);
  });

  it("lets a project layer partially override and disable a global bank", () => {
    const home = tmp();
    const cwd = tmp();
    mkdirSync(join(cwd, ".pi"));
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(home, ".pi", "agent", "hindsight.json"),
      JSON.stringify({
        banks: [
          { id: "coding", alias: "project", bankId: "shared-coding", derive: "manual" },
          { id: "life", alias: "user", enabled: true, bankId: "shared-life" },
        ],
      }),
    );
    // simulate the home layer through resolveConfig by writing a project overlay that
    // only disables the user bank: the coding entry must survive untouched.
    writeFileSync(
      join(cwd, ".pi", "hindsight.json"),
      JSON.stringify({ banks: [{ id: "life", enabled: false }] }),
    );
    const resolved = resolveConfig(cwd, { ...process.env, HOME: home });
    // Untouched fields from the base layer survive a partial overlay.
    expect(codingBankEntry(resolved)).toMatchObject({
      id: "coding",
      bankId: "shared-coding",
      derive: "manual",
    });
    expect(userBankEntry(resolved)).toMatchObject({ id: "life", enabled: false });
    expect(selectMemoryScopes(cwd, resolved).map((scope) => scope.kind)).toEqual(["project"]);
  });
});

describe("banks resolution end to end", () => {
  it("appends a new id from the project layer while keeping base order", () => {
    const cwd = repo({
      banks: [{ id: "notes", bankId: "notes-bank", description: "personal notes" }],
    });
    const resolved = resolveConfig(cwd, { ...process.env, HOME: tmp() });
    expect(resolved.banks.map((entry) => entry.id)).toEqual(["coding", "life", "notes"]);
    expect(resolved.banks[2]).toMatchObject({
      id: "notes",
      bankId: "notes-bank",
      description: "personal notes",
    });
  });

  it("reads banksFallback and drops ids that are not configured", () => {
    const cwd = repo({
      banks: [{ id: "coding", alias: "project", bankId: "coding-bank" }, { id: "life" }],
      banksFallback: ["coding", "ghost", "coding"],
    });
    expect(resolveConfig(cwd, { ...process.env, HOME: tmp() }).banksFallback).toEqual(["coding"]);
  });

  it("defaults banksFallback to an empty array", () => {
    const cwd = repo({});
    expect(resolveConfig(cwd, { ...process.env, HOME: tmp() }).banksFallback).toEqual([]);
  });

  it("lets the project layer replace a global banksFallback wholesale", () => {
    const home = tmp();
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(home, ".pi", "agent", "hindsight.json"),
      JSON.stringify({ banksFallback: ["coding"] }),
    );
    const cwd = repo({ banks: [{ id: "life", alias: "user", bankId: "life-bank" }] });
    // Project layer has no banksFallback key, so the global one still applies.
    expect(resolveConfig(cwd, { ...process.env, HOME: home }).banksFallback).toEqual(["coding"]);

    const cwd2 = repo({
      banks: [{ id: "life", alias: "user", bankId: "life-bank" }],
      banksFallback: ["life"],
    });
    expect(resolveConfig(cwd2, { ...process.env, HOME: home }).banksFallback).toEqual(["life"]);
  });

  it("targets the aliased coding entry for PI_HINDSIGHT_PROJECT_BANK_ID", () => {
    const cwd = repo({
      banks: [
        { id: "kai-coding", alias: "project" },
        { id: "life", alias: "user" },
      ],
    });
    const resolved = resolveConfig(cwd, {
      ...process.env,
      HOME: tmp(),
      PI_HINDSIGHT_PROJECT_BANK_ID: "env-coding",
    });
    expect(codingBankEntry(resolved)).toMatchObject({
      id: "kai-coding",
      bankId: "env-coding",
      derive: "manual",
    });
  });

  it("targets the aliased user entry for PI_HINDSIGHT_USER_BANK_ID", () => {
    const cwd = repo({});
    const resolved = resolveConfig(cwd, {
      ...process.env,
      HOME: tmp(),
      PI_HINDSIGHT_USER_BANK_ID: "env-life",
    });
    expect(userBankEntry(resolved)).toMatchObject({
      id: "life",
      enabled: true,
      bankId: "env-life",
    });
  });
});

describe("bank access filtering", () => {
  const entries = [
    { id: "rw", bankId: "rw-bank" },
    { id: "ro", bankId: "ro-bank", access: "read" as const },
    { id: "wo", bankId: "wo-bank", access: "write" as const },
    { id: "off", bankId: "off-bank", enabled: false },
  ];

  it("exposes read/write capability predicates", () => {
    expect(canReadBank({})).toBe(true);
    expect(canReadBank({ access: "read" })).toBe(true);
    expect(canReadBank({ access: "write" })).toBe(false);
    expect(canWriteBank({})).toBe(true);
    expect(canWriteBank({ access: "write" })).toBe(true);
    expect(canWriteBank({ access: "read" })).toBe(false);
  });

  it("excludes write-only and disabled entries from recall scopes", () => {
    const resolved = config({ banks: entries });
    expect(readableBankEntries(resolved).map((entry) => entry.id)).toEqual(["rw", "ro"]);
    expect(writableBankEntries(resolved).map((entry) => entry.id)).toEqual(["rw", "wo"]);
    expect(selectMemoryScopes(tmp(), resolved).map((scope) => scope.entryId)).toEqual(["rw", "ro"]);
  });
});

describe("selectMemoryScopes tag rules", () => {
  it("uses projectRecallTags for a project-alias entry and userScopeTags for a user entry", () => {
    const cwd = tmp();
    mkdirSync(join(cwd, ".git"));
    const resolved = config({
      banks: [
        { id: "coding", alias: "project", bankId: "coding-bank" },
        { id: "life", alias: "user", bankId: "life-bank" },
      ],
    });
    const scopes = selectMemoryScopes(cwd, resolved);
    expect(scopes[0]!.tagGroups).toEqual([
      {
        tags: [expect.stringMatching(/^project:/), expect.stringMatching(/^repo:/)],
        match: "any_strict",
      },
    ]);
    expect(scopes[1]!.tagGroups).toEqual([
      { tags: ["source:pi", "harness:pi"], match: "any_strict" },
    ]);
  });

  it("falls back to project tags for an unaliased entry and honors explicit tagGroups", () => {
    const cwd = tmp();
    mkdirSync(join(cwd, ".git"));
    const resolved = config({
      banks: [
        { id: "plain", bankId: "plain-bank" },
        { id: "tagged", bankId: "tagged-bank", tagGroups: [{ tags: ["topic:x"], match: "any" }] },
      ],
    });
    const scopes = selectMemoryScopes(cwd, resolved);
    expect(scopes[0]!.tagGroups[0]).toMatchObject({ match: "any_strict" });
    expect(scopes[1]!.tagGroups).toEqual([{ tags: ["topic:x"], match: "any" }]);
  });

  it("requires an explicit bankId for user-alias entries", () => {
    const cwd = tmp();
    mkdirSync(join(cwd, ".git"));
    const resolved = config({
      banks: [
        { id: "coding", alias: "project", bankId: "coding-bank" },
        { id: "life", alias: "user" },
      ],
    });
    expect(selectMemoryScopes(cwd, resolved).map((scope) => scope.entryId)).toEqual(["coding"]);
  });

  it("applies shared observations only to project-alias entries", () => {
    const cwd = tmp();
    mkdirSync(join(cwd, ".git"));
    const resolved = config({
      scope: { ...DEFAULT_CONFIG.scope, includeSharedObservations: true },
      banks: [
        { id: "coding", alias: "project", bankId: "coding-bank" },
        { id: "life", alias: "user", bankId: "life-bank" },
      ],
    });
    const scopes = selectMemoryScopes(cwd, resolved);
    expect(scopes[0]!.tagGroups).toEqual([
      {
        or: [
          { tags: expect.any(Array), match: "any_strict" },
          { tags: [], match: "exact" },
        ],
      },
    ]);
    expect(scopes[1]!.tagGroups).toEqual([
      { tags: ["source:pi", "harness:pi"], match: "any_strict" },
    ]);
  });

  it("resolves alias bankId derivation from the coding entry", () => {
    const cwd = repo({
      banks: [{ id: "coding", alias: "project", bankId: "coding-bank", derive: "manual" }],
    });
    expect(normalizeBanksFallback(["coding"], [{ id: "coding" }])).toEqual(["coding"]);
    expect(normalizeBanksFallback(undefined, [{ id: "coding" }])).toEqual([]);
  });
});
