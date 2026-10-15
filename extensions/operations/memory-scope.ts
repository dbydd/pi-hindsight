import type { BankConfigEntry, HindsightTagGroup, TagsMatch, ResolvedConfig } from "../types.js";
import { recallScopeTags } from "../banks/banking.js";
import { createMemoryIdentity } from "./memory-identity.js";
import { readableBankEntries } from "../config/banks.js";

export interface MemoryRecallScope {
  /** Stable id of the `banks` entry this scope came from. */
  entryId: string;
  /**
   * Legacy role kind kept for recall/telemetry consumers that branch on it:
   * project = coding-role scope, global = life/user-role scope.
   */
  kind: "project" | "global";
  bankId: string;
  tagGroups: HindsightTagGroup[];
}

export function scopeTagsForBank(cwd: string, config: ResolvedConfig, bankId: string): string[] {
  return config.banks.find((entry) => entry.bankId === bankId)?.alias === "user"
    ? createMemoryIdentity(cwd, config).globalRecallTags
    : recallScopeTags(cwd, config);
}

export interface ScopedTagFilterInput {
  tags?: string[];
  tagsMatch?: TagsMatch;
  tagGroups?: HindsightTagGroup[];
  /**
   * When true, OR exact-empty (shared/untagged) observations with the project scope filter.
   * Default follows config.scope.includeSharedObservations when composed via recall paths.
   */
  includeSharedObservations?: boolean;
}

/** Hindsight exact-empty leaf: only untagged/shared observation-scope memories. */
export const SHARED_UNTAGGED_TAG_GROUP: HindsightTagGroup = { tags: [], match: "exact" };

/**
 * OR project/user scope isolation with exact-empty shared observations.
 * Used when includeSharedObservations is opted in.
 */
export function withSharedObservations(scopeGroup: HindsightTagGroup): HindsightTagGroup {
  return { or: [scopeGroup, SHARED_UNTAGGED_TAG_GROUP] };
}

export function composeScopedTagFilter(
  scopeTags: string[],
  filters: ScopedTagFilterInput = {},
): { tagGroups: HindsightTagGroup[] } | Record<string, never> {
  const includeShared = filters.includeSharedObservations === true;
  const groups: HindsightTagGroup[] = [];

  if (filters.tags?.length && filters.tagsMatch === "exact") {
    // "exact" is set-equality: a memory's tag set must equal this group's tags exactly.
    // AND-ing it with a separate mandatory scope-tag group (any_strict) would require the
    // memory to have the scope tags AND have exactly the caller's tags, which is
    // unsatisfiable unless the caller already knows the opaque scope tags. Fold the scope
    // tags into the exact set instead so scope isolation is preserved and the filter stays
    // satisfiable.
    const exactLeaf: HindsightTagGroup = {
      tags: [...new Set([...scopeTags, ...filters.tags])],
      match: "exact",
    };
    groups.push(includeShared ? withSharedObservations(exactLeaf) : exactLeaf);
  } else {
    if (scopeTags.length) {
      const scopeLeaf: HindsightTagGroup = { tags: scopeTags, match: "any_strict" };
      groups.push(includeShared ? withSharedObservations(scopeLeaf) : scopeLeaf);
    } else if (includeShared) {
      // No project scope tags (unusual) but shared opt-in: only untagged.
      groups.push(SHARED_UNTAGGED_TAG_GROUP);
    }
    if (filters.tags?.length)
      groups.push({ tags: filters.tags, match: filters.tagsMatch ?? "any_strict" });
  }
  if (filters.tagGroups?.length) groups.push(...filters.tagGroups);
  return groups.length ? { tagGroups: groups } : {};
}

function scopeTagGroups(scopeTags: string[], includeShared: boolean): HindsightTagGroup[] {
  const composed = composeScopedTagFilter(scopeTags, {
    includeSharedObservations: includeShared,
  });
  return "tagGroups" in composed ? composed.tagGroups : [];
}

export function selectMemoryScopes(cwd: string, config: ResolvedConfig): MemoryRecallScope[] {
  const identity = createMemoryIdentity(cwd, config);
  const scopes: MemoryRecallScope[] = [];
  // Shared observations apply only to the coding/project bank (cross-project prefs
  // inside one bank). Life/user bank keeps userScopeTags isolation (source:pi +
  // harness:pi by default so observations match observation-scope tags).
  const includeShared = config.scope.includeSharedObservations === true;

  for (const entry of readableBankEntries(config)) {
    const bankId = resolveEntryBankId(entry, identity.projectBankId);
    if (!bankId) continue;
    const isUser = entry.alias === "user";
    // tag rule: user alias → globalRecallTags; explicit tagGroups win; otherwise project tags.
    const tags = isUser ? identity.globalRecallTags : identity.projectRecallTags;
    // Shared observations stay scoped to project-semantics entries, as before.
    const withShared = includeShared && entry.alias !== "user";
    scopes.push({
      entryId: entry.id,
      kind: isUser ? "global" : "project",
      bankId,
      tagGroups: entry.tagGroups ?? scopeTagGroups(tags, withShared),
    });
  }

  return scopes;
}

/** Resolve the Hindsight bank id for an entry: explicit bankId, or coding-role derivation. */
function resolveEntryBankId(entry: BankConfigEntry, projectBankId: string): string | undefined {
  if (entry.bankId) return entry.bankId;
  // Only coding-semantics entries get a path-derived fallback; others need an explicit bankId.
  return entry.alias === "user" ? undefined : projectBankId;
}
