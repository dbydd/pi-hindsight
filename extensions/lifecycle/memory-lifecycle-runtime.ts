import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getSessionFile } from "../utils/session.js";
import { subagentProfileName } from "../utils/agent-profile.js";
import { formatHindsightStatus, type HindsightActivity } from "../utils/status.js";
import type { ResolvedConfig } from "../types.js";

export type RuntimeCtx = {
  cwd: string;
  ui: {
    setStatus(key: string, text: string | undefined): void;
    notify(message: string, level?: string): void;
  };
  sessionManager?: { getSessionFile?: () => string | undefined };
  /** Pi agent abort signal for the active turn, when the context hook provides one. */
  signal?: AbortSignal | undefined;
  /** omp subagent identity, when the host publishes one. */
  agent?: unknown;
};

export type RuntimeSnapshot = {
  cwd: string;
  ui: RuntimeCtx["ui"];
  sessionFile?: string;
  signal?: AbortSignal | undefined;
  /** Subagent profile this session runs; absent in a main session. */
  agentName?: string;
};

export type ContextEvent = { messages: AgentMessage[] };
export type ContextPatch = { messages: AgentMessage[] };

export function snapshotRuntime(ctx: RuntimeCtx): RuntimeSnapshot | undefined {
  try {
    const cwd = ctx.cwd;
    const ui = ctx.ui;
    const sessionFile = getSessionFile(ctx);
    const signal = ctx.signal;
    const agentName = subagentProfileName(ctx);
    return {
      cwd,
      ui,
      ...(sessionFile ? { sessionFile } : {}),
      ...(signal ? { signal } : {}),
      ...(agentName ? { agentName } : {}),
    };
  } catch {
    return undefined;
  }
}

export function setMemoryStatus(args: {
  runtime: RuntimeSnapshot;
  config: ResolvedConfig;
  projectBankId: string;
  activity: HindsightActivity;
  memoryCount?: number;
  queueRemaining?: number;
}): void {
  try {
    args.runtime.ui.setStatus(
      "hindsight",
      formatHindsightStatus(args.config, {
        projectBankId: args.projectBankId,
        cwd: args.runtime.cwd,
        activity: args.activity,
        ...(args.memoryCount !== undefined ? { memoryCount: args.memoryCount } : {}),
        ...(args.queueRemaining !== undefined ? { queueRemaining: args.queueRemaining } : {}),
      }),
    );
  } catch {
    // Session ctx can go stale during replacement/reload; status is best effort.
  }
}

export function notify(runtime: RuntimeSnapshot, message: string, level: string): void {
  try {
    runtime.ui.notify(message, level);
  } catch {
    // Session ctx can go stale during replacement/reload; notifications are best effort.
  }
}
