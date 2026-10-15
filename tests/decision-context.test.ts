import { describe, expect, it } from "vitest";
import {
  buildDecisionState,
  lastUserMessageText,
  renderTodoState,
} from "../extensions/decision/context.js";
import type {
  DecisionBankCandidate,
  DecisionMessage,
  TodoState,
} from "../extensions/decision/types.js";

const MESSAGES: DecisionMessage[] = [
  { role: "user", content: "old question", timestamp: 1 },
  { role: "assistant", content: "old answer", timestamp: 2 },
  { role: "user", content: "newest question", timestamp: 3 },
  { role: "assistant", content: [{ type: "text", text: "newest answer" }], timestamp: 4 },
  { role: "tool", content: [{ type: "text", text: "tool output" }], timestamp: 5 },
];

const TODO: TodoState = {
  kind: "ok",
  goal: { objective: "Ship the decision layer", measure: "npm run check", doneWhen: "committed" },
  openItems: [{ phase: "Tests", title: "Cover the ladder", explanation: "four rungs" }],
};

const READ: DecisionBankCandidate[] = [
  { id: "coding", access: "read-write", description: "repo architecture and tasks" },
  { id: "life", access: "read" },
];

function state(overrides: Partial<Parameters<typeof buildDecisionState>[0]> = {}): string {
  return buildDecisionState({
    messages: MESSAGES,
    todo: TODO,
    readCandidates: READ,
    writeCandidates: [{ id: "archive", access: "write", description: "cold storage" }],
    maxContextChars: 10_000,
    ...overrides,
  });
}

describe("decision context", () => {
  it("reads the newest user message and ignores older ones", () => {
    expect(lastUserMessageText(MESSAGES)).toBe("newest question");
    expect(lastUserMessageText([{ role: "assistant", content: "x" }])).toBe("");
  });

  it("renders the user message, task state, activity, and bank candidates", () => {
    const rendered = state();
    expect(rendered).toContain("# Last user message\nnewest question");
    expect(rendered).toContain("# Task state\nGoal — objective: Ship the decision layer");
    expect(rendered).toContain("- [Tests] Cover the ladder — four rungs");
    // Only activity after the last user message, oldest first.
    expect(rendered).toContain("# Recent activity (oldest first)\nnewest answer\ntool output");
    expect(rendered).not.toContain("old answer");
    expect(rendered).toContain("- coding (read-write): repo architecture and tasks");
    expect(rendered).toContain("- life (read)\n");
    expect(rendered).toContain("- archive (write): cold storage");
  });

  it("names tool calls in the activity stream", () => {
    const rendered = state({
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: [{ type: "toolCall", name: "bash" }] },
      ],
    });
    expect(rendered).toContain("tool call bash");
  });

  it("keeps the user message and the task state when the budget is zero", () => {
    const rendered = state({ maxContextChars: 0 });
    expect(rendered).toContain("# Last user message\nnewest question");
    expect(rendered).toContain("Cover the ladder");
    expect(rendered).not.toContain("# Recent activity");
    expect(rendered).toContain("- coding (read-write)");
  });

  it("trims the activity section newest-first and marks a cut line", () => {
    const todo: TodoState = { kind: "ok", goal: null, openItems: [] };
    const messages: DecisionMessage[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: "a".repeat(100) },
      { role: "assistant", content: "z".repeat(50) },
    ];
    const fixed =
      `# Last user message\n${lastUserMessageText(messages)}`.length +
      `# Task state\n${renderTodoState(todo)}`.length;

    // Budget leaves room for the newest line only.
    const tight = buildDecisionState({
      messages,
      todo,
      readCandidates: [],
      writeCandidates: [],
      maxContextChars: fixed + 50,
    });
    expect(tight).toContain(`# Recent activity (oldest first)\n${"z".repeat(50)}`);
    expect(tight).not.toContain("a".repeat(100));

    // Half a line of budget: the newest line is cut, the older one is gone.
    const cut = buildDecisionState({
      messages,
      todo,
      readCandidates: [],
      writeCandidates: [],
      maxContextChars: fixed + 20,
    });
    expect(cut).toContain(`${"z".repeat(19)}…`);
    expect(cut).not.toContain("z".repeat(50));
    expect(cut).not.toContain("a".repeat(10));
  });

  it("spells out an unreadable task state instead of an empty one", () => {
    const unknown = state({ todo: { kind: "unknown" } });
    expect(unknown).toContain("Task state\nUnavailable");
    expect(unknown).not.toContain("No open tasks recorded.");
    const empty = state({ todo: { kind: "ok", goal: null, openItems: [] } });
    expect(empty).toContain("No open tasks recorded.");
  });
});
