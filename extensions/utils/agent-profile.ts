import { isRecord } from "../config/is-record.js";

/**
 * Name of the subagent profile a session runs, or nothing for a main session.
 *
 * Only omp publishes this: its extension context carries `agent`, and a spawned
 * session reports `{ kind: "sub", name: <agent definition name> }`. pi's context
 * has no such field, so a pi session always resolves `undefined` and keeps the
 * `hindsight.json` behavior it had before profile overrides existed.
 *
 * The name is the profile key in `hindsight-subagent.json`. A subagent spawned
 * without a definition reports `"sub"`, which is a usable key but not a profile
 * anyone configures; it inherits the main config like any unmatched name.
 */
export function subagentProfileName(ctx: unknown): string | undefined {
  if (!isRecord(ctx)) return undefined;
  const agent = ctx.agent;
  if (!isRecord(agent) || agent.kind !== "sub") return undefined;
  const name = agent.name;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
}
