/**
 * Runtime-resolved host config paths.
 *
 * The host (pi or omp) owns the global config dir, and package constants cannot be
 * trusted to identify it: a pi-hindsight copy loaded by omp resolves
 * `@earendil-works/*` from its own tree, and that copy reports pi's `.pi` and
 * `~/.pi/agent` even inside an omp process. Runtime truth therefore outranks the
 * constants, in this order:
 *
 *   1. `PI_CODING_AGENT_DIR` / `PI_CONFIG_DIR` — explicit override, both hosts honor them
 *   2. the live session file — `<config dir>/agent/sessions/<project>/<file>.jsonl`
 *   3. `@oh-my-pi/pi-utils/dirs` — shipped in the omp plugin tree, absent from pi's
 *   4. `@earendil-works/pi-coding-agent` — correct under pi
 *   5. `$HOME/<dir>/agent` — `<dir>` is `PI_CONFIG_DIR` or `.pi`
 *
 * Levels 2-4 describe the live process. An injected env (tests, diagnostics) resolves
 * from its own variables plus an explicit `sessionFile`, never from ambient state, so
 * tests cannot accidentally read the developer's real config.
 */
import { basename, dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { isRecord } from "./is-record.js";

const CONFIG_DIR_FALLBACK = ".pi";
const AGENT_DIR_NAME = "agent";
const SESSIONS_DIR_NAME = "sessions";
const SESSION_FILE_SUFFIX = ".jsonl";

export interface HostPathsOptions {
  /** Environment to resolve from; defaults to the live process env. */
  env?: NodeJS.ProcessEnv | undefined;
  /** Session file of the live session, when its caller knows it. */
  sessionFile?: string | undefined;
}

export interface HostDirsModule {
  CONFIG_DIR_NAME?: unknown;
  getAgentDir?: () => unknown;
}

export type HostDirsLoader = () => Promise<HostDirsModule>;

let runtimeSessionFile: string | undefined;
let probedHostDirs: { agentDir?: string; configDirName?: string } | undefined;
let probeRun: Promise<void> | undefined;

/** Session file of the live session; in-memory sessions have none. */
export function setRuntimeSessionFile(sessionFile: string | undefined): void {
  runtimeSessionFile = sessionFile;
}

/**
 * Agent dir behind a session file:
 * `<config dir>/agent/sessions/<project>/<file>.jsonl`. Shape-checked, so an
 * unexpected layout returns undefined instead of a guess.
 */
export function agentDirFromSessionFile(sessionFile: string | undefined): string | undefined {
  if (!sessionFile || !sessionFile.endsWith(SESSION_FILE_SUFFIX)) return undefined;
  const projectDir = dirname(sessionFile);
  const sessionsDir = dirname(projectDir);
  const agentDir = dirname(sessionsDir);
  if (basename(sessionsDir) !== SESSIONS_DIR_NAME) return undefined;
  if (basename(agentDir) !== AGENT_DIR_NAME) return undefined;
  if (projectDir === sessionsDir || agentDir === sessionsDir) return undefined;
  return agentDir;
}

/**
 * Load omp's dirs surface, or nothing where the host ships no such module.
 *
 * One `try` per candidate, each wrapping a single literal `import()`: omp ships as
 * one bundled file whose `@oh-my-pi/*` specifiers were rewritten at build time, so
 * a computed specifier resolves against bare node instead and misses even on omp —
 * which is why this probe never fired there. Hence no variable specifier and no
 * loop. `@oh-my-pi/pi-utils/dirs` was that miss: it is absent from omp's bundled
 * table, whereas `pi-coding-agent` root exports both `getAgentDir` and
 * `CONFIG_DIR_NAME` — verified against omp 18.11.1.
 */
async function loadOmpHostDirs(): Promise<HostDirsModule> {
  try {
    const loaded = await import("@oh-my-pi/pi-coding-agent");
    return isRecord(loaded) ? (loaded as unknown as HostDirsModule) : {};
  } catch {
    // No such module on this host; the next candidate may still answer.
  }
  try {
    const loaded = await import("@oh-my-pi/pi-utils/dirs");
    return isRecord(loaded) ? (loaded as unknown as HostDirsModule) : {};
  } catch {
    // Same absence, second candidate.
  }
  return {};
}

/**
 * Read one host-reported value, tolerating a host that refuses to resolve dirs before
 * its bootstrap ran, or that reports a non-string.
 */
function hostReportedString(read: () => unknown): string | undefined {
  try {
    const value = read();
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function profileFromHostDirs(mod: HostDirsModule): { agentDir?: string; configDirName?: string } {
  const agentDir = mod.getAgentDir ? hostReportedString(mod.getAgentDir) : undefined;
  const configDirName = hostReportedString(() => mod.CONFIG_DIR_NAME);
  return { ...(agentDir ? { agentDir } : {}), ...(configDirName ? { configDirName } : {}) };
}

/**
 * Probe level 3 once per process. `loader` is injectable so the omp branch can be
 * tested without an omp install; the default resolves the omp plugin tree.
 */
export function probeHostDirs(loader: HostDirsLoader = loadOmpHostDirs): Promise<void> {
  probeRun ??= (async () => {
    try {
      const probed = profileFromHostDirs(await loader());
      probedHostDirs = probed.agentDir || probed.configDirName ? probed : undefined;
    } catch {
      // pi's tree ships no @oh-my-pi/*: the earendil constants stay authoritative.
    }
  })();
  return probeRun;
}

/** Forget a previous probe result; process-wide state needs this between tests. */
export function resetHostProbe(): void {
  probedHostDirs = undefined;
  probeRun = undefined;
}

function configDirNameFromAgentDir(agentDir: string): string | undefined {
  const name = basename(dirname(agentDir));
  return name.length > 0 && name !== "/" && name !== "." ? name : undefined;
}

function liveHostAgentDir(): string | undefined {
  return hostReportedString(getAgentDir);
}

interface HostProfile {
  agentDir: string | undefined;
  configDirName: string;
}

function hostProfile(options: HostPathsOptions): HostProfile {
  const env = options.env ?? process.env;
  const live = env === process.env;
  const sessionFile = options.sessionFile ?? (live ? runtimeSessionFile : undefined);
  const sessionAgentDir = agentDirFromSessionFile(sessionFile);
  const sessionDirName = sessionAgentDir ? configDirNameFromAgentDir(sessionAgentDir) : undefined;
  const probe = live ? probedHostDirs : undefined;
  const packageDirName = hostReportedString(() => CONFIG_DIR_NAME);
  const configDirName =
    env.PI_CONFIG_DIR ||
    sessionDirName ||
    probe?.configDirName ||
    (live ? packageDirName : undefined) ||
    CONFIG_DIR_FALLBACK;
  const agentDir =
    env.PI_CODING_AGENT_DIR ||
    sessionAgentDir ||
    probe?.agentDir ||
    (live ? liveHostAgentDir() : undefined) ||
    (env.HOME ? join(env.HOME, configDirName, AGENT_DIR_NAME) : undefined);
  return { agentDir, configDirName };
}

/** Project-local config directory name for the running host (".pi" or ".omp"). */
export function hostConfigDirName(options: HostPathsOptions = {}): string {
  return hostProfile(options).configDirName;
}

/**
 * Global agent config directory, or undefined when the environment names no location
 * and no host reports one.
 */
export function resolveAgentDir(options: HostPathsOptions = {}): string | undefined {
  return hostProfile(options).agentDir;
}

/** Project-local hindsight runtime state directory. */
export function projectStateDir(cwd: string, options: HostPathsOptions = {}): string {
  return join(cwd, hostConfigDirName(options), "hindsight");
}

/** Project-local hindsight config base path (without .json/.jsonc). */
export function projectConfigBasePath(cwd: string, options: HostPathsOptions = {}): string {
  return join(cwd, hostConfigDirName(options), "hindsight");
}

/** Global hindsight config base path (without .json/.jsonc). */
export function globalConfigBasePath(options: HostPathsOptions = {}): string | undefined {
  const agentDir = resolveAgentDir(options);
  return agentDir === undefined ? undefined : join(agentDir, "hindsight");
}
