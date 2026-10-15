import { describe, expect, it } from "vitest";
import {
  PI_TODO_STATE_CUSTOM_TYPE,
  readOmpTodoState,
  readPiTodoState,
  UNKNOWN_TODO,
} from "../extensions/decision/todo-state.js";

/** Port whose reply is produced by the supplied handler. */
function ompPort(handler: (payload: Record<string, unknown>) => void) {
  return {
    emit: (_name: string, payload: Record<string, unknown>) => {
      handler(payload);
    },
  };
}

function piEntry(data: unknown, customType = PI_TODO_STATE_CUSTOM_TYPE): unknown {
  return { type: "custom", customType, data };
}

describe("omp todo reader", () => {
  it("projects the plugin's ok payload", () => {
    const payloads: Record<string, unknown>[] = [];
    const state = readOmpTodoState(
      ompPort((payload) => {
        payloads.push(payload);
        (payload.reply as (value: unknown) => void)({
          kind: "ok",
          goal: { objective: "obj", measure: "measure", doneWhen: "done" },
          openItems: [
            { phase: "Tests", title: "Write tests", explanation: "cover the ladder" },
            { title: "No phase" },
          ],
        });
      }),
      "Main",
    );

    expect(state).toEqual({
      kind: "ok",
      goal: { objective: "obj", measure: "measure", doneWhen: "done" },
      openItems: [
        { phase: "Tests", title: "Write tests", explanation: "cover the ladder" },
        { title: "No phase" },
      ],
    });
    expect(payloads[0]?.agentId).toBe("Main");
  });

  it("treats unavailable, silent, throwing, and junk replies as unknown", () => {
    const unavailable = readOmpTodoState(
      ompPort((payload) => {
        (payload.reply as (value: unknown) => void)({ kind: "unavailable" });
      }),
    );
    expect(unavailable).toBe(UNKNOWN_TODO);

    expect(readOmpTodoState(ompPort(() => undefined))).toBe(UNKNOWN_TODO);
    expect(
      readOmpTodoState({
        emit: () => {
          throw new Error("no plugin");
        },
      }),
    ).toBe(UNKNOWN_TODO);
    expect(
      readOmpTodoState(
        ompPort((payload) => {
          (payload.reply as (value: unknown) => void)("nope");
        }),
      ),
    ).toBe(UNKNOWN_TODO);
    expect(readOmpTodoState(undefined)).toBe(UNKNOWN_TODO);
  });

  it("drops unreadable items and an unreadable goal", () => {
    const state = readOmpTodoState(
      ompPort((payload) => {
        (payload.reply as (value: unknown) => void)({
          kind: "ok",
          goal: { measure: "no objective" },
          openItems: ["junk", { phase: "Tests" }, { title: "Keep me" }],
        });
      }),
    );
    expect(state).toEqual({ kind: "ok", goal: null, openItems: [{ title: "Keep me" }] });
  });

  it("does not duplicate the agent id when the caller has none", () => {
    const payloads: Record<string, unknown>[] = [];
    readOmpTodoState(
      ompPort((payload) => {
        payloads.push(payload);
        (payload.reply as (value: unknown) => void)({ kind: "ok", openItems: [] });
      }),
    );
    expect(Object.hasOwn(payloads[0] ?? {}, "agentId")).toBe(false);
  });
});

describe("pi todo reader", () => {
  it("replays the newest usable entry (branch order, oldest first)", () => {
    const state = readPiTodoState([
      piEntry({
        action: "init",
        tasks: [{ id: 9, subject: "Stale thing", status: "pending" }],
      }),
      piEntry({
        action: "init",
        tasks: [
          { id: 1, subject: "Done thing", status: "completed" },
          { id: 2, subject: "Open thing", description: "why it matters", status: "in_progress" },
          { id: 3, subject: "Later thing", status: "pending", blockedBy: [2] },
          { id: 4, subject: "Removed thing", status: "deleted" },
        ],
      }),
    ]);

    expect(state).toEqual({
      kind: "ok",
      goal: null,
      openItems: [{ title: "Open thing", explanation: "why it matters" }, { title: "Later thing" }],
    });
  });

  it("skips foreign, malformed, and unusable entries for an older readable one", () => {
    const state = readPiTodoState([
      piEntry({ tasks: [{ id: 1, subject: "Usable", status: "pending" }] }),
      piEntry({ tasks: "not an array" }),
      piEntry({ tasks: [{ id: 2, status: "pending" }] }),
      { type: "custom", customType: "something-else", data: { tasks: [] } },
      "junk",
    ]);
    expect(state).toEqual({ kind: "ok", goal: null, openItems: [{ title: "Usable" }] });
  });

  it("reports an empty task list as a readable empty list", () => {
    expect(readPiTodoState([piEntry({ action: "init", tasks: [] })])).toEqual({
      kind: "ok",
      goal: null,
      openItems: [],
    });
  });

  it("reports unknown when nothing on the branch can be read", () => {
    expect(readPiTodoState([])).toBe(UNKNOWN_TODO);
    expect(readPiTodoState([piEntry({ tasks: [{}] }), piEntry(undefined)])).toBe(UNKNOWN_TODO);
    expect(readPiTodoState([{ type: "custom", customType: PI_TODO_STATE_CUSTOM_TYPE }])).toBe(
      UNKNOWN_TODO,
    );
  });
});
