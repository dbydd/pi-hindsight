import type { ResolvedConfig } from "../types.js";
import { bankEntryEnabled, userBankEntry } from "../config/banks.js";

export function resolveOperationBank(args: {
  requestedBank: string | undefined;
  config: ResolvedConfig;
  projectBankId: string;
}): string {
  const requested = args.requestedBank?.trim();
  if (!requested || requested === "project") return args.projectBankId;
  if (requested === "global") {
    const user = userBankEntry(args.config);
    if (!user || !bankEntryEnabled(user))
      throw new Error("User Hindsight bank is disabled. Enable the user bank first.");
    if (!user.bankId) throw new Error("User Hindsight bank ID is not configured.");
    return user.bankId;
  }
  return requested;
}
