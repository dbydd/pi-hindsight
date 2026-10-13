import { describe, expect, it, vi } from "vitest";
import {
  countObservationsMatchingAllTags,
  decideMentalModelScope,
  observationScopeEntries,
  observationScopesSnapshot,
  resolveMentalModelScopeTags,
  unmatchedTagWarning,
} from "../extensions/banks/mm-scope-tags.js";

describe("decideMentalModelScope", () => {
  it("scopes to the caller's own tenant in a partitioned bank", () => {
    const decision = decideMentalModelScope(
      [
        { tags: ["project:alpha"], count: 60 },
        { tags: ["project:beta"], count: 40 },
      ],
      ["project:beta"],
    );

    expect(decision?.tags).toEqual(["project:beta"]);
    expect(decision?.namespace).toBe("project");
  });

  it("reads the whole bank when a dedicated bank has no tenancy namespace", () => {
    const decision = decideMentalModelScope(
      [
        { tags: ["source:local-skills", "skill:paper-writer"], count: 80 },
        { tags: ["source:local-skills", "skill:references"], count: 20 },
      ],
      [],
    );

    expect(decision?.tags).toEqual([]);
  });

  it("ignores provenance namespaces when judging tenancy", () => {
    // harness:pi owns half the bank but is writer identity, not a tenant axis.
    const decision = decideMentalModelScope(
      [
        { tags: ["harness:pi", "project:alpha"], count: 30 },
        { tags: ["harness:pi", "project:beta"], count: 20 },
        { tags: ["project:gamma"], count: 50 },
      ],
      ["project:beta"],
    );

    expect(decision?.namespace).toBe("project");
    expect(decision?.tags).toEqual(["project:beta"]);
  });

  it("reads the whole bank when the caller owns no tag in the partitioned namespace", () => {
    const decision = decideMentalModelScope(
      [
        { tags: ["vault:Alexandria"], count: 81 },
        { tags: ["vault:Other"], count: 19 },
      ],
      ["project:my-repo"],
    );

    expect(decision?.tags).toEqual([]);
    expect(decision?.reason).toContain("owns no tag");
  });

  it("falls back to a whole-bank read when the dominant tag is below the floor", () => {
    const decision = decideMentalModelScope(
      [
        { tags: ["project:tiny"], count: 5 },
        { tags: [], count: 95 },
      ],
      ["project:tiny"],
    );

    expect(decision?.tags).toEqual([]);
  });

  it("scopes a single-tenant namespace when the caller owns the value", () => {
    const decision = decideMentalModelScope(
      [{ tags: ["vault:Alexandria"], count: 100 }],
      ["vault:Alexandria"],
    );

    expect(decision?.tags).toEqual(["vault:Alexandria"]);
  });

  it("returns undefined for an empty bank so the caller keeps its own default", () => {
    expect(decideMentalModelScope([], ["project:x"])).toBeUndefined();
    expect(decideMentalModelScope([{ tags: ["project:x"], count: 0 }])).toBeUndefined();
  });
});

describe("observationScopeEntries", () => {
  it("ignores malformed entries and non-string tags", () => {
    expect(
      observationScopeEntries({
        scopes: [
          { tags: ["project:a", 7], count: 3 },
          { tags: "nope", count: 2 },
          null,
          { tags: [], count: Number.NaN },
        ],
      }),
    ).toEqual([
      { tags: ["project:a"], count: 3 },
      { tags: [], count: 0 },
    ]);
  });

  it("returns [] for a missing or malformed response", () => {
    expect(observationScopeEntries(undefined)).toEqual([]);
    expect(observationScopeEntries({ scopes: "nope" })).toEqual([]);
  });
});

describe("countObservationsMatchingAllTags", () => {
  const entries = [
    { tags: ["harness:pi", "project:alpha"], count: 30 },
    { tags: ["harness:pi"], count: 20 },
  ];

  it("counts the whole bank for an empty tag list", () => {
    expect(countObservationsMatchingAllTags(entries, [])).toBe(50);
  });

  it("requires every tag to be present when the list is non-empty", () => {
    expect(countObservationsMatchingAllTags(entries, ["harness:pi"])).toBe(50);
    expect(countObservationsMatchingAllTags(entries, ["harness:pi", "project:alpha"])).toBe(30);
    expect(countObservationsMatchingAllTags(entries, ["source:pi"])).toBe(0);
  });
});

describe("observationScopesSnapshot", () => {
  it("reports completeness from the response total", () => {
    expect(observationScopesSnapshot({ scopes: [{ tags: ["a"], count: 1 }], total: 5 })).toEqual({
      entries: [{ tags: ["a"], count: 1 }],
      scopeTotal: 5,
      complete: false,
    });
    expect(observationScopesSnapshot({ scopes: [{ tags: ["a"], count: 1 }], total: 1 })).toEqual({
      entries: [{ tags: ["a"], count: 1 }],
      scopeTotal: 1,
      complete: true,
    });
  });
});

describe("unmatchedTagWarning", () => {
  it("reports a filter that reaches no observations", () => {
    const warning = unmatchedTagWarning({
      entries: [{ tags: ["harness:pi"], count: 10 }],
      complete: true,
      tags: ["source:pi", "project:alexandria"],
    });

    expect(warning).toContain("match 0 of 10 observations");
    expect(warning).toContain("harness:pi");
  });

  it("stays quiet when the filter reaches observations or uncovers the whole bank", () => {
    const base = {
      entries: [{ tags: ["harness:pi"], count: 10 }],
      complete: true,
    };

    expect(unmatchedTagWarning({ ...base, tags: ["harness:pi"] })).toBeUndefined();
    expect(unmatchedTagWarning({ ...base, tags: [] })).toBeUndefined();
  });

  it("stays quiet for a bank with no observations to compare against", () => {
    expect(
      unmatchedTagWarning({ entries: [], complete: true, tags: ["source:pi"] }),
    ).toBeUndefined();
  });

  it("never reports from a truncated scope list", () => {
    // The dangerous case: a page cut short can hide the scope that would have matched.
    expect(
      unmatchedTagWarning({
        entries: [{ tags: ["harness:pi"], count: 10 }],
        complete: false,
        tags: ["source:pi"],
      }),
    ).toBeUndefined();
  });
});

describe("resolveMentalModelScopeTags", () => {
  it("returns undefined without the scopes endpoint so the caller keeps its default", async () => {
    expect(
      await resolveMentalModelScopeTags({
        client: {} as never,
        bankId: "coding",
      }),
    ).toBeUndefined();
  });

  it("returns undefined when the scopes call fails", async () => {
    expect(
      await resolveMentalModelScopeTags({
        client: {
          listObservationScopes: vi.fn(async () => {
            throw new Error("410 Gone");
          }),
        } as never,
        bankId: "coding",
      }),
    ).toBeUndefined();
  });

  it("exposes the fetched entries to the caller for coverage checks", async () => {
    const listObservationScopes = vi.fn(async () => ({
      scopes: [{ tags: ["project:alpha"], count: 5 }],
      total: 1,
    }));
    const result = await resolveMentalModelScopeTags({
      client: { listObservationScopes } as never,
      bankId: "coding",
      identityTags: ["project:alpha"],
    });

    expect(result?.tags).toEqual(["project:alpha"]);
    expect(result?.entries).toEqual([{ tags: ["project:alpha"], count: 5 }]);
    expect(result?.complete).toBe(true);
    expect(listObservationScopes).toHaveBeenCalledTimes(1);
  });

  it("pages until the bank's scope total is reached", async () => {
    // A full first page of one-observation scopes, then the dominant tenant on page two.
    const fullPage = Array.from({ length: 1000 }, (_v, i) => ({
      tags: [`project:stale-${i}`],
      count: 1,
    }));
    const page = (offset: number) => ({
      scopes: offset === 0 ? fullPage : [{ tags: ["project:live"], count: 1000 }],
      total: 1001,
    });
    const listObservationScopes = vi.fn(async (_bank: string, options?: { offset?: number }) =>
      page(options?.offset ?? 0),
    );

    const result = await resolveMentalModelScopeTags({
      client: { listObservationScopes } as never,
      bankId: "big",
      identityTags: ["project:live"],
    });

    expect(listObservationScopes).toHaveBeenCalledTimes(2);
    expect(result?.tags).toEqual(["project:live"]);
    expect(result?.complete).toBe(true);
  });
});
