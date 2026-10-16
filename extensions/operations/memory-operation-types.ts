import type { HindsightLikeClient, ResolvedConfig } from "../types.js";
import type { ProjectConfigPatchInput } from "../config/config-writer.js";
import type { InitHealth } from "../lifecycle/memory-lifecycle.js";
import type { HostMemoryBackend } from "../config/omp-config.js";

import type { RetrievalObserver } from "../lifecycle/retrieval-telemetry.js";

export interface MemoryOperationsDeps {
  observer?: RetrievalObserver;
  getClient(): HindsightLikeClient;
  getConfig(): ResolvedConfig;
  getProjectBankId(): string;
  getInitHealth?(): InitHealth | undefined;
  reloadConfig?(cwd: string): void;
  /**
   * omp built-in memory-backend fact for status/doctor. Injectable so tests never spawn
   * omp; the default reads through the omp config CLI and short-circuits on non-omp hosts.
   */
  getHostMemoryBackend?(): Promise<HostMemoryBackend>;
}

export type ConfigureMemoryArgs = ProjectConfigPatchInput;
