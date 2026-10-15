import { isRecord } from "../config/is-record.js";
import type { TodoGoal, TodoOpenItem, TodoState } from "./types.js";

/**
 * Task-state readers: one per host surface, both projecting into {@link TodoState}.
 *
 * `unknown` is a real answer. A host that cannot be read (plugin absent, entry
 * unreadable, malformed record) must never look like an empty task list, or the
 * decision model would route memory for a turn it believes has no open work.
 */

/** The omp todo plugin's synchronous request/reply read event. */
export const OMP_TODO_READ_EVENT = "omp-todo-more:read";
/** pi todo plugin session-entry type holding the task snapshot. */
export const PI_TODO_STATE_CUSTOM_TYPE = "rpiv-todo-state";

export const UNKNOWN_TODO: TodoState = { kind: "unknown" };

/** Minimal view of the omp event bus (`pi.events`). */
export interface OmpTodoPort {
  emit(name: string, payload: Record<string, unknown>): unknown;
}

/**
 * Read omp's `omp-todo-more` state. The plugin answers synchronously inside
 * `emit` via the `reply` callback; `{kind: "unavailable"}` means the plugin
 * could not read the list, which is `unknown`, not an empty list.
 */
export function readOmpTodoState(port: OmpTodoPort | undefined, agentId?: string): TodoState {
  if (!port || typeof port.emit !== "function") return UNKNOWN_TODO;
  let response: unknown;
  try {
    port.emit(OMP_TODO_READ_EVENT, {
      ...(agentId === undefined ? {} : { agentId }),
      reply: (value: unknown) => {
        response = value;
      },
    });
  } catch {
    return UNKNOWN_TODO;
  }
  if (!isRecord(response) || response.kind !== "ok") return UNKNOWN_TODO;
  return { kind: "ok", goal: ompGoal(response.goal), openItems: ompOpenItems(response.openItems) };
}

/**
 * Replay pi's `rpiv-todo-state` entries, newest first. A record that cannot be
 * read is skipped for the next older one; when none can be read the answer is
 * `unknown`.
 */
export function readPiTodoState(entries: readonly unknown[]): TodoState {
  for (let index = entries.length - 1; index >= 0; index--) {
    const state = piTodoStateFromEntry(entries[index]);
    if (state) return state;
  }
  return UNKNOWN_TODO;
}

function piTodoStateFromEntry(entry: unknown): TodoState | undefined {
  if (
    !isRecord(entry) ||
    entry.type !== "custom" ||
    entry.customType !== PI_TODO_STATE_CUSTOM_TYPE
  ) {
    return undefined;
  }
  const data = entry.data;
  if (!isRecord(data)) return undefined;
  const tasks = data.tasks;
  if (!Array.isArray(tasks)) return undefined;
  const openItems = tasks.flatMap((task) => piOpenItem(task));
  // A non-empty task array that yields no readable item is a malformed record:
  // report nothing rather than an empty list.
  if (tasks.length > 0 && openItems.length === 0) return undefined;
  return { kind: "ok", goal: null, openItems };
}

function piOpenItem(task: unknown): TodoOpenItem[] {
  if (!isRecord(task)) return [];
  if (task.status !== "pending" && task.status !== "in_progress") return [];
  const title = trimmed(task.subject);
  if (!title) return [];
  const description = trimmed(task.description);
  return [{ title, ...(description === undefined ? {} : { explanation: description }) }];
}

function ompGoal(raw: unknown): TodoGoal | null {
  if (!isRecord(raw)) return null;
  const objective = trimmed(raw.objective);
  if (!objective) return null;
  const measure = trimmed(raw.measure);
  const doneWhen = trimmed(raw.doneWhen);
  return {
    objective,
    ...(measure === undefined ? {} : { measure }),
    ...(doneWhen === undefined ? {} : { doneWhen }),
  };
}

function ompOpenItems(raw: unknown): TodoOpenItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): TodoOpenItem[] => {
    if (!isRecord(item)) return [];
    const title = trimmed(item.title);
    if (!title) return [];
    const phase = trimmed(item.phase);
    const explanation = trimmed(item.explanation);
    return [
      {
        title,
        ...(phase === undefined ? {} : { phase }),
        ...(explanation === undefined ? {} : { explanation }),
      },
    ];
  });
}

function trimmed(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
