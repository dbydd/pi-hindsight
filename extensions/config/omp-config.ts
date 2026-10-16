/**
 * omp-side settings access through omp's own config CLI.
 *
 * The pi extension API exposes `getSettings()`, but omp's extension API does not:
 * its only public programmatic channel is the `omp config` CLI. That matters for one
 * concrete job — detecting (and switching) omp's built-in Hindsight memory backend so
 * a session does not end up with two memory entry points writing two banks.
 *
 * Reads may happen automatically (status/doctor); writes happen only on an explicit
 * user action. Every call runs through an injectable runner, so tests never spawn omp,
 * and the default runner is only reached on those explicit paths — never recall/retain.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hostConfigDirName } from "./paths.js";

const execFileAsync = promisify(execFile);

/** omp config key naming the built-in memory backend; its default is `off`. */
export const OMP_MEMORY_BACKEND_KEY = "memory.backend";

/** Backend value that leaves omp's own memory surface off (this extension owns memory). */
export const OMP_MEMORY_BACKEND_OFF = "off";

/** Backend value that turns omp's built-in Hindsight backend on (the redundant state). */
export const OMP_MEMORY_BACKEND_HINDSIGHT = "hindsight";

/** Exact CLI fix for the redundant state; shown in doctor and the hub command. */
export const OMP_MEMORY_BACKEND_FIX_COMMAND = "omp config reset memory.backend";

/** Upper bound for any omp config call; the CLI is local and cheap. */
export const DEFAULT_OMP_TIMEOUT_MS = 2000;

/** stdout sentinel for a known key with no explicit value (default applies). */
const OMP_NOT_SET = "(not set)";

export type HostKind = "omp" | "pi";

export interface OmpRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

/**
 * Injectable subprocess seam. The default calls the real `omp` binary; tests inject a
 * fake so nothing spawns. A runner never needs to reject — a rejection is treated as a
 * failure and swallowed by {@link runOmp}.
 */
export type OmpRunner = (args: string[], options: { timeoutMs: number }) => Promise<OmpRunResult>;

export interface OmpCallOptions {
  runner?: OmpRunner;
  timeoutMs?: number;
}

export interface OmpSettingWriteResult {
  ok: boolean;
  key: string;
  /** Written value (set only). */
  value?: string;
  /** Readable failure reason when `ok` is false. */
  error?: string;
}

export interface HostMemoryBackend {
  host: HostKind;
  /** Effective `memory.backend` value; absent when unreadable (or on the pi host). */
  backend?: string;
  /** True when omp's built-in backend is on, so a second memory entry point exists. */
  redundant: boolean;
  /** True when the omp config CLI answered; false on the pi host or a failed read. */
  available: boolean;
}

export interface HostMemoryBackendOptions extends OmpCallOptions {
  /** Host config dir name override (`.omp` / `.pi`); defaults to the live host. */
  hostDirName?: string;
}

function defaultOmpRunner(args: string[], options: { timeoutMs: number }): Promise<OmpRunResult> {
  // execFile defaults to piped stdio on all three streams, so stdin is never inherited:
  // a config read/write can never block on the controlling terminal, and the timeout
  // bounds even a child that waits on its own input.
  return execFileAsync("omp", args, {
    timeout: options.timeoutMs,
    maxBuffer: 1024 * 1024,
    encoding: "utf8",
    windowsHide: true,
  }).then(
    ({ stdout, stderr }) => ({ ok: true, stdout, stderr }),
    (error: Partial<{ stdout: string; stderr: string; message: string }>) => ({
      ok: false,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      error: error.message ?? "omp command failed",
    }),
  );
}

/** Run one omp config call. Never throws: spawn errors, timeouts, and non-zero exits alike. */
async function runOmp(args: string[], options: OmpCallOptions): Promise<OmpRunResult> {
  const runner = options.runner ?? defaultOmpRunner;
  const timeoutMs = options.timeoutMs ?? DEFAULT_OMP_TIMEOUT_MS;
  try {
    return await runner(args, { timeoutMs });
  } catch (error) {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Effective value of one omp setting, or undefined when it cannot be read.
 * `(not set)`, empty output, non-zero exit, and timeouts all collapse to undefined —
 * never a throw, never a value the caller could mistake for a real setting.
 */
export async function readOmpSetting(
  key: string,
  options: OmpCallOptions = {},
): Promise<string | undefined> {
  const result = await runOmp(["config", "get", key], options);
  if (!result.ok) return undefined;
  const value = result.stdout.trim();
  if (value.length === 0 || value === OMP_NOT_SET) return undefined;
  return value;
}

/** Write one omp setting through `omp config set`. */
export async function setOmpSetting(
  key: string,
  value: string,
  options: OmpCallOptions = {},
): Promise<OmpSettingWriteResult> {
  const result = await runOmp(["config", "set", key, value], options);
  return result.ok
    ? { ok: true, key, value }
    : { ok: false, key, error: result.error ?? `omp config set ${key} failed` };
}

/** Remove one omp setting via `omp config reset` so its default applies. */
export async function resetOmpSetting(
  key: string,
  options: OmpCallOptions = {},
): Promise<OmpSettingWriteResult> {
  const result = await runOmp(["config", "reset", key], options);
  return result.ok
    ? { ok: true, key }
    : { ok: false, key, error: result.error ?? `omp config reset ${key} failed` };
}

/**
 * Read omp's built-in memory backend state. Non-omp hosts short-circuit: pi ships no
 * built-in backend, so there is no second entry point and nothing to spawn.
 */
export async function readHostMemoryBackend(
  options: HostMemoryBackendOptions = {},
): Promise<HostMemoryBackend> {
  const hostDirName = options.hostDirName ?? hostConfigDirName();
  if (hostDirName !== ".omp") {
    return { host: "pi", redundant: false, available: false };
  }
  const backend = await readOmpSetting(OMP_MEMORY_BACKEND_KEY, options);
  if (backend === undefined) {
    return { host: "omp", redundant: false, available: false };
  }
  return {
    host: "omp",
    backend,
    redundant: backend !== OMP_MEMORY_BACKEND_OFF,
    available: true,
  };
}
