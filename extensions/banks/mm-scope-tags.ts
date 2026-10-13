import type { HindsightLikeClient } from "../types.js";

/**
 * Pick a mental model's refresh tag filter from the bank's own observation scopes.
 *
 * A mental model's stored `tags` choose which observations its refresh may read, and a tagged
 * model with no explicit `tags_match` defaults to `all_strict` — one result must carry every
 * listed tag. Seeding a fixed tag (`source:pi`) therefore produced empty documents in every
 * bank whose observations carry a different scope tag, because the tag has to be one the
 * target bank actually holds. Only the bank can report that.
 *
 * The rule:
 * - The bank partitions into tenants when a tenancy namespace
 *   (`project:`, `vault:`, ...) has values owning a meaningful share of observations.
 * - A model scopes to the tenant value the caller owns (its active `project:<id>`), so a
 *   shared bank keeps each project's models on its own content.
 * - With no owned tenant value — a dedicated bank, or a bank-wide model — the model reads the
 *   whole bank. A tag filter there can only fail empty, so it buys nothing.
 *
 * Provenance namespaces (`source:`, `harness:`, `session:`, `repo:`) are writer identity, not
 * tenancy: `harness:pi` covering half a shared bank is no reason to drop isolation.
 */

export interface ObservationScopeEntry {
  tags: string[];
  count: number;
}

/** Server-side page ceiling for the scopes endpoint (`limit` maximum is 1000). */
const SCOPES_PAGE_LIMIT = 1000;
/** Stop paginating past this; a bank with more distinct scopes is pathological. */
const SCOPES_MAX_PAGES = 20;

export interface ObservationScopesSnapshot {
  entries: ObservationScopeEntry[];
  /**
   * Distinct scopes in the bank, from the response `total`. This is a page count, not an
   * observation count — the endpoint totals scopes, so callers wanting observations must sum
   * `entries[].count`.
   */
  scopeTotal: number;
  /** False when pagination stopped before the response's `total` was reached. */
  complete: boolean;
}

/**
 * Namespaces whose values identify a tenant, i.e. partition the bank. Ranked by preference:
 * on an equal dominant share, `project:` wins over the legacy `repo:` hash the dual-tag window
 * writes alongside it.
 */
const TENANCY_NAMESPACE_RANK: Record<string, number> = {
  project: 0,
  vault: 1,
  team: 2,
  workspace: 3,
  tenant: 4,
  org: 5,
  client: 6,
};

/** Dominant tag must own at least this share of the bank's observations to name its tenant axis. */
const TENANT_COVER_FLOOR = 0.15;

export interface MentalModelScopeDecision {
  /** Tag list for the model's `tags`. Empty reads the whole bank. */
  tags: string[];
  /** One-line explanation, for diagnostics and dry-run output. */
  reason: string;
  /** Namespace the tag came from, when one was chosen. */
  namespace?: string;
}

interface NamespaceStats {
  namespace: string;
  topTag: string;
  share: number;
  distinct: number;
}

function splitNamespace(tag: string): string | undefined {
  const separator = tag.indexOf(":");
  if (separator <= 0) return undefined;
  return tag.slice(0, separator);
}

function tenancyRank(namespace: string): number {
  return TENANCY_NAMESPACE_RANK[namespace] ?? Number.MAX_SAFE_INTEGER;
}

/** Tenancy namespaces present in the bank, most dominant first. */
function tenancyStats(entries: readonly ObservationScopeEntry[]): NamespaceStats[] {
  const counts = new Map<string, Map<string, number>>();
  let total = 0;
  for (const entry of entries) {
    const count = Number.isFinite(entry.count) ? entry.count : 0;
    if (count <= 0) continue;
    total += count;
    for (const tag of entry.tags) {
      const namespace = splitNamespace(tag);
      if (!namespace || !(namespace in TENANCY_NAMESPACE_RANK)) continue;
      const values = counts.get(namespace) ?? new Map<string, number>();
      values.set(tag, (values.get(tag) ?? 0) + count);
      counts.set(namespace, values);
    }
  }
  if (total <= 0) return [];
  const stats: NamespaceStats[] = [];
  for (const [namespace, values] of counts) {
    const sorted = [...values].sort((a, b) => b[1] - a[1]);
    const [topTag, topCount] = sorted[0]!;
    stats.push({ namespace, topTag, share: topCount / total, distinct: sorted.length });
  }
  return stats
    .filter((stat) => stat.share >= TENANT_COVER_FLOOR)
    .sort((a, b) => b.share - a.share || tenancyRank(a.namespace) - tenancyRank(b.namespace));
}

/**
 * Decide a mental model's tag filter from the bank's observation scopes.
 *
 * `identityTags` are tags the caller already owns (its active `project:<id>`). The first
 * partitioning namespace the caller has a value in wins, so a shared bank stays isolated per
 * project even when another namespace happens to have a larger dominant share.
 *
 * Returns `undefined` when the bank reports no observations: the caller's own default is the
 * better guess then.
 */
export function decideMentalModelScope(
  entries: readonly ObservationScopeEntry[],
  identityTags: readonly string[] = [],
): MentalModelScopeDecision | undefined {
  const total = entries.reduce(
    (sum, entry) => sum + (Number.isFinite(entry.count) ? entry.count : 0),
    0,
  );
  if (total <= 0) return undefined;

  const stats = tenancyStats(entries);
  if (stats.length === 0) {
    return {
      tags: [],
      reason: "no tenancy tag namespace partitions the bank; read the whole bank",
    };
  }

  for (const stat of stats) {
    const owned = identityTags.find((tag) => splitNamespace(tag) === stat.namespace);
    if (!owned) continue;
    const scope = stat.distinct > 1 ? `${stat.distinct} tenants` : "a single tenant";
    return {
      tags: [owned],
      reason: `${stat.namespace} splits the bank into ${scope}; scoped to ${owned}`,
      namespace: stat.namespace,
    };
  }

  return {
    tags: [],
    reason: `bank is partitioned by ${stats[0]!.namespace} but the caller owns no tag in it; read the whole bank`,
  };
}

/** Normalize the `/observations/scopes` response into decision input. */
export function observationScopeEntries(response: unknown): ObservationScopeEntry[] {
  const scopes = (response as { scopes?: unknown } | undefined)?.scopes;
  if (!Array.isArray(scopes)) return [];
  const entries: ObservationScopeEntry[] = [];
  for (const raw of scopes) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as { tags?: unknown; count?: unknown };
    if (!Array.isArray(row.tags)) continue;
    const tags = row.tags.filter((tag): tag is string => typeof tag === "string" && tag.length > 0);
    const count = typeof row.count === "number" && Number.isFinite(row.count) ? row.count : 0;
    entries.push({ tags, count });
  }
  return entries;
}

/**
 * Read one scopes page: its entries, the bank's reported `total`, and the page size.
 *
 * Most callers want `resolveMentalModelScopeTags`, which paginates; this stays exported for
 * callers holding a single already-fetched page.
 */
export function observationScopesSnapshot(response: unknown): ObservationScopesSnapshot {
  const entries = observationScopeEntries(response);
  const rawTotal = (response as { total?: unknown } | undefined)?.total;
  const reported = typeof rawTotal === "number" && Number.isFinite(rawTotal) ? rawTotal : undefined;
  const scopeTotal = reported ?? entries.length;
  return { entries, scopeTotal, complete: entries.length >= scopeTotal };
}

/**
 * Derive a mental model's tag filter for a bank.
 *
 * Returns `undefined` when the answer is unknown — client or server without the scopes
 * endpoint, a failed call, or an empty bank — so the caller keeps its own default. Otherwise
 * `[]` reads the whole bank and `["<namespace>:<value>"]` scopes to one tenant.
 */
export async function resolveMentalModelScopeTags(args: {
  client: HindsightLikeClient;
  bankId: string;
  identityTags?: readonly string[];
  signal?: AbortSignal;
}): Promise<
  | {
      tags: string[];
      reason: string;
      entries: ObservationScopeEntry[];
      /** True when every scope was enumerated, so a zero match is conclusive. */
      complete: boolean;
    }
  | undefined
> {
  if (!args.client.listObservationScopes) return undefined;
  try {
    // A bank can hold more distinct scopes than one page (the server caps `limit` at 1000), and
    // a truncated list would make "this tag matches nothing" a false report. Page to the end.
    const entries: ObservationScopeEntry[] = [];
    for (let page = 0; page < SCOPES_MAX_PAGES; page += 1) {
      const offset = page * SCOPES_PAGE_LIMIT;
      const response = await args.client.listObservationScopes(args.bankId, {
        limit: SCOPES_PAGE_LIMIT,
        offset,
        ...(args.signal ? { signal: args.signal } : {}),
      });
      const snapshot = observationScopesSnapshot(response);
      entries.push(...snapshot.entries);
      const exhaustedPage = snapshot.entries.length < SCOPES_PAGE_LIMIT;
      if (exhaustedPage || entries.length >= snapshot.scopeTotal) {
        const decision = decideMentalModelScope(entries, args.identityTags ?? []);
        if (!decision) return undefined;
        return { tags: decision.tags, reason: decision.reason, entries, complete: true };
      }
    }
    // Page cap reached with scopes still outstanding: the tenant picture may be partial, and a
    // partial picture must not be reported as a zero-match. Answer from what is known, but mark
    // it incomplete so the warning stays quiet.
    const decision = decideMentalModelScope(entries, args.identityTags ?? []);
    if (!decision) return undefined;
    return { tags: decision.tags, reason: decision.reason, entries, complete: false };
  } catch {
    // Scope enumeration is advisory: an older server or a transient failure falls back to the
    // caller's default rather than blocking the operation.
    return undefined;
  }
}

/**
 * How many observations an `all_strict` tag filter reaches across enumerated scopes.
 *
 * An empty tag list reads everything, so it always reports the bank total. A non-empty list
 * needs one observation scope to carry *every* tag — the implicit `all_strict` of a tagged
 * model with no explicit `tags_match`. A zero here is the "created but never fills" defect:
 * the caller can report it instead of creating a document that stays empty.
 */
export function countObservationsMatchingAllTags(
  entries: readonly ObservationScopeEntry[],
  tags: readonly string[],
): number {
  if (tags.length === 0) {
    return entries.reduce((sum, entry) => sum + entry.count, 0);
  }
  let matched = 0;
  for (const entry of entries) {
    if (tags.every((tag) => entry.tags.includes(tag))) matched += entry.count;
  }
  return matched;
}

/**
 * Warn text when a tag filter would reach no observations, else `undefined`.
 *
 * Refreshing such a model overwrites its content with nothing, which looks like a silent
 * failure. Returns `undefined` unless the scope list is known to be complete and the filter
 * demonstrably reaches nothing, so a truncated enumeration never produces a false report.
 */
export function unmatchedTagWarning(args: {
  entries: readonly ObservationScopeEntry[];
  complete: boolean;
  tags: readonly string[];
}): string | undefined {
  const { entries, complete, tags } = args;
  if (tags.length === 0) return undefined;
  if (!complete) return undefined;
  if (countObservationsMatchingAllTags(entries, tags) > 0) return undefined;
  const observations = countObservationsMatchingAllTags(entries, []);
  if (observations === 0) return undefined;
  const sample = entries
    .slice(0, 5)
    .map((entry) => entry.tags.filter((tag) => tag.length > 0).join("+") || "(untagged)")
    .join(", ");
  return (
    `tags ${JSON.stringify(tags)} match 0 of ${observations} observations in this bank; ` +
    `refresh would leave the model empty. Existing scopes: ${sample}`
  );
}
