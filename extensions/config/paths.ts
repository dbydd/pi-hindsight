/**
 * Runtime-computed config path helpers.
 *
 * The host (pi or omp) owns the global config directory: pi resolves
 * `~/.pi/agent` via `getAgentDir()` (honoring `PI_CODING_AGENT_DIR`) and
 * `CONFIG_DIR_NAME`, omp remaps both through its legacy shim (honoring
 * `PI_CODING_AGENT_DIR`, `PI_CONFIG_DIR`, and profiles). Never hardcode `.pi`
 * or `$HOME` as a path base — probe the running host instead.
 */
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

/** Project-local config directory name for the running host (".pi" or ".omp"). */
export function hostConfigDirName(): string {
  if (typeof CONFIG_DIR_NAME === "string" && CONFIG_DIR_NAME) return CONFIG_DIR_NAME;
  return process.env.PI_CONFIG_DIR || ".pi";
}

/**
 * Global agent config directory for the running host, resolved from `env`.
 * The host probe (which covers omp profiles and XDG) is trusted only for the
 * live process env; an injected env resolves from its own variables alone.
 * Returns undefined when `env` carries no home information at all.
 */
export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const injected = env.PI_CODING_AGENT_DIR;
  if (injected) return injected;
  if (env === process.env) {
    try {
      const dir = getAgentDir();
      if (typeof dir === "string" && dir) return dir;
    } catch {
      // fall through to env-derived resolution
    }
  }
  const home = env.HOME;
  if (!home) return undefined;
  return join(home, env.PI_CONFIG_DIR || hostConfigDirName(), "agent");
}

/** Project-local hindsight runtime state directory. */
export function projectStateDir(cwd: string): string {
  return join(cwd, hostConfigDirName(), "hindsight");
}

/** Project-local hindsight config base path (without .json/.jsonc). */
export function projectConfigBasePath(cwd: string): string {
  return join(cwd, hostConfigDirName(), "hindsight");
}

/**
 * Global hindsight config base path (without .json/.jsonc), or undefined when
 * `env` carries no global config directory.
 */
export function globalConfigBasePath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const agentDir = resolveAgentDir(env);
  return agentDir === undefined ? undefined : join(agentDir, "hindsight");
}
