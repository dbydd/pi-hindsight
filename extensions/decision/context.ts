import { isRecord } from "../config/is-record.js";
import type { DecisionBankCandidate, DecisionMessage, TodoState } from "./types.js";

/**
 * Decision context assembly.
 *
 * The last user message and the task state are mandatory context: they say what
 * the turn is about and what work is open. Only the recent-activity section is
 * budgeted (`decision.maxContextChars`), filled newest-first, so a long
 * transcript never crowds out the two facts the model must have.
 */
export interface DecisionStateInput {
  messages: readonly DecisionMessage[];
  todo: TodoState;
  readCandidates: readonly DecisionBankCandidate[];
  writeCandidates: readonly DecisionBankCandidate[];
  /** Character budget for the recent-activity section. */
  maxContextChars: number;
}

const RECENT_ACTIVITY_HEADER = "# Recent activity (oldest first)";

/** Text of the newest user message, or `""` when the transcript holds none. */
export function lastUserMessageText(messages: readonly DecisionMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    return messageText(message) ?? "";
  }
  return "";
}

/** Render the whole state the decision model reads. */
export function buildDecisionState(input: DecisionStateInput): string {
  const lastUser = lastUserMessageText(input.messages);
  const userSection = `# Last user message\n${lastUser || "(none)"}`;
  const todoSection = `# Task state\n${renderTodoState(input.todo)}`;
  const budget = Math.max(0, input.maxContextChars - userSection.length - todoSection.length);
  const activity = trimActivity(recentActivityLines(input.messages), budget);
  const sections = [userSection, todoSection];
  if (activity.length > 0) sections.push(`${RECENT_ACTIVITY_HEADER}\n${activity.join("\n")}`);
  sections.push(
    renderCandidates("# Readable banks (recall may inject from these)", input.readCandidates),
    renderCandidates("# Writable banks (retain may write to these)", input.writeCandidates),
  );
  return `${sections.join("\n\n")}\n`;
}

/** Task state as prompt text; `unknown` is spelled out so the model never reads it as "no work". */
export function renderTodoState(todo: TodoState): string {
  if (todo.kind === "unknown") {
    return "Unavailable — the task state could not be read. Do not assume the task list is empty.";
  }
  const lines: string[] = [];
  if (todo.goal) {
    const goal = [
      `objective: ${todo.goal.objective}`,
      ...(todo.goal.measure ? [`measure: ${todo.goal.measure}`] : []),
      ...(todo.goal.doneWhen ? [`done when: ${todo.goal.doneWhen}`] : []),
    ];
    lines.push(`Goal — ${goal.join(" | ")}`);
  }
  if (todo.openItems.length === 0) {
    lines.push("No open tasks recorded.");
    return lines.join("\n");
  }
  lines.push("Open items:");
  for (const item of todo.openItems) {
    const phase = item.phase ? `[${item.phase}] ` : "";
    const explanation = item.explanation ? ` — ${item.explanation}` : "";
    lines.push(`- ${phase}${item.title}${explanation}`);
  }
  return lines.join("\n");
}

/** Candidate banks with their access and description, so the model can judge what they hold. */
function renderCandidates(header: string, candidates: readonly DecisionBankCandidate[]): string {
  if (candidates.length === 0) return `${header}\n(none)`;
  const rows = candidates.map((candidate) => {
    const description = candidate.description ? `: ${candidate.description}` : "";
    return `- ${candidate.id} (${candidate.access})${description}`;
  });
  return `${header}\n${rows.join("\n")}`;
}

/** One transcript line per message after the last user message, oldest first. */
function recentActivityLines(messages: readonly DecisionMessage[]): string[] {
  let lastUser = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "user") {
      lastUser = index;
      break;
    }
  }
  const lines: string[] = [];
  for (const message of messages.slice(lastUser + 1)) {
    if (message.role === "user") continue;
    const text = messageText(message);
    if (text) lines.push(text);
  }
  return lines;
}

/** Greedy tail fill: newest lines first; the first line that overflows is cut and ends the fill. */
function trimActivity(lines: readonly string[], budget: number): string[] {
  const kept: string[] = [];
  let remaining = budget;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!;
    if (line.length <= remaining) {
      kept.push(line);
      remaining -= line.length;
      continue;
    }
    if (remaining > 0) kept.push(`${line.slice(0, Math.max(0, remaining - 1))}…`);
    break;
  }
  return kept.reverse();
}

/** Text a message contributes: string content, text blocks, and tool-call names. */
function messageText(message: DecisionMessage): string | undefined {
  const content = message.content;
  if (typeof content === "string") {
    const text = content.trim();
    return text || undefined;
  }
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (typeof block.text === "string" && block.text.trim()) {
      parts.push(block.text.trim());
      continue;
    }
    if (block.type === "toolCall" && typeof block.name === "string") {
      parts.push(`tool call ${block.name}`);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}
