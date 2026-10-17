import { isRecord } from "../config/is-record.js";
import {
  createClassifierBackend,
  createJudgeBackend,
  type ClassifierPort,
  type JudgePort,
} from "./backends.js";
import { createHttpSystemOneBackend } from "./systemone.js";
import {
  createTextBackendAdapter,
  createTextBridgeBackend,
  TEXT_BRIDGE_PARSE_RETRIES,
  type TextBackendLike,
  type TextCompletePort,
} from "./text-bridge.js";
import { readOmpTodoState, readPiTodoState, UNKNOWN_TODO, type OmpTodoPort } from "./todo-state.js";
import type {
  DecisionBackend,
  DecisionHost,
  DecisionModelRef,
  HostKind,
  TodoState,
} from "./types.js";
import type { SystemOneConfig } from "../types.js";

/**
 * Host adapters: the only place that knows how a host resolves models and which
 * typed backend it can offer for one.
 *
 * Nothing here is imported statically from an omp package — this file is loaded
 * on both hosts and a pi tree ships no `@oh-my-pi/*` module, so a top-level import
 * would fail at module load and take the whole extension down with it. Every host
 * surface is therefore reached through one `await import("<literal>")` per
 * candidate, each in its own try/catch, so a miss is a missing rung and nothing
 * else. The specifiers stay *literals* on purpose: omp ships as one bundled file
 * whose `@oh-my-pi/*` specifiers were rewritten at build time, so only a literal
 * survives bundling — anything computed is looked up by node resolution at
 * runtime and misses even on omp, which silently cost both judgment rungs. The
 * suite drives the ladder through the exported seams, and both loaders were
 * confirmed against a real omp process, where they answer with the full surface.
 *
 * Only the literal half is reproduced. A probe that reached these files by a path
 * outside omp's own extension loading once reported `undefined` for both loaders
 * while the same literals answered inside the entry file — but a controlled A/B
 * since then loaded a copy and a symlinked checkout alike, so that reading is not
 * a property of the install layout and nothing here depends on one. What stands:
 * load (or probe) the package the way omp loads it, and distrust an off-root probe
 * that reports a missing rung, because that symptom is indistinguishable from the
 * real thing.
 */

/** The omp judgment surface used by the two omp rungs. */
export interface OmpJudgmentRuntime {
  /** Whether a catalog api answers typed judgments natively. */
  isJudgmentApi(api: string): boolean;
  createNativeJudge(
    model: unknown,
    connection: { apiKey?: unknown; headers?: Record<string, string> },
  ): JudgePort;
  /** Present on hosts that ship the text judge. */
  TextJudge?: new (backend: TextBackendLike) => JudgePort;
  /** Chat transport with omp's own request shape (reasoning off, retry tool). */
  chatTextBackend?(
    model: unknown,
    options: { apiKey?: string; sessionId?: string },
  ): TextBackendLike;
  /** One-shot completion, used when the host ships no chat text backend. */
  completeSimple?(model: unknown, context: unknown, options: unknown): Promise<unknown>;
}

/** Structural view of the registry surface both hosts expose under different classes. */
export interface HostRegistryLike {
  find?(provider: string, modelId: string): unknown;
  /** Model catalog; the scoped role resolver must read the all-kind view. */
  getAvailable?(kind?: string): unknown;
  getDiscoverableProviders?(): unknown;
  refresh?(mode?: unknown, options?: unknown): unknown;
  complete?(model: unknown, context: unknown, options?: unknown): Promise<unknown>;
  stream?(model: unknown, context: unknown, options?: unknown): unknown;
  classify?(model: unknown, context: unknown, options?: unknown): Promise<unknown>;
  getApiKey?(model: unknown, sessionId?: string, options?: unknown): Promise<string | undefined>;
  resolver?(model: unknown, sessionId?: string): unknown;
  resolveModelHeaders?(
    model: unknown,
    signal?: AbortSignal,
  ): Promise<Record<string, string> | undefined>;
}

/** The host extension context fields the adapters read. */
export interface DecisionHostContext {
  cwd?: string;
  sessionId?: string;
  /** Current session model. */
  model?: unknown;
  modelRegistry?: unknown;
  /** omp's model query facade (role aliases live here). */
  models?: { resolve?(spec: string): unknown };
  /**
   * The live session manager. omp ships no settings on the extension context,
   * but the agent registry maps this manager back to a session whose settings
   * the scoped role resolver needs; pi never fills it.
   */
  sessionManager?: unknown;
}

export function hostModelRef(model: unknown): DecisionModelRef | undefined {
  if (!isRecord(model)) return undefined;
  const provider = typeof model.provider === "string" ? model.provider : undefined;
  const modelId = typeof model.id === "string" ? model.id : undefined;
  return provider && modelId ? { provider, modelId } : undefined;
}

/**
 * A host model's context window in tokens. Both hosts catalogue it as
 * `contextWindow`; the catalog types it as `number | null`, and a host that
 * reports nothing leaves the decision layer on its fallback budget.
 */
export function modelContextWindowOf(model: unknown): number | undefined {
  if (!isRecord(model)) return undefined;
  const reported = model.contextWindow;
  return typeof reported === "number" && Number.isFinite(reported) && reported > 0
    ? reported
    : undefined;
}

/**
 * omp's model query facade, read structurally: pi ships no `models` field on its
 * context and the value is host-provided, so the shape is narrowed, not asserted.
 */
export function hostModelsFacade(
  ctx: unknown,
): { resolve?: (spec: string) => unknown } | undefined {
  if (!isRecord(ctx)) return undefined;
  const models = ctx.models;
  if (!isRecord(models) || typeof models.resolve !== "function") return undefined;
  // `typeof` narrows to `Function`; the host declares a spec-in/unknown-out port.
  const resolve = models.resolve as (spec: string) => unknown;
  return { resolve };
}

/** Test seam: supplies the runtime instead of resolving a host module. */
export type JudgmentLoader = () => Promise<OmpJudgmentRuntime | undefined>;

/**
 * Narrow one dynamically imported candidate to the judgment surface. Narrow from
 * `unknown`: the module is host-authored and ships no type here to trust.
 */
function judgmentRuntimeFrom(loaded: unknown): OmpJudgmentRuntime | undefined {
  if (
    !isRecord(loaded) ||
    typeof loaded.isJudgmentApi !== "function" ||
    typeof loaded.createNativeJudge !== "function"
  ) {
    return undefined;
  }
  return loaded as unknown as OmpJudgmentRuntime;
}

/**
 * Load the omp judgment surface; undefined wherever the host does not ship it.
 *
 * One `try` per candidate, each wrapping a single literal `import()`: only a
 * literal survives being bundled, since omp rewrites these specifiers at build
 * time and anything computed resolves against bare node instead. Hence no loop,
 * no variable specifier — that shape is what makes omp's two judgment rungs load
 * at all. Two candidates: `pi-ai` root ships none of these exports, and
 * `pi-coding-agent`'s is the same source under another name, kept for hosts that
 * moved it. Each is shape-checked, so a module missing a member falls through.
 */
async function importJudgmentRuntime(): Promise<OmpJudgmentRuntime | undefined> {
  try {
    return judgmentRuntimeFrom(await import("@oh-my-pi/pi-ai/judgment"));
  } catch {
    // No such module on this host; the next candidate may still answer.
  }
  try {
    return judgmentRuntimeFrom(await import("@oh-my-pi/pi-coding-agent/judgment"));
  } catch {
    // Same absence, second candidate.
  }
  return undefined;
}

/**
 * The omp judgment surface read through `loader`, defaulting to the real one.
 * Tests inject a runtime here instead of relying on a host install.
 */
export function loadOmpJudgmentRuntime(
  loader: JudgmentLoader = importJudgmentRuntime,
): Promise<OmpJudgmentRuntime | undefined> {
  return loader();
}

export function detectHostKind(ctx: DecisionHostContext | undefined): HostKind {
  if (typeof ctx?.models?.resolve === "function") return "omp";
  if (ctx?.modelRegistry) return "pi";
  return "unknown";
}

/** Structural view of the omp scoped-model entry point. */
export interface OmpRoleRuntime {
  resolveScopedModels(
    this: void,
    parsed: unknown,
    registry: {
      getAvailable(kind?: string): unknown;
      getDiscoverableProviders(): unknown;
      refresh(mode?: unknown, options?: unknown): unknown;
    },
    settings: unknown,
  ): Promise<Array<{ model?: unknown }>>;
  AgentRegistry?: {
    global?(this: void): { list(this: void): Array<{ session?: unknown }> };
  };
}

/** Test seam: supplies the role runtime instead of resolving a host module. */
export type OmpRoleLoader = () => Promise<OmpRoleRuntime | undefined>;

/**
 * Narrow one dynamically imported candidate to the role surface. Narrow from
 * `unknown`: the module is host-authored and ships no type here to trust.
 */
function roleRuntimeFrom(loaded: unknown): OmpRoleRuntime | undefined {
  if (!isRecord(loaded) || typeof loaded.resolveScopedModels !== "function") {
    return undefined;
  }
  return loaded as unknown as OmpRoleRuntime;
}

/**
 * The real load, read in the same one-literal-per-`try` shape as the judgment
 * surface. The root specifier carries both halves on omp — `AgentRegistry`
 * alongside the scoped resolver — so the others exist only so a host that has
 * since moved that export still finds one.
 */
async function importRoleRuntime(): Promise<OmpRoleRuntime | undefined> {
  try {
    return roleRuntimeFrom(await import("@oh-my-pi/pi-coding-agent"));
  } catch {
    // No such module on this host; the next candidate may still answer.
  }
  try {
    return roleRuntimeFrom(await import("@oh-my-pi/pi-coding-agent/registry/agent-registry"));
  } catch {
    // Same absence, second candidate.
  }
  try {
    return roleRuntimeFrom(await import("@oh-my-pi/coding-agent"));
  } catch {
    // Same absence, third candidate — the pre-rename package name.
  }
  return undefined;
}

/**
 * The omp role surface read through `loader`, defaulting to the real one. A pi
 * tree ships no `@oh-my-pi/*`, which fails to resolve and so removes the rung,
 * leaving pi and unknown hosts their behaviour unchanged.
 */
export function loadOmpRoleRuntime(
  loader: OmpRoleLoader = importRoleRuntime,
): Promise<OmpRoleRuntime | undefined> {
  return loader();
}

/**
 * One-shot loader. A pi tree resolves no omp specifier, and a failed dynamic
 * import is not cached by the module loader, so the memo keeps a role spec from
 * paying for that lookup on every turn.
 */
function memoizeRoleRuntime(
  load: () => Promise<OmpRoleRuntime | undefined>,
): () => Promise<OmpRoleRuntime | undefined> {
  let pending: Promise<OmpRoleRuntime | undefined> | undefined;
  return () => (pending ??= load());
}

/** The production load, memoized: the answer never changes within a process. */
const loadDefaultRoleRuntime = memoizeRoleRuntime(() => loadOmpRoleRuntime());

/** The fake `Args` omp's scoped resolver reads. It touches the model list only. */
function roleArgs(role: string): unknown {
  return {
    models: [`@${role}`],
    messages: [],
    fileArgs: [],
    unknownFlags: new Map(),
    unrecognizedFlags: [],
    invalidFlagValues: [],
  };
}

/**
 * Find this session in omp's agent registry, then read its settings. omp exposes
 * no settings on the extension context, so the session manager is the handle
 * that identifies the running session.
 */
function findOmpSessionSettings(runtime: OmpRoleRuntime, sessionManager: unknown): unknown {
  const registry = runtime.AgentRegistry;
  // Reading through the object keeps `this` bound, which the static `global()` has.
  if (typeof registry?.global !== "function" || !sessionManager) return undefined;
  try {
    const agents = registry.global().list();
    if (!Array.isArray(agents)) return undefined;
    const match = agents.find((agent) => {
      const session = isRecord(agent) ? agent.session : undefined;
      return isRecord(session) && session.sessionManager === sessionManager;
    });
    const session = isRecord(match) ? match.session : undefined;
    return isRecord(session) ? session.settings : undefined;
  } catch {
    // A registry that will not list its agents simply has no settings for us.
    return undefined;
  }
}

/**
 * Resolve a role through omp's scoped resolver, whose registry view we build so
 * `getAvailable` is asked for every kind. The host's `models.resolve()` runs the
 * role through `modelRegistry.getAvailable()` with no kind, which defaults to
 * `chat` — a judge/image/classifier model is invisible there and the role would
 * silently miss. Undefined wherever any half is unavailable or answers nothing.
 *
 * Omit both `runtime` and `load` and this still runs the production path: `load`
 * falls back to the memoized default, never to "no runtime". Reading absence as
 * the default made a direct call resolve nothing, which then looked like the
 * ladder being broken rather than the argument being left out.
 */
export async function resolveOmpRole(input: {
  role: string;
  registry: HostRegistryLike;
  sessionManager?: unknown;
  runtime?: OmpRoleRuntime;
  /** Overrides the production loader; tests inject a runtime without a real host. */
  load?: () => Promise<OmpRoleRuntime | undefined>;
}): Promise<DecisionModelRef | undefined> {
  const runtime = input.runtime ?? (await (input.load ?? loadDefaultRoleRuntime)());
  if (!runtime) return undefined;
  const settings = findOmpSessionSettings(runtime, input.sessionManager);
  if (!settings) return undefined;
  try {
    const resolved = await runtime.resolveScopedModels(
      roleArgs(input.role),
      {
        // Always the all-kind view: the resolver's internal `getAvailable()`
        // defaults to `chat`, which hides every non-chat model.
        getAvailable: () => input.registry.getAvailable?.("all"),
        getDiscoverableProviders: () => input.registry.getDiscoverableProviders?.(),
        refresh: (mode?: unknown, options?: unknown) => input.registry.refresh?.(mode, options),
      },
      settings,
    );
    const model = Array.isArray(resolved) ? resolved[0]?.model : undefined;
    return hostModelRef(model);
  } catch {
    // A resolver that rejects or answers nothing falls through to the facade.
    return undefined;
  }
}

export interface CreateDecisionHostInput {
  ctx?: DecisionHostContext;
  /** Loaded omp judgment surface; omitted on pi and when the load failed. */
  runtime?: OmpJudgmentRuntime;
  sessionId?: string;
  /** Loads the omp role surface; tests inject a runtime without a real host. */
  loadRoleRuntime?: () => Promise<OmpRoleRuntime | undefined>;
  /** Reads the resolved config; the System One rung follows it per call. */
  getSystemOne?: () => SystemOneConfig | undefined;
}

/** Adapter for the detected host; an unknown host offers no model and no rung. */
export function createDecisionHost(input: CreateDecisionHostInput): DecisionHost {
  const kind = detectHostKind(input.ctx);
  if (kind === "omp" && input.ctx) {
    return createOmpHost({
      ...input,
      ctx: input.ctx,
      ...(input.loadRoleRuntime ? { loadRoleRuntime: input.loadRoleRuntime } : {}),
      ...(input.getSystemOne ? { getSystemOne: input.getSystemOne } : {}),
    });
  }
  if (kind === "pi" && input.ctx) {
    return createPiHost(input.ctx, input.getSystemOne);
  }
  return degradedDecisionHost();
}

/**
 * Host that can never answer: no model, no rung. The decision layer then ends at
 * its own fallback banks, so a host that cannot be built costs routing quality
 * instead of the turn's memory.
 */
export function degradedDecisionHost(): DecisionHost {
  return {
    kind: "unknown",
    roles: false,
    resolveRole: async () => undefined,
    modelContextWindow: () => undefined,
    backends: () => [],
  };
}

export interface CreateRuntimeDecisionHostInput {
  /** Live extension-context surfaces; absent before a session starts. */
  ctx?: DecisionHostContext;
  sessionId?: string;
  /** Loads the omp role surface; omitted outside tests. */
  loadRoleRuntime?: () => Promise<OmpRoleRuntime | undefined>;
  /** Reads the resolved config; the System One rung follows it per call. */
  getSystemOne?: () => SystemOneConfig | undefined;
}

/**
 * Build the host adapter for the running process. The omp judgment surface lives
 * behind a computed specifier (a pi tree ships no `@oh-my-pi/*`), so this is
 * async; a failed load or lookup degrades instead of throwing into session start.
 */
export async function createRuntimeDecisionHost(
  input: CreateRuntimeDecisionHostInput = {},
): Promise<DecisionHost> {
  try {
    const runtime = await loadOmpJudgmentRuntime();
    return createDecisionHost({
      ...(input.ctx ? { ctx: input.ctx } : {}),
      ...(runtime ? { runtime } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.getSystemOne ? { getSystemOne: input.getSystemOne } : {}),
      loadRoleRuntime: input.loadRoleRuntime ?? loadDefaultRoleRuntime,
    });
  } catch {
    return degradedDecisionHost();
  }
}

/**
 * Task-state reader for the decision prompt. omp answers the todo plugin's read
 * event synchronously; pi keeps the same snapshot in session entries, so a host
 * whose plugin did not answer falls through to the branch replay.
 */
export function readDecisionTodoState(
  events: OmpTodoPort | undefined,
  entries: (() => readonly unknown[]) | undefined,
): TodoState {
  const omp = readOmpTodoState(events);
  if (omp.kind === "ok") return omp;
  if (!entries) return UNKNOWN_TODO;
  try {
    return readPiTodoState(entries());
  } catch {
    return UNKNOWN_TODO;
  }
}

function createOmpHost(input: {
  ctx: DecisionHostContext;
  runtime?: OmpJudgmentRuntime;
  sessionId?: string;
  loadRoleRuntime?: () => Promise<OmpRoleRuntime | undefined>;
  /** Reads the resolved config; the System One rung follows it per call. */
  getSystemOne?: () => SystemOneConfig | undefined;
}): DecisionHost {
  const { ctx, runtime, sessionId, getSystemOne } = input;
  const registry = (ctx.modelRegistry ?? {}) as HostRegistryLike;
  const models = ctx.models;
  return {
    kind: "omp",
    roles: typeof models?.resolve === "function",
    async resolveRole(name) {
      // The scoped resolver is the primary path: it reads the role through an
      // all-kind registry view, so a judge role resolves instead of silently
      // missing. The facade below covers chat models on hosts that ship no
      // scoped resolver, or none that we can reach.
      try {
        const scoped = await resolveOmpRole({
          role: name,
          registry,
          ...(ctx.sessionManager ? { sessionManager: ctx.sessionManager } : {}),
          ...(input.loadRoleRuntime ? { load: input.loadRoleRuntime } : {}),
        });
        if (scoped) return scoped;
      } catch {
        // Never let a role lookup break the turn; the facade is next.
      }
      if (typeof models?.resolve !== "function") return undefined;
      // Newer hosts take a bare role name; older ones take the `@` alias form.
      for (const specifier of [name, `@${name}`]) {
        try {
          const ref = hostModelRef(models.resolve(specifier));
          if (ref) return ref;
        } catch {
          // Unknown role for this host; try the alias form.
        }
      }
      return undefined;
    },
    sessionModel: () => hostModelRef(ctx.model),
    modelContextWindow: (ref) => modelContextWindowOf(ompModelHandle(ctx, registry, ref)),
    backends(ref) {
      try {
        const rungs = ompLadder(
          ompModelHandle(ctx, registry, ref),
          ref,
          runtime,
          registry,
          sessionId,
        );
        // The native judgment api stays first: it reaches the same model through
        // the host's own transport. System One is the second rung, before the
        // text bridge, so a typed decision still wins over text.
        return withSystemOneRung(rungs, getSystemOne?.());
      } catch {
        // A host lookup failure removes every rung; it never reaches the caller.
        return [];
      }
    },
  };
}

function createPiHost(
  ctx: DecisionHostContext,
  getSystemOne?: () => SystemOneConfig | undefined,
): DecisionHost {
  const registry = (ctx.modelRegistry ?? {}) as HostRegistryLike;
  return {
    kind: "pi",
    // pi has no role table at all, so `role:` is a skipped level on this host.
    roles: false,
    resolveRole: () => undefined,
    sessionModel: () => hostModelRef(ctx.model),
    modelContextWindow: (ref) => modelContextWindowOf(findPiModel(registry, ref)),
    backends(ref) {
      const model = findPiModel(registry, ref);
      if (!model) return [];
      const label = `${ref.provider}/${ref.modelId}`;
      const rungs: DecisionBackend[] = [];
      if (typeof registry.classify === "function") {
        rungs.push(
          createClassifierBackend({
            classify: piClassifierPort(registry, model),
            label: `classify/${label}`,
          }),
        );
      }
      const complete = piCompletePort(registry, model);
      if (complete) rungs.push(createTextBridgeBackend(complete, { label: `bridge/${label}` }));
      return withSystemOneRung(rungs, getSystemOne?.());
    },
  };
}

/**
 * Insert the System One rung before the text bridge when the config enables it.
 * pi's registry only resolves chat models, so its classifier rung never exists
 * for a decision group; System One is the typed rung that works on both hosts
 * because it reaches the gateway's own protocol instead of the host's model
 * table. A disabled config adds nothing, and a misconfigured gateway fails at
 * request time, which the ladder treats as any other failed rung.
 */
function withSystemOneRung(
  rungs: DecisionBackend[],
  systemOne: SystemOneConfig | undefined,
): DecisionBackend[] {
  if (!systemOne?.enabled) return rungs;
  const apiKey = systemOne.apiKeyEnvVar ? process.env[systemOne.apiKeyEnvVar] : undefined;
  const rung = createHttpSystemOneBackend(
    {
      baseUrl: systemOne.baseUrl,
      ...(systemOne.model ? { model: systemOne.model } : {}),
      ...(apiKey ? { apiKey } : {}),
    },
    `systemone/${systemOne.model || "default"}`,
  );
  // Before the bridge: the bridge is the untyped fallback, judged last.
  const bridgeIndex = rungs.findIndex((existing) => existing.kind === "text");
  if (bridgeIndex < 0) {
    rungs.push(rung);
    return rungs;
  }
  return [...rungs.slice(0, bridgeIndex), rung, ...rungs.slice(bridgeIndex)];
}

function ompModelHandle(
  ctx: DecisionHostContext,
  registry: HostRegistryLike,
  ref: DecisionModelRef,
): unknown {
  // Registry first. The host's `models.resolve()` runs its spec through
  // `resolveModelRoleValue(..., modelRegistry.getAvailable())`, and `getAvailable()`
  // defaults to the `chat` kind — so a judge/image/classifier model is invisible
  // there and an explicit `provider/modelId` spec would miss even though the model
  // is configured and authenticated. `registry.find` is kind-agnostic.
  try {
    const found = registry.find?.(ref.provider, ref.modelId);
    if (found) return found;
  } catch {
    // Fall through to the host resolver.
  }
  try {
    return ctx.models?.resolve?.(`${ref.provider}/${ref.modelId}`);
  } catch {
    return undefined;
  }
}

function findPiModel(registry: HostRegistryLike, ref: DecisionModelRef): unknown {
  try {
    return registry.find?.(ref.provider, ref.modelId);
  } catch {
    return undefined;
  }
}

/**
 * The omp ladder: the native judgment api when the model's api answers typed
 * judgments, then the text judge for chat models. An on-device keyword model
 * (`local-inference`) has no port we can drive, so it offers no text rung.
 */
function ompLadder(
  model: unknown,
  ref: DecisionModelRef,
  runtime: OmpJudgmentRuntime | undefined,
  registry: HostRegistryLike,
  sessionId: string | undefined,
): DecisionBackend[] {
  if (!model || !runtime) return [];
  const label = `${ref.provider}/${ref.modelId}`;
  const api = isRecord(model) && typeof model.api === "string" ? model.api : "";
  const rungs: DecisionBackend[] = [];
  if (api && runtime.isJudgmentApi(api)) {
    rungs.push(
      createJudgeBackend({
        judge: lazyJudge(runtime, model, registry, sessionId),
        kind: "native-judge",
        label: `judgment/${label}`,
      }),
    );
  }
  if (api !== "local-inference") {
    const text = ompTextRung(runtime, model, registry, sessionId, api, ref);
    if (text) rungs.push(text);
  }
  return rungs;
}

function ompTextRung(
  runtime: OmpJudgmentRuntime,
  model: unknown,
  registry: HostRegistryLike,
  sessionId: string | undefined,
  api: string,
  ref: DecisionModelRef,
): DecisionBackend | undefined {
  const label = `${ref.provider}/${ref.modelId}`;
  const TextJudge = runtime.TextJudge;
  if (typeof TextJudge === "function") {
    try {
      const backend = lazyTextBackend(runtime, model, registry, sessionId, api, ref);
      return createJudgeBackend({
        judge: new TextJudge(backend),
        kind: "text",
        label: `text/${label}`,
      });
    } catch {
      // Unusable text judge; the bridge over the same model is the next step.
    }
  }
  const complete = ompCompletePort(runtime, model, registry, sessionId);
  return complete ? createTextBridgeBackend(complete, { label: `bridge/${label}` }) : undefined;
}

/** Build the native judge on first use: omp resolves credentials asynchronously. */
function lazyJudge(
  runtime: OmpJudgmentRuntime,
  model: unknown,
  registry: HostRegistryLike,
  sessionId: string | undefined,
): JudgePort {
  let pending: Promise<JudgePort> | undefined;
  const build = async (): Promise<JudgePort> => {
    const apiKey =
      registry.resolver?.(model, sessionId) ?? (await registry.getApiKey?.(model, sessionId));
    const headers = await registry.resolveModelHeaders?.(model);
    return runtime.createNativeJudge(model, {
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(headers === undefined ? {} : { headers }),
    });
  };
  return {
    async judge(request, options) {
      try {
        const judge = await (pending ??= build());
        return await judge.judge(request, options);
      } catch (error) {
        // A failed build must not poison later turns.
        pending = undefined;
        throw error;
      }
    },
  };
}

/** Chat transport built on first use; omp's own chat backend when the host ships one. */
function lazyTextBackend(
  runtime: OmpJudgmentRuntime,
  model: unknown,
  registry: HostRegistryLike,
  sessionId: string | undefined,
  api: string,
  ref: DecisionModelRef,
): TextBackendLike {
  const meta = { api: api || "chat", provider: ref.provider, model: ref.modelId };
  let pending: Promise<TextBackendLike> | undefined;
  return {
    ...meta,
    parseRetries: TEXT_BRIDGE_PARSE_RETRIES,
    async complete(prompt, options) {
      try {
        const backend = await (pending ??= buildTextBackend(
          runtime,
          model,
          registry,
          sessionId,
          meta,
        ));
        return await backend.complete(prompt, options);
      } catch (error) {
        pending = undefined;
        throw error;
      }
    },
  };
}

async function buildTextBackend(
  runtime: OmpJudgmentRuntime,
  model: unknown,
  registry: HostRegistryLike,
  sessionId: string | undefined,
  meta: { api: string; provider: string; model: string },
): Promise<TextBackendLike> {
  const apiKey = await registry.getApiKey?.(model, sessionId);
  if (typeof runtime.chatTextBackend === "function") {
    return runtime.chatTextBackend(model, {
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(sessionId === undefined ? {} : { sessionId }),
    });
  }
  const complete = ompCompletePort(runtime, model, registry, sessionId, apiKey);
  if (!complete) throw new Error("omp host exposes neither chatTextBackend nor completeSimple");
  return createTextBackendAdapter(complete, meta);
}

function ompCompletePort(
  runtime: OmpJudgmentRuntime,
  model: unknown,
  registry: HostRegistryLike,
  sessionId: string | undefined,
  apiKey?: string,
): TextCompletePort | undefined {
  // Bound, so the host's own `this` survives and the linter sees a plain callable.
  const completeSimple = runtime.completeSimple?.bind(runtime);
  if (!completeSimple) return undefined;
  return async (input) => {
    const key = apiKey ?? (await registry.getApiKey?.(model, sessionId));
    const message = await completeSimple(
      model,
      {
        systemPrompt: [input.system],
        messages: [{ role: "user", content: input.user, timestamp: Date.now() }],
      },
      {
        ...(key === undefined ? {} : { apiKey: key }),
        ...(sessionId === undefined ? {} : { sessionId }),
        maxTokens: input.maxTokens,
        temperature: 0,
        disableReasoning: true,
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
    return assistantText(message) ?? "";
  };
}

function piCompletePort(registry: HostRegistryLike, model: unknown): TextCompletePort | undefined {
  if (typeof registry.complete === "function") {
    return async (input) => {
      const message = await registry.complete!(
        model,
        {
          systemPrompt: [input.system],
          messages: [{ role: "user", content: input.user, timestamp: Date.now() }],
        },
        {
          maxTokens: input.maxTokens,
          ...(input.signal ? { signal: input.signal } : {}),
        },
      );
      return assistantText(message) ?? "";
    };
  }
  if (typeof registry.stream === "function") {
    return async (input) => {
      const stream = registry.stream!(
        model,
        {
          systemPrompt: [input.system],
          messages: [{ role: "user", content: input.user, timestamp: Date.now() }],
        },
        { maxTokens: input.maxTokens, ...(input.signal ? { signal: input.signal } : {}) },
      );
      if (!isRecord(stream)) return "";
      const result = stream.result;
      const message =
        typeof result === "function" ? await (result.call(stream) as Promise<unknown>) : stream;
      return assistantText(message) ?? "";
    };
  }
  return undefined;
}

/**
 * pi's classifier surface. The question record mirrors the judgment convention
 * (ids as keys); an api that answers a different shape yields no answers and the
 * text rung takes over.
 */
function piClassifierPort(registry: HostRegistryLike, model: unknown): ClassifierPort {
  return (input) =>
    registry.classify!(
      model,
      {
        state: input.state,
        questions: Object.fromEntries(
          input.questions.map((question) => [
            question.id,
            { type: "bool", instructions: question.instructions },
          ]),
        ),
      },
      {
        maxTokens: input.maxTokens,
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
}

/** Text of an assistant message, tolerating string content and text blocks. */
function assistantText(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  const content = message.content;
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((block) =>
    isRecord(block) && typeof block.text === "string" && block.text.trim()
      ? [block.text.trim()]
      : [],
  );
  return parts.length > 0 ? parts.join("\n") : undefined;
}
