import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isAbortError } from "./client/timeout.js";
import { registerCommands } from "./tui/commands.js";
import { createMemoryLifecycle } from "./lifecycle/memory-lifecycle.js";
import { createOperationCatalog } from "./operations/operation-catalog.js";
import { registerTools } from "./operations/tools.js";
import {
  createRuntimeDecisionHost,
  hostModelsFacade,
  readDecisionTodoState,
  type DecisionHostContext,
} from "./decision/host.js";

/**
 * Host surfaces the decision adapter reads, projected from the live extension
 * context. `models` is omp's model query facade and is absent on pi, where the
 * context exposes a registry instead.
 */
function decisionHostContext(ctx: ExtensionContext): DecisionHostContext {
  const models = hostModelsFacade(ctx);
  return {
    ...(ctx.model ? { model: ctx.model } : {}),
    ...(ctx.modelRegistry ? { modelRegistry: ctx.modelRegistry } : {}),
    ...(models ? { models } : {}),
  };
}

export default function hindsightExtension(pi: ExtensionAPI) {
  let sessionId: string | undefined;
  let sessionCtx: ExtensionContext | undefined;
  const lifecycle = createMemoryLifecycle(
    process.cwd(),
    (event) => {
      pi.events.emit("hindsight:retrieval", { ...event, ...(sessionId ? { sessionId } : {}) });
    },
    {
      // Context getters resolve at call time, so the host follows model and session
      // switches without being rebuilt.
      loadDecisionHost: () =>
        createRuntimeDecisionHost({
          ...(sessionCtx ? { ctx: decisionHostContext(sessionCtx) } : {}),
          ...(sessionId ? { sessionId } : {}),
        }),
      readTodo: () =>
        readDecisionTodoState(pi.events, () => sessionCtx?.sessionManager.getEntries() ?? []),
    },
  );
  const catalog = createOperationCatalog(lifecycle.deps);

  registerTools(pi, catalog);
  registerCommands(pi, catalog);

  pi.on("session_start", async (_event, ctx) => {
    try {
      sessionId = ctx.sessionManager.getSessionId();
    } catch {
      sessionId = undefined;
    }
    sessionCtx = ctx;
    await lifecycle.initialize(ctx);
  });

  pi.on("context", async (event, ctx) => {
    try {
      return await lifecycle.recall(event, ctx);
    } catch (error) {
      // Pi reports uncaught context-hook exceptions as extension errors. Esc is expected.
      if (isAbortError(error) || ctx.signal?.aborted) return undefined;
      throw error;
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    await lifecycle.retain(event, ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await lifecycle.shutdown(ctx);
  });
}
