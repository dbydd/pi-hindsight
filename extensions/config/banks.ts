import type {
  BankAccess,
  BankAlias,
  BankConfigEntry,
  BankDerive,
  BankEntryMission,
  BankEntryRecallSettings,
  BankEntryRetainSettings,
  BankMissionSettings,
  BankRetainMode,
  ResolvedConfig,
} from "../types.js";

export const BANK_ACCESS_VALUES = ["read", "write", "read-write"] as const;
export const BANK_ALIAS_VALUES = ["project", "user"] as const;
export const BANK_DERIVE_VALUES = ["repo", "cwd", "manual", "basename"] as const;
export const BANK_RETAIN_MODE_VALUES = ["always", "decision", "explicit-only"] as const;

/** Legacy three-slot keys and their role aliases (ADR-005 role names). */
const LEGACY_PROJECT_KEYS = ["project", "coding"] as const;
const LEGACY_USER_KEYS = ["user", "global", "life"] as const;

/**
 * Reserved role names an entry may carry as its `id` instead of repeating them in
 * `alias`: `{ "id": "project" }` and `{ "alias": "project" }` mean the same entry.
 */
const RESERVED_BANK_ALIAS: Record<string, BankAlias> = { project: "project", user: "user" };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function positiveIntOr(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Read path (recall / bank selection) may use anything but write-only entries. */
export function canReadBank(entry: { access?: BankAccess }): boolean {
  return entry.access !== "write";
}

/** Write path (retain / routing) may use anything but read-only entries. */
export function canWriteBank(entry: { access?: BankAccess }): boolean {
  return entry.access !== "read";
}

/** `enabled` defaults to true; only an explicit false disables a bank. */
export function bankEntryEnabled(entry: { enabled?: boolean }): boolean {
  return entry.enabled !== false;
}

function missionFromRaw(raw: unknown): BankEntryMission | undefined {
  if (!isRecord(raw)) return undefined;
  const out: BankEntryMission = {};
  const retain = trimmedString(raw.retain);
  if (retain) out.retain = retain;
  const reflect = trimmedString(raw.reflect);
  if (reflect) out.reflect = reflect;
  const observations = trimmedString(raw.observations);
  if (observations) out.observations = observations;
  const chunkSize = positiveIntOr(raw.retainStructuredChunkSize);
  if (chunkSize) out.retainStructuredChunkSize = chunkSize;
  return Object.keys(out).length > 0 ? out : undefined;
}

function recallFromRaw(raw: unknown): BankEntryRecallSettings | undefined {
  if (!isRecord(raw)) return undefined;
  const out: BankEntryRecallSettings = {};
  const enabled = raw.enabled;
  if (typeof enabled === "boolean") out.enabled = enabled;
  const maxTokens = positiveIntOr(raw.maxTokens);
  if (maxTokens) out.maxTokens = maxTokens;
  const preamble = trimmedString(raw.preamble);
  if (preamble) out.preamble = preamble;
  return Object.keys(out).length > 0 ? out : undefined;
}

function retainFromRaw(raw: unknown): BankEntryRetainSettings | undefined {
  if (!isRecord(raw)) return undefined;
  const out: BankEntryRetainSettings = {};
  const enabled = raw.enabled;
  if (typeof enabled === "boolean") out.enabled = enabled;
  const mode = oneOf(raw.mode, BANK_RETAIN_MODE_VALUES);
  if (mode) out.mode = mode;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Validate one `banks[]` entry. Invalid entries are dropped rather than half-applied:
 * duplicate ids resolve to the first occurrence.
 */
export function normalizeBankEntry(raw: unknown): BankConfigEntry | undefined {
  if (!isRecord(raw)) return undefined;
  const declaredId = trimmedString(raw.id);
  // Shortest form is `{ "alias": "project" }`: the alias then supplies the id.
  const declaredAlias = oneOf(raw.alias, BANK_ALIAS_VALUES);
  const alias =
    declaredAlias ??
    (declaredId && Object.hasOwn(RESERVED_BANK_ALIAS, declaredId)
      ? RESERVED_BANK_ALIAS[declaredId]
      : undefined);
  const id = declaredId ?? alias;
  if (!id) return undefined;
  const entry: BankConfigEntry = { id };
  if (alias) entry.alias = alias;
  const bankId = trimmedString(raw.bankId);
  if (bankId) entry.bankId = bankId;
  if (typeof raw.enabled === "boolean") entry.enabled = raw.enabled;
  // Invalid access falls back to the read-write default instead of dropping the entry.
  const access = oneOf(raw.access, BANK_ACCESS_VALUES);
  if (access) entry.access = access;
  const description = trimmedString(raw.description);
  if (description) entry.description = description;
  // Derivation names the coding entry's bank, so it carries no meaning elsewhere.
  if (alias === "project") {
    const derive = oneOf(raw.derive, BANK_DERIVE_VALUES);
    if (derive) entry.derive = derive;
  }
  const mission = missionFromRaw(raw.mission);
  if (mission) entry.mission = mission;
  const recall = recallFromRaw(raw.recall);
  if (recall) entry.recall = recall;
  const retain = retainFromRaw(raw.retain);
  if (retain) entry.retain = retain;
  if (Array.isArray(raw.tagGroups) && raw.tagGroups.length > 0) {
    entry.tagGroups = raw.tagGroups as NonNullable<BankConfigEntry["tagGroups"]>;
  }
  return entry;
}

/** Legacy mission field names still accepted on a legacy three-slot bank object. */
function legacyMission(raw: Record<string, unknown>): BankEntryMission | undefined {
  const out: BankEntryMission = {};
  const retain = trimmedString(raw.retainMission);
  if (retain) out.retain = retain;
  const reflect = trimmedString(raw.reflectMission);
  if (reflect) out.reflect = reflect;
  const observations = trimmedString(raw.observationsMission);
  if (observations) out.observations = observations;
  const chunkSize = positiveIntOr(raw.retainStructuredChunkSize);
  if (chunkSize) out.retainStructuredChunkSize = chunkSize;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * One legacy slot object, read through the same field mapping as an array entry so
 * the shim and the array form cannot drift. The slot's role names win over the raw
 * object, and the flat mission field names legacy configs carry are folded in.
 */
function legacySlotEntry(raw: unknown, id: string, alias: BankAlias): BankConfigEntry | undefined {
  if (!isRecord(raw)) return undefined;
  const entry = normalizeBankEntry({ ...raw, id, alias });
  if (!entry) return undefined;
  const mission = entry.mission ?? legacyMission(raw);
  return mission ? { ...entry, mission } : entry;
}

function legacySlotRaw(
  banks: Record<string, unknown>,
  keys: readonly string[],
): { id: string; raw: unknown } | undefined {
  // Later keys win as an overlay: `user` beats legacy `global`, `project` beats `coding`.
  const present = keys.filter((key) => isRecord(banks[key]));
  if (present.length === 0) return undefined;
  const primary = present.at(-1)!;
  let merged: Record<string, unknown> = {};
  for (const key of present) merged = { ...merged, ...(banks[key] as Record<string, unknown>) };
  return { id: primary, raw: merged };
}

/**
 * Read-side shim: legacy object-shaped `banks` (project/coding, user/global/life) → array.
 * Returns undefined when the object carries no legacy slot, so defaults stay in place.
 */
export function legacyBanksToEntries(
  banks: Record<string, unknown>,
): BankConfigEntry[] | undefined {
  const entries: BankConfigEntry[] = [];
  const project = legacySlotRaw(banks, LEGACY_PROJECT_KEYS);
  if (project) {
    const entry = legacySlotEntry(project.raw, "project", "project");
    if (entry) entries.push(entry);
  }
  const user = legacySlotRaw(banks, LEGACY_USER_KEYS);
  if (user) {
    // `global` is the historical alias of the same user bank: keep one entry.
    const entry = legacySlotEntry(user.raw, user.id === "global" ? "global" : "user", "user");
    if (entry) entries.push(entry);
  }
  return entries.length > 0 ? entries : undefined;
}

/** Normalize any `banks` value (array, legacy object, junk) into a validated array. */
export function normalizeBankEntries(
  value: unknown,
  fallback: BankConfigEntry[] = [],
): BankConfigEntry[] {
  if (Array.isArray(value)) {
    const seen = new Set<string>();
    const entries: BankConfigEntry[] = [];
    for (const raw of value) {
      const entry = normalizeBankEntry(raw);
      if (!entry || seen.has(entry.id)) continue;
      seen.add(entry.id);
      entries.push(entry);
    }
    return entries;
  }
  if (isRecord(value)) return legacyBanksToEntries(value) ?? [...fallback];
  return [...fallback];
}

/**
 * Layer merge for `banks`: field-level merge by `id`, one extra level for
 * mission/recall/retain, `tagGroups` replaced. New ids append to the tail so
 * recall assembly order stays stable.
 *
 * An overlay entry whose `id` is unknown but whose `alias` matches an existing
 * entry merges into it: that is what keeps a legacy `project`/`global` slot
 * landing on the default `coding`/`life` entry instead of creating a duplicate.
 */
export function mergeBankEntries(base: unknown, overlay: unknown): BankConfigEntry[] {
  const out = normalizeBankEntries(base);
  for (const entry of normalizeBankEntries(overlay)) {
    const byId = out.findIndex((candidate) => candidate.id === entry.id);
    const index =
      byId >= 0
        ? byId
        : entry.alias
          ? out.findIndex((candidate) => candidate.alias === entry.alias)
          : -1;
    if (index < 0) {
      out.push({ ...entry });
      continue;
    }
    const current = out[index]!;
    out[index] = {
      ...current,
      ...entry,
      ...(current.mission || entry.mission
        ? { mission: { ...current.mission, ...entry.mission } }
        : {}),
      ...(current.recall || entry.recall ? { recall: { ...current.recall, ...entry.recall } } : {}),
      ...(current.retain || entry.retain ? { retain: { ...current.retain, ...entry.retain } } : {}),
    };
  }
  return out;
}

/** `banksFallback` is replaced wholesale, never merged between layers. */
export function normalizeBanksFallback(value: unknown, banks: BankConfigEntry[]): string[] {
  if (!Array.isArray(value)) return [];
  const known = new Set(banks.map((entry) => entry.id));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const id = trimmedString(item);
    if (!id || seen.has(id) || !known.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function bankEntryFor(config: ResolvedConfig, id: string): BankConfigEntry | undefined {
  return config.banks.find((entry) => entry.id === id);
}

export function bankEntryForBankId(
  config: ResolvedConfig,
  bankId: string,
): BankConfigEntry | undefined {
  return config.banks.find((entry) => entry.bankId === bankId);
}

/** Coding-role bank: the `project` alias entry, or the first entry when none is aliased. */
export function codingBankEntry(config: ResolvedConfig): BankConfigEntry | undefined {
  return (
    config.banks.find((entry) => entry.alias === "project") ??
    config.banks.find((entry) => entry.id === "project") ??
    config.banks[0]
  );
}

/** Life/user-role bank: the `user` alias entry (legacy `global` slot included). */
export function userBankEntry(config: ResolvedConfig): BankConfigEntry | undefined {
  return config.banks.find((entry) => entry.alias === "user");
}

export function readableBankEntries(config: ResolvedConfig): BankConfigEntry[] {
  return config.banks.filter((entry) => bankEntryEnabled(entry) && canReadBank(entry));
}

export function writableBankEntries(config: ResolvedConfig): BankConfigEntry[] {
  return config.banks.filter((entry) => bankEntryEnabled(entry) && canWriteBank(entry));
}

/** Entry missions mapped onto the flat shape the bank ensure path expects. */
export function bankMissionSettings(entry: BankConfigEntry | undefined): BankMissionSettings {
  const mission = entry?.mission;
  const out: BankMissionSettings = {};
  if (!mission) return out;
  if (mission.retain) out.retainMission = mission.retain;
  if (mission.reflect) out.reflectMission = mission.reflect;
  if (mission.observations) out.observationsMission = mission.observations;
  if (mission.retainStructuredChunkSize) {
    out.retainStructuredChunkSize = mission.retainStructuredChunkSize;
  }
  return out;
}

/**
 * Config path lookup that understands `banks` arrays: a path segment inside an
 * array matches the entry whose `id` or `alias` equals that segment.
 */
export function valueAtBankPath(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const part of path) {
    if (Array.isArray(current)) {
      const match = current.find(
        (item) => isRecord(item) && (item.id === part || item.alias === part),
      );
      if (match === undefined) return undefined;
      current = match;
      continue;
    }
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

/** Delete along a config path, resolving `banks` array entries by id/alias. */
export function deleteAtBankPath(value: unknown, path: readonly string[]): void {
  const [head, ...rest] = path;
  if (!head) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (isRecord(item) && (item.id === head || item.alias === head)) deleteAtBankPath(item, rest);
    }
    return;
  }
  if (!isRecord(value)) return;
  if (rest.length === 0) {
    delete value[head];
    return;
  }
  deleteAtBankPath(value[head], rest);
}
