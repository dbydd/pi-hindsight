import { describe, expect, it } from "vitest";
import { createDecisionCache } from "../extensions/decision/cache.js";
import { createDecisionLayer } from "../extensions/decision/decision.js";
import {
  DEFAULT_DECISION_INSTRUCTIONS,
  DEFAULT_INJECT_INSTRUCTION,
  DEFAULT_READ_INSTRUCTION,
  DEFAULT_WRITE_INSTRUCTION,
  MISSING_DESCRIPTION,
  renderInstruction,
} from "../extensions/decision/instructions.js";
import { DEFAULT_CONFIG } from "../extensions/config/config-defaults.js";
import { normalizeConfig } from "../extensions/config/config-normalize.js";
import type { DecisionBackend, DecisionQuestion } from "../extensions/decision/types.js";
import type { DecisionRequest } from "../extensions/decision/types.js";
import type { ResolvedConfig } from "../extensions/types.js";
import { decisionConfig, fakeHost } from "./helpers/decision.js";

/** The three gates a full recall+retain round asks, in order. */
const ALL_QUESTION_IDS = ["inject", "read:coding", "read:life", "write:coding", "write:archive"];

/** Candidates mirror the shape the lifecycle builds: id, access, and description when set. */
const READ = [
  { id: "coding", access: "read-write" as const, description: "repo memory" },
  { id: "life", access: "read" as const },
];
const WRITE = [
  { id: "coding", access: "read-write" as const, description: "repo memory" },
  { id: "archive", access: "write" as const },
];

/** Backend that captures the question table it was handed. */
function capturingBackend(): { backend: DecisionBackend; questions: DecisionQuestion[] } {
  const seen: DecisionQuestion[] = [];
  return {
    questions: seen,
    backend: {
      kind: "text",
      label: "capture",
      async answer(questions) {
        seen.push(...questions);
        return { inject: true };
      },
    },
  };
}

function request(): DecisionRequest {
  return {
    messages: [{ role: "user", content: "what did we decide last week?", timestamp: 1 }],
    readCandidates: READ,
    writeCandidates: WRITE,
  };
}

/** Decide with a fresh cache, so one layer answers exactly one question table. */
async function decideQuestions(
  config: ResolvedConfig,
  input: DecisionRequest = request(),
): Promise<DecisionQuestion[]> {
  const capture = capturingBackend();
  const layer = createDecisionLayer({
    host: fakeHost({ backends: () => [capture.backend] }),
    getConfig: () => config,
    cache: createDecisionCache(
      () => 60_000,
      () => 0,
    ),
  });
  await layer.decide(input);
  return capture.questions;
}

function questionsById(questions: readonly DecisionQuestion[]): Record<string, string> {
  return Object.fromEntries(questions.map((question) => [question.id, question.instructions]));
}

/** A concrete model spec: the role-less fake host resolves no role and no session model. */
const MODEL = { model: "magpie/group/labor" };

describe("default instruction text", () => {
  it("states the cost, the signal, and the default-deny lean in gate A", () => {
    // What the gate controls.
    expect(DEFAULT_INJECT_INSTRUCTION).toContain("injects");
    // The cost that justifies a "no".
    expect(DEFAULT_INJECT_INSTRUCTION).toContain("context window");
    // The signal the model should look for.
    expect(DEFAULT_INJECT_INSTRUCTION).toContain("refers back to earlier work");
    // The default, spelled out rather than implied.
    expect(DEFAULT_INJECT_INSTRUCTION).toContain("Default to no.");
  });

  it("carries the measured signal example that moved inject from 0.151 to 0.862", () => {
    expect(DEFAULT_INJECT_INSTRUCTION).toContain(
      "The user is asking to retrieve previously stored memory records",
    );
  });

  it("states the cost, the content, and the default-deny lean in the read gate", () => {
    expect(DEFAULT_READ_INSTRUCTION).toContain("reads bank");
    expect(DEFAULT_READ_INSTRUCTION).toContain("That bank holds");
    // A per-bank cost, not a blanket reason to read.
    expect(DEFAULT_READ_INSTRUCTION).toContain("costs context window");
    expect(DEFAULT_READ_INSTRUCTION).toContain("Default to no.");
  });

  it("states the pollution cost and the default-deny lean in the write gate", () => {
    expect(DEFAULT_WRITE_INSTRUCTION).toContain("retained into bank");
    expect(DEFAULT_WRITE_INSTRUCTION).toContain("That bank holds");
    // Why a wrong write is worse than a missed one.
    expect(DEFAULT_WRITE_INSTRUCTION).toContain("pollutes every later recall");
    expect(DEFAULT_WRITE_INSTRUCTION).toContain("Default to no.");
  });

  it("keeps every gate leaning the same way, so the layer never nudges toward recall", () => {
    for (const text of Object.values(DEFAULT_DECISION_INSTRUCTIONS)) {
      expect(text).toContain("Default to no.");
    }
  });
});

describe("placeholder substitution", () => {
  it("replaces bank, description, and access", () => {
    const rendered = renderInstruction("{bank} / {description} / {access}", {
      bank: "coding",
      description: "repo memory",
      access: "read-write",
    });
    expect(rendered).toBe("coding / repo memory / read-write");
  });

  it("leaves an unsupported placeholder as written", () => {
    expect(
      renderInstruction("{unknown} stays", { bank: "b", description: "d", access: "read" }),
    ).toBe("{unknown} stays");
  });
});

describe("questions carry the configured instruction text", () => {
  it("renders the defaults with each candidate's own values", async () => {
    const questions = questionsById(await decideQuestions(decisionConfig({ decision: MODEL })));
    expect(questions["inject"]).toBe(DEFAULT_INJECT_INSTRUCTION);
    // The described bank gets its description; the undescribed one gets the marker.
    expect(questions["read:coding"]).toContain('reads bank "coding"');
    expect(questions["read:coding"]).toContain("That bank holds: repo memory");
    expect(questions["read:life"]).toContain(`That bank holds: ${MISSING_DESCRIPTION}`);
    // Access rides along, so the model sees the bank's capability too.
    expect(questions["read:life"]).toContain("Its access is read");
    expect(questions["write:archive"]).toContain("Its access is write");
  });

  it("spells out a missing description instead of leaving an empty slot", async () => {
    const questions = questionsById(await decideQuestions(decisionConfig({ decision: MODEL })));
    expect(questions["read:life"]).not.toContain("That bank holds: \n");
    expect(questions["read:life"]).toContain(MISSING_DESCRIPTION);
  });

  it("treats a whitespace-only description as missing", async () => {
    const config = decisionConfig({ decision: MODEL });
    const questions = questionsById(
      await decideQuestions(config, {
        messages: [{ role: "user", content: "hello", timestamp: 1 }],
        readCandidates: [{ id: "coding", access: "read-write", description: "   " }],
        writeCandidates: [],
      }),
    );
    expect(questions["read:coding"]).toContain(`That bank holds: ${MISSING_DESCRIPTION}`);
  });

  it("uses a configured override verbatim, with placeholders substituted", async () => {
    const config = decisionConfig({
      decision: {
        ...MODEL,
        instructions: {
          inject: "Custom gate A.",
          read: 'Read "{bank}"? It holds {description} ({access}).',
          write: "Custom gate C.",
        },
      },
    });
    const questions = questionsById(await decideQuestions(config));
    expect(questions["inject"]).toBe("Custom gate A.");
    expect(questions["read:coding"]).toBe('Read "coding"? It holds repo memory (read-write).');
    expect(questions["write:coding"]).toBe("Custom gate C.");
  });

  it("keeps the same question ids and order whatever the text is", async () => {
    const questions = await decideQuestions(
      decisionConfig({ decision: { ...MODEL, instructions: { read: "Short." } } }),
    );
    expect(questions.map((question) => question.id)).toEqual(ALL_QUESTION_IDS);
  });
});

describe("decision.instructions normalization", () => {
  /** Same shape as tests/decision-config.test.ts: raw values ride in the first arg. */
  function normalize(decision: unknown): ResolvedConfig {
    return normalizeConfig({ ...DEFAULT_CONFIG, decision } as ResolvedConfig, { decision });
  }

  it("defaults to the built-in text", () => {
    expect(normalize(undefined).decision.instructions).toEqual(DEFAULT_DECISION_INSTRUCTIONS);
  });

  it("keeps a written instruction", () => {
    const config = normalize({
      instructions: { inject: "Only ask when the user names memory." },
    });
    expect(config.decision.instructions.inject).toBe("Only ask when the user names memory.");
    // The untouched gates keep their defaults.
    expect(config.decision.instructions.read).toBe(DEFAULT_READ_INSTRUCTION);
    expect(config.decision.instructions.write).toBe(DEFAULT_WRITE_INSTRUCTION);
  });

  it("falls back to the default for a blank or non-string instruction", () => {
    for (const value of ["", "   ", 42, null, undefined]) {
      const config = normalize({ instructions: { inject: value } });
      expect(config.decision.instructions.inject).toBe(DEFAULT_INJECT_INSTRUCTION);
    }
  });

  it("falls back to the defaults when instructions is not an object", () => {
    for (const value of ["junk", 7, null, []]) {
      const config = normalize({ instructions: value });
      expect(config.decision.instructions).toEqual(DEFAULT_DECISION_INSTRUCTIONS);
    }
  });
});
