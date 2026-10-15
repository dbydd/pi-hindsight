import {
  emitRetrieval,
  telemetryEvent,
  retrievalId,
  type RetrievalObserver,
} from "./retrieval-telemetry.js";
import type { AgentEndEvent } from "@earendil-works/pi-coding-agent";
import { resolveConfig } from "../config/config.js";
import { consumeLastConfigMigrationResults } from "../config/config.js";
import { isMemorySetupComplete, setupRequiredMessage } from "../config/setup-gate.js";
import { probeHostDirs, setRuntimeSessionFile } from "../config/paths.js";
import { deriveProjectBankId } from "../banks/banking.js";
import {
  bankEntryEnabled,
  bankMissionSettings,
  canWriteBank,
  codingBankEntry,
  userBankEntry,
} from "../config/banks.js";
import { createHindsightClient } from "../client/client.js";
import { ensureGlobalBank, ensureProjectBank } from "../banks/bank-operations.js";
import { flushRetainQueue, retainQueuePath } from "../queue/queue.js";
import { recordRetainDeliveries } from "./retain.js";
import { formatFlushRetainQueueResult } from "../queue/flush-presenter.js";
import { bankSelectionMessage } from "../utils/diagnostics.js";
import type { HindsightLikeClient, ResolvedConfig } from "../types.js";
import { redactError } from "../utils/sanitize.js";
import {
  notify,
  setMemoryStatus as setRuntimeMemoryStatus,
  snapshotRuntime,
  type ContextEvent,
  type ContextPatch,
  type RuntimeCtx,
  type RuntimeSnapshot,
} from "./memory-lifecycle-runtime.js";
import { createRetainTurnPolicy } from "./memory-lifecycle-retain.js";
import { createRecallTurnPolicy } from "./memory-lifecycle-recall.js";

export interface InitHealthFailure {
  subsystem: "project-bank" | "user-bank";
  error: string;
}

export interface InitHealth {
  checkedAt: string;
  failures: InitHealthFailure[];
}

export interface MemoryLifecycleDeps {
  observer?: RetrievalObserver;
  getClient(): HindsightLikeClient;
  getConfig(): ResolvedConfig;
  getProjectBankId(): string;
  getInitHealth(): InitHealth | undefined;
  reloadConfig(cwd: string, sessionFile?: string): void;
}

export interface MemoryLifecycle {
  deps: MemoryLifecycleDeps;
  initialize(ctx: RuntimeCtx): Promise<void>;
  recall(event: ContextEvent, ctx: RuntimeCtx): Promise<ContextPatch | undefined>;
  retain(
    event: AgentEndEvent,
    ctx: RuntimeCtx,
  ): Promise<{ queued: boolean; sent: number; remaining: number }>;
  shutdown(ctx: RuntimeCtx): Promise<void>;
}

export function createMemoryLifecycle(
  initialCwd: string = process.cwd(),
  observer?: RetrievalObserver,
): MemoryLifecycle {
  let config: ResolvedConfig = resolveConfig(initialCwd);
  let client: HindsightLikeClient = createHindsightClient(config);
  let projectBankId = deriveProjectBankId(initialCwd, config);
  let initHealth: InitHealth | undefined;
  let periodicFlush: NodeJS.Timeout | undefined;
  let periodicFlushActive = false;
  const stopPeriodicFlush = () => {
    if (!periodicFlush) return;
    clearInterval(periodicFlush);
    periodicFlush = undefined;
  };

  const reloadConfig = (cwd: string, sessionFile?: string) => {
    stopPeriodicFlush();
    config = resolveConfig(cwd, process.env, sessionFile);
    client = createHindsightClient(config);
    projectBankId = deriveProjectBankId(cwd, config);
  };

  const startPeriodicFlush = (runtime: RuntimeSnapshot) => {
    stopPeriodicFlush();
    if (!config.enabled || !config.retain.enabled || config.retain.flushIntervalMs <= 0) return;
    if (!isMemorySetupComplete(config, runtime.cwd)) return;
    const queuePath = retainQueuePath(runtime.cwd, config);
    periodicFlush = setInterval(() => {
      if (periodicFlushActive) return;
      periodicFlushActive = true;
      void flushRetainQueue(queuePath, client, {
        stopOnFirstFailure: true,
        maxJobs: config.retain.periodicFlushMaxJobs,
        maxElapsedMs: config.retain.periodicFlushTimeoutMs,
      })
        .then(async (result) => {
          await recordRetainDeliveries(runtime.cwd, config, result);
          if (result.deadLettered || result.remaining) {
            notify(runtime, formatFlushRetainQueueResult(result), "warning");
          }
        })
        .catch((error) => {
          notify(runtime, `Periodic retain queue flush failed: ${redactError(error)}`, "warning");
        })
        .finally(() => {
          periodicFlushActive = false;
        });
    }, config.retain.flushIntervalMs);
    periodicFlush.unref?.();
  };

  const setMemoryStatus = (
    runtime: RuntimeSnapshot,
    activity: Parameters<typeof setRuntimeMemoryStatus>[0]["activity"],
    memoryCount?: number,
    queueRemaining?: number,
  ) =>
    setRuntimeMemoryStatus({
      runtime,
      config,
      projectBankId,
      activity,
      ...(memoryCount !== undefined ? { memoryCount } : {}),
      ...(queueRemaining !== undefined ? { queueRemaining } : {}),
    });

  const deps: MemoryLifecycleDeps = {
    ...(observer ? { observer } : {}),
    getClient: () => client,
    getConfig: () => config,
    getProjectBankId: () => projectBankId,
    getInitHealth: () => initHealth,
    reloadConfig,
  };

  const retainPolicy = createRetainTurnPolicy({
    getConfig: () => config,
    getClient: () => client,
    getProjectBankId: () => projectBankId,
    setMemoryStatus: (runtime, activity, queueRemaining) =>
      setMemoryStatus(runtime, activity, undefined, queueRemaining),
    notify,
  });

  const recallPolicy = createRecallTurnPolicy({
    ...(observer ? { observer } : {}),
    getConfig: () => config,
    getClient: () => client,
    setMemoryStatus: (runtime, activity, memoryCount) =>
      setMemoryStatus(runtime, activity, memoryCount),
    notify,
  });

  return {
    deps,

    async initialize(ctx: RuntimeCtx): Promise<void> {
      const runtime = snapshotRuntime(ctx);
      if (!runtime) return;
      // Host paths (`.pi` vs `.omp`) come from runtime truth: the live session file
      // first, the host package probe second. Both must land before any config read.
      setRuntimeSessionFile(runtime.sessionFile);
      await probeHostDirs();
      reloadConfig(runtime.cwd, runtime.sessionFile);
      const migrations = consumeLastConfigMigrationResults();
      if (migrations.length) {
        notify(
          runtime,
          `Migrated Hindsight memory config from global to user keys. Backups: ${migrations
            .map((migration) => migration.backupPath)
            .join(", ")}`,
          "info",
        );
      }
      if (!config.enabled) {
        // Clear status bar when extension is disabled for this repo.
        try {
          runtime.ui.setStatus("hindsight", undefined);
        } catch {
          // Session ctx can go stale; status clear is best effort.
        }
        return;
      }
      if (!isMemorySetupComplete(config, runtime.cwd)) {
        initHealth = { checkedAt: new Date().toISOString(), failures: [] };
        setMemoryStatus(runtime, "idle");
        if (config.notifications.startup) notify(runtime, setupRequiredMessage(), "warning");
        return;
      }
      const failures: InitHealthFailure[] = [];
      let ensureSucceeded = false;
      const coding = codingBankEntry(config);
      if (coding && bankEntryEnabled(coding)) {
        try {
          await ensureProjectBank(client, projectBankId, {
            ...bankMissionSettings(coding),
            enableObservations: config.observations.enabled,
          });
          ensureSucceeded = true;
        } catch (error) {
          failures.push({ subsystem: "project-bank", error: redactError(error) });
          setMemoryStatus(runtime, "offline");
          notify(runtime, `Hindsight project bank ensure failed: ${redactError(error)}`, "warning");
        }
      }
      const user = userBankEntry(config);
      if (user && bankEntryEnabled(user) && user.bankId) {
        try {
          await ensureGlobalBank(client, user.bankId, {
            ...bankMissionSettings(user),
            enableObservations: config.observations.enabled,
            agentUse: config.agentUse,
          });
          ensureSucceeded = true;
        } catch (error) {
          failures.push({ subsystem: "user-bank", error: redactError(error) });
          setMemoryStatus(runtime, "offline");
          notify(runtime, `Hindsight global bank ensure failed: ${redactError(error)}`, "warning");
        }
      }
      initHealth = { checkedAt: new Date().toISOString(), failures };
      startPeriodicFlush(runtime);
      setMemoryStatus(
        runtime,
        failures.length ? "offline" : ensureSucceeded ? "connected" : "idle",
      );
      if (config.notifications.startup)
        notify(runtime, bankSelectionMessage(projectBankId, config), "info");
    },

    async recall(event: ContextEvent, ctx: RuntimeCtx): Promise<ContextPatch | undefined> {
      const skip = (reason: string) => {
        emitRetrieval(observer, () =>
          telemetryEvent(Date.now(), {
            phase: "injection",
            mode: "automatic",
            cache: "none",
            status: "skipped",
            contextId: retrievalId(),
            injected: false,
            retrievalIds: [],
            reason,
          }),
        );
        return undefined;
      };
      if (!config.enabled || !config.recall.enabled) return skip("disabled");
      const runtime = snapshotRuntime(ctx);
      if (!runtime) return skip("runtime-unavailable");
      if (!isMemorySetupComplete(config, runtime.cwd)) return skip("setup-incomplete");
      return recallPolicy.recall(event, runtime);
    },

    async retain(
      event: AgentEndEvent,
      ctx: RuntimeCtx,
    ): Promise<{ queued: boolean; sent: number; remaining: number }> {
      const canRetainProject = Boolean(
        codingBankEntry(config) &&
        bankEntryEnabled(codingBankEntry(config)!) &&
        canWriteBank(codingBankEntry(config)!),
      );
      const userForRetain = userBankEntry(config);
      const canRetainUser = Boolean(
        userForRetain &&
        bankEntryEnabled(userForRetain) &&
        canWriteBank(userForRetain) &&
        userForRetain.bankId,
      );
      if (!config.enabled || !config.retain.enabled || (!canRetainProject && !canRetainUser))
        return { queued: false, sent: 0, remaining: 0 };
      const runtime = snapshotRuntime(ctx);
      if (!runtime) return { queued: false, sent: 0, remaining: 0 };
      if (!isMemorySetupComplete(config, runtime.cwd))
        return { queued: false, sent: 0, remaining: 0 };
      return retainPolicy.retain(event, runtime);
    },

    async shutdown(ctx: RuntimeCtx): Promise<void> {
      stopPeriodicFlush();
      if (!config.enabled || !config.retain.enabled) return;
      const runtime = snapshotRuntime(ctx);
      if (!runtime) return;
      if (!isMemorySetupComplete(config, runtime.cwd)) return;
      try {
        const result = await flushRetainQueue(retainQueuePath(runtime.cwd, config), client, {
          maxJobs: config.retain.shutdownFlushMaxJobs,
          maxElapsedMs: config.retain.shutdownFlushTimeoutMs,
          stopOnFirstFailure: true,
        });
        await recordRetainDeliveries(runtime.cwd, config, result);
        if (result.deadLettered || result.remaining) {
          notify(runtime, formatFlushRetainQueueResult(result), "warning");
        }
      } catch (error) {
        notify(runtime, `Shutdown retain queue flush failed: ${redactError(error)}`, "warning");
        // Keep queue on disk for next run.
      }
    },
  };
}
