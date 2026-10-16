import { isRecord } from "../config/is-record.js";
import {
  createClassifierBackend,
  createJudgeBackend,
  type ClassifierPort,
  type JudgePort,
} from "./backends.js";
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

/**
 * Host adapters: the only place that knows how a host resolves models and which
 * typed backend it can offer for one.
 *
 * Nothing here is imported statically from an omp package — a pi tree ships no
 * `@oh-my-pi/*` module, so the omp judgment surface is loaded with a computed
 * specifier and a failure simply removes that rung.
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
}

export function hostModelRef(model: unknown): DecisionModelRef | undefined {
  if (!isRecord(model)) return undefined;
  const provider = typeof model.provider === "string" ? model.provider : undefined;
  const modelId = typeof model.id === "string" ? model.id : undefined;
  return provider && modelId ? { provider, modelId } : undefined;
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

const OMP_JUDGMENT_SPECIFIERS = [
  "@oh-my-pi/pi-ai/judgment",
  "@oh-my-pi/pi-ai",
  "@oh-my-pi/pi-coding-agent/judgment",
];

/** Load the omp judgment surface; undefined wherever the host does not ship it. */
export async function loadOmpJudgmentRuntime(): Promise<OmpJudgmentRuntime | undefined> {
  for (const specifier of OMP_JUDGMENT_SPECIFIERS) {
    try {
      // Computed specifier: a literal import would be resolved (and fail) on a pi tree.
      const loaded = (await import(specifier)) as Partial<OmpJudgmentRuntime>;
      if (
        typeof loaded.isJudgmentApi === "function" &&
        typeof loaded.createNativeJudge === "function"
      ) {
        return loaded as OmpJudgmentRuntime;
      }
    } catch {
      // Not this host's package; the next specifier may be.
    }
  }
  return undefined;
}

export function detectHostKind(ctx: DecisionHostContext | undefined): HostKind {
  if (typeof ctx?.models?.resolve === "function") return "omp";
  if (ctx?.modelRegistry) return "pi";
  return "unknown";
}

export interface CreateDecisionHostInput {
  ctx?: DecisionHostContext;
  /** Loaded omp judgment surface; omitted on pi and when the load failed. */
  runtime?: OmpJudgmentRuntime;
  sessionId?: string;
}

/** Adapter for the detected host; an unknown host offers no model and no rung. */
export function createDecisionHost(input: CreateDecisionHostInput): DecisionHost {
  const kind = detectHostKind(input.ctx);
  if (kind === "omp" && input.ctx) return createOmpHost({ ...input, ctx: input.ctx });
  if (kind === "pi" && input.ctx) return createPiHost(input.ctx);
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
    resolveRole: () => undefined,
    backends: () => [],
  };
}

export interface CreateRuntimeDecisionHostInput {
  /** Live extension-context surfaces; absent before a session starts. */
  ctx?: DecisionHostContext;
  sessionId?: string;
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
}): DecisionHost {
  const { ctx, runtime, sessionId } = input;
  const registry = (ctx.modelRegistry ?? {}) as HostRegistryLike;
  const models = ctx.models;
  return {
    kind: "omp",
    roles: typeof models?.resolve === "function",
    resolveRole(name) {
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
    backends(ref) {
      try {
        return ompLadder(ompModelHandle(ctx, registry, ref), ref, runtime, registry, sessionId);
      } catch {
        // A host lookup failure removes every rung; it never reaches the caller.
        return [];
      }
    },
  };
}

function createPiHost(ctx: DecisionHostContext): DecisionHost {
  const registry = (ctx.modelRegistry ?? {}) as HostRegistryLike;
  return {
    kind: "pi",
    // pi has no role table at all, so `role:` is a skipped level on this host.
    roles: false,
    resolveRole: () => undefined,
    sessionModel: () => hostModelRef(ctx.model),
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
      return rungs;
    },
  };
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
