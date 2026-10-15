import type { ResolvedConfig } from "../../extensions/types.js";
import { DEFAULT_CONFIG } from "../../extensions/config/config.js";
import { mergeBankEntries } from "../../extensions/config/banks.js";

/**
 * Build a `banks` array from overrides. Accepts both legacy slot-shaped objects
 * (`project`, `user`, `global`, `coding`, `life`) and array entries, and applies the
 * same shim + id/alias merge the resolver uses, so fixtures written against the old
 * three-slot config keep their meaning.
 */
/**
 * Patch shape for fixture helpers: `banks` accepts the legacy slot object or the
 * new entry array, everything else is a normal partial config.
 */
export type BanksPatch = Omit<Partial<ResolvedConfig>, "banks"> & { banks?: unknown };

export function banks(...overrides: unknown[]): ResolvedConfig["banks"] {
  let out: unknown = DEFAULT_CONFIG.banks;
  for (const override of overrides) out = mergeBankEntries(out, override);
  return out as ResolvedConfig["banks"];
}
