import type { DecisionInstructions } from "../types.js";

/**
 * The three decision questions, as text.
 *
 * A one-line prompt asks a small model to guess what the asker wanted, and the
 * guess it makes is the answer. Measured on a local judge at temperature 0: the
 * same request answered `inject = 0.151` against the old one-line text and
 * `0.862` against a version that spelled out what the signal looks like. Every
 * default below therefore says three things — what the decision controls, which
 * state fields bear on it, and which way to lean when the state is ambiguous.
 *
 * The lean is toward "no" on all three gates. Recall injection costs context
 * window on every turn it fires, so a gate that fires on weak signals degrades
 * into the every-turn recall this layer exists to replace.
 *
 * Every default is configurable through `decision.instructions`. Placeholders
 * are substituted per candidate before the backend sees the text.
 */

/** Spelled out for a bank whose entry carries no `description`. */
export const MISSING_DESCRIPTION = "no description provided";

/** Substituted into question text: `{bank}`, `{description}`, `{access}`. */
export interface InstructionPlaceholders {
  bank: string;
  description: string;
  access: string;
}

/**
 * Gate A: whether this turn injects recall at all.
 *
 * Cost side first, then the signal, then the lean — the order the model reads in.
 */
export const DEFAULT_INJECT_INSTRUCTION = [
  "Decide whether this turn injects a block of memories recalled from past sessions before the answer is generated.",
  "An injected block is context the model did not ask for: it spends context window on every turn it fires and dilutes attention on the current question, so a turn that does not need it is worse off for having it.",
  "Answer yes only when the state shows a real signal that past sessions matter here.",
  "Signals: the user refers back to earlier work, a decision, a preference, or a constraint already established; the user asks a follow-up that only makes sense with what came before; the user explicitly asks to retrieve or look up something stored.",
  "The user is asking to retrieve previously stored memory records, which is a direct memory query that requires recall.",
  "Answer no when the question is self-contained and answerable on its own — a fresh question, a small factual or arithmetic query, a command to run, or a request whose answer lives in the current repository rather than in past sessions.",
  "The task state matters: an open task that references earlier work is a signal, and a task whose goal is entirely in the current turn is not.",
  "Default to no. Uncertain, or no clear signal, means no injection.",
].join(" ");

/** Gate B, read half: whether recall reads one specific bank this turn. */
export const DEFAULT_READ_INSTRUCTION = [
  'Decide whether automatic recall reads bank "{bank}" this turn.',
  "That bank holds: {description}. Its access is {access}.",
  "Reading a bank it does not need costs context window and dilutes attention on the current question, so an extra bank is a cost, not a free option.",
  'Answer yes only when this turn\'s question plausibly needs what "{bank}" holds.',
  "Judge the bank independently of every other bank in the list: this question is about this bank alone.",
  "Default to no. Uncertain, or the turn's question does not clearly touch what this bank holds, means no read.",
].join(" ");

/** Gate B, write half: whether retain writes this turn into one specific bank. */
export const DEFAULT_WRITE_INSTRUCTION = [
  'Decide whether this turn\'s memory is retained into bank "{bank}".',
  "That bank holds: {description}. Its access is {access}.",
  "A wrong write is not neutral: it lands in the bank and pollutes every later recall that reads it, so a write that does not belong is worse than a missed one.",
  'Answer yes only when this turn produced content that belongs in "{bank}" by its description.',
  "Judge the bank independently of every other bank in the list: this question is about this bank alone.",
  "Default to no. Uncertain, or the turn's content does not clearly belong in this bank, means no write.",
].join(" ");

/** The three defaults, as the config layer stores them. */
export const DEFAULT_DECISION_INSTRUCTIONS: DecisionInstructions = {
  inject: DEFAULT_INJECT_INSTRUCTION,
  read: DEFAULT_READ_INSTRUCTION,
  write: DEFAULT_WRITE_INSTRUCTION,
};

/** Replace the supported placeholders; an unknown one is left as written. */
export function renderInstruction(template: string, placeholders: InstructionPlaceholders): string {
  return template
    .replaceAll("{bank}", placeholders.bank)
    .replaceAll("{description}", placeholders.description)
    .replaceAll("{access}", placeholders.access);
}
