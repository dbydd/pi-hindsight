import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import type { ResolvedConfig } from "../types.js";
import { DEFAULT_CONFIG } from "./config-defaults.js";
import { envBool, isRecord, merge, normalizeConfig, validEnvVarName } from "./config-normalize.js";
import { mergeBankEntries } from "./banks.js";
import {
  globalConfigBasePath,
  globalSubagentConfigBasePath,
  projectConfigBasePath,
  projectSubagentConfigBasePath,
} from "./paths.js";
import type { BankConfigEntry } from "../types.js";

export { DEFAULT_CONFIG } from "./config-defaults.js";
export { normalizeConfig, validEnvVarName } from "./config-normalize.js";

export function parseJsonWithComments(text: string, source = "config"): unknown {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const first = errors[0]!;
    throw new Error(
      `Invalid JSONC in ${source} at offset ${first.offset}: ${printParseErrorCode(first.error)}`,
    );
  }
  return value as unknown;
}

export function readJson(path: string): unknown {
  if (!existsSync(path)) return undefined;
  return parseJsonWithComments(readFileSync(path, "utf8"), path);
}

export function readConfigFile(basePath: string): unknown {
  const json = readJson(`${basePath}.json`);
  return json === undefined ? readJson(`${basePath}.jsonc`) : json;
}

function configPath(basePath: string): string | undefined {
  const json = `${basePath}.json`;
  if (existsSync(json)) return json;
  const jsonc = `${basePath}.jsonc`;
  if (existsSync(jsonc)) return jsonc;
  return undefined;
}

function migrateUserMemoryKeys(config: Record<string, unknown>): boolean {
  let changed = false;
  if (isRecord(config.banks)) {
    if ("global" in config.banks) {
      if (isRecord(config.banks.user) && isRecord(config.banks.global)) {
        config.banks.user = { ...config.banks.global, ...config.banks.user };
      } else if (!("user" in config.banks)) config.banks.user = config.banks.global;
      delete config.banks.global;
      changed = true;
    }
  }
  if ("globalRetain" in config) {
    if (isRecord(config.userRetain) && isRecord(config.globalRetain)) {
      config.userRetain = { ...config.globalRetain, ...config.userRetain };
    } else if (!("userRetain" in config)) config.userRetain = config.globalRetain;
    delete config.globalRetain;
    changed = true;
  }
  if (isRecord(config.recall)) {
    if ("globalQueryPreamble" in config.recall) {
      if (!("userQueryPreamble" in config.recall)) {
        config.recall.userQueryPreamble = config.recall.globalQueryPreamble;
      }
      delete config.recall.globalQueryPreamble;
      changed = true;
    }
  }
  return changed;
}

export interface ConfigMigrationResult {
  path: string;
  backupPath: string;
}

let lastConfigMigrationResults: ConfigMigrationResult[] = [];

export function consumeLastConfigMigrationResults(): ConfigMigrationResult[] {
  const results = lastConfigMigrationResults;
  lastConfigMigrationResults = [];
  return results;
}

export function migrateUserMemoryConfigFile(
  path: string,
  now = new Date(),
): ConfigMigrationResult | undefined {
  if (!existsSync(path)) return undefined;
  const parsed = parseJsonWithComments(readFileSync(path, "utf8"), path);
  if (!isRecord(parsed)) return undefined;
  if (!migrateUserMemoryKeys(parsed)) return undefined;
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const backupPath = `${path}.bak-${stamp}`;
  copyFileSync(path, backupPath);
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
  return { path, backupPath };
}

export function migrateUserMemoryConfigFiles(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  sessionFile?: string,
): ConfigMigrationResult[] {
  const results: ConfigMigrationResult[] = [];
  const globalBase = globalConfigBasePath({ env, sessionFile });
  const paths = [
    globalBase === undefined ? undefined : configPath(globalBase),
    configPath(projectConfigBasePath(cwd, { env, sessionFile })),
  ].filter((path): path is string => Boolean(path));
  const now = new Date();
  for (const path of paths) {
    const result = migrateUserMemoryConfigFile(path, now);
    if (result) results.push(result);
  }
  if (results.length) lastConfigMigrationResults = results;
  return results;
}

/** Raw merged layer view, used only for "was this recall field configured?" checks. */
function mergedRawLayers(homeConfig: unknown, projectConfig: unknown): Record<string, unknown> {
  return merge(merge({} as Record<string, unknown>, homeConfig), projectConfig);
}

/**
 * Last matching entry id. Later config layers append to the tail, so the last match is
 * the most specific one. A reverse scan keeps this on the es2022 lib baseline.
 */
function lastMatchingId(
  entries: BankConfigEntry[],
  match: (entry: BankConfigEntry) => boolean,
): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry && match(entry)) return entry.id;
  }
  return undefined;
}

/**
 * Coding-role entry an env override should target. Later layers win so a project-layer
 * entry beats the default placeholder; falls back to the default coding id otherwise.
 */
function codingBankEntryId(banks: unknown): string {
  const id = lastMatchingId(
    mergeBankEntries(banks, []),
    (entry) => entry.alias === "project" || entry.id === "project",
  );
  return id ?? "coding";
}

/** User-role entry an env override should target. */
function userBankEntryId(banks: unknown): string {
  const id = lastMatchingId(
    mergeBankEntries(banks, []),
    (entry) => entry.alias === "user" || entry.id === "user",
  );
  return id ?? "life";
}

/**
 * Override layer for one subagent profile. `hindsight-subagent.json` groups its
 * layers under `profiles.<name>`, so a profile that is not listed gets no layer
 * and keeps the `hindsight.json` it would otherwise resolve. A file without that
 * shape contributes nothing rather than acting as a whole-config override.
 */
function profileLayer(raw: unknown, agentName: string | undefined): unknown {
  if (!agentName || !isRecord(raw)) return undefined;
  const profiles = raw.profiles;
  if (!isRecord(profiles)) return undefined;
  const profile = profiles[agentName];
  return isRecord(profile) ? profile : undefined;
}

/** Read a profile layer, or nothing when the file or the profile is absent. */
function readProfileLayer(basePath: string | undefined, agentName: string | undefined): unknown {
  if (basePath === undefined || !agentName) return undefined;
  return profileLayer(readConfigFile(basePath), agentName);
}

/**
 * Resolve config for `cwd`. `sessionFile` is the live session's file when the caller
 * has one; host state paths otherwise fall back to the last registered session.
 *
 * `agentName` names the subagent profile this session runs, and only an omp
 * subagent supplies one. A main session passes nothing and resolves the usual
 * `hindsight.json` layers; pi reports no agent identity at all.
 */
export function resolveConfig(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  sessionFile?: string,
  agentName?: string,
): ResolvedConfig {
  migrateUserMemoryConfigFiles(cwd, env, sessionFile);
  // `banks` is a list, so the recursive deep merge below would replace it wholesale.
  // Banks merge by `id` across layers; `banksFallback` is replaced by the last layer.
  let banks: unknown = DEFAULT_CONFIG.banks;
  let banksFallback: unknown;
  const globalBase = globalConfigBasePath({ env, sessionFile });
  const homeConfig = globalBase === undefined ? undefined : readConfigFile(globalBase);
  const projectConfig = readConfigFile(projectConfigBasePath(cwd, { env, sessionFile }));
  const globalSubagent = readProfileLayer(
    globalSubagentConfigBasePath({ env, sessionFile }),
    agentName,
  );
  const projectSubagent = readProfileLayer(
    projectSubagentConfigBasePath(cwd, { env, sessionFile }),
    agentName,
  );
  // Layer order is low to high: global hindsight, global subagent profile,
  // project hindsight, project subagent profile.
  const layers = [homeConfig, globalSubagent, projectConfig, projectSubagent];
  let config = merge(DEFAULT_CONFIG, homeConfig);
  for (const layer of layers.slice(1)) config = merge(config, layer);
  for (const layer of layers) {
    if (!isRecord(layer)) continue;
    if ("banks" in layer) banks = mergeBankEntries(banks, layer.banks);
    if ("banksFallback" in layer) banksFallback = layer.banksFallback;
  }

  const enabled = envBool(env, "PI_HINDSIGHT_ENABLED");
  if (enabled !== undefined) config = merge(config, { enabled });
  if (env.HINDSIGHT_BASE_URL) {
    config = merge(config, { hindsight: { baseUrl: env.HINDSIGHT_BASE_URL } });
  }
  if (env.HINDSIGHT_API_KEY_REF && validEnvVarName(env.HINDSIGHT_API_KEY_REF)) {
    const ref = { source: "env", name: env.HINDSIGHT_API_KEY_REF };
    config = merge(config, { hindsight: { apiKey: ref } });
  }
  // Prefer HINDSIGHT_API_TOKEN; keep HINDSIGHT_API_KEY as legacy fallback.
  const apiKeyFromEnv = env.HINDSIGHT_API_TOKEN?.trim() || env.HINDSIGHT_API_KEY?.trim();
  if (apiKeyFromEnv) {
    config = merge(config, { hindsight: { apiKey: apiKeyFromEnv } });
  }
  // Env bank overrides target the aliased coding/user entry, whichever id it carries.
  if (env.PI_HINDSIGHT_PROJECT_BANK_ID) {
    banks = mergeBankEntries(banks, [
      {
        id: codingBankEntryId(banks),
        alias: "project",
        bankId: env.PI_HINDSIGHT_PROJECT_BANK_ID,
        derive: "manual",
      },
    ]);
  }
  const userBankId = env.PI_HINDSIGHT_USER_BANK_ID || env.PI_HINDSIGHT_GLOBAL_BANK_ID;
  if (userBankId) {
    banks = mergeBankEntries(banks, [
      { id: userBankEntryId(banks), alias: "user", enabled: true, bankId: userBankId },
    ]);
  }
  const minScores: Record<string, number> = {};
  const semanticFloor =
    env.PI_HINDSIGHT_MIN_SEMANTIC?.trim() === ""
      ? Number.NaN
      : Number(env.PI_HINDSIGHT_MIN_SEMANTIC);
  if (Number.isFinite(semanticFloor)) minScores.semantic = semanticFloor;
  const rerankerFloor =
    env.PI_HINDSIGHT_MIN_RERANKER?.trim() === ""
      ? Number.NaN
      : Number(env.PI_HINDSIGHT_MIN_RERANKER);
  if (Number.isFinite(rerankerFloor)) minScores.reranker = rerankerFloor;
  if (Object.keys(minScores).length) config = merge(config, { recall: { minScores } });
  config = { ...config, banks: mergeBankEntries(banks, []) };
  if (banksFallback !== undefined) config = { ...config, banksFallback: banksFallback as string[] };
  return normalizeConfig(
    config,
    mergedRawLayers(
      mergedRawLayers(homeConfig, globalSubagent),
      mergedRawLayers(projectConfig, projectSubagent),
    ),
    env,
  );
}
