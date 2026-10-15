#!/usr/bin/env node
// Memory-quality benchmark (#425): replays multi-session scenarios through the
// real recall/retain lifecycle against a live Hindsight and scores recall hit
// rate, recall-block contamination, duplicate-retain rate, and token-budget
// adherence. Runs locally and in the label-gated live-smoke CI lane.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HindsightClient } from "@vectorize-io/hindsight-client";
import type { AgentEndEvent } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createHindsightClient } from "../extensions/client/client.js";
import { DEFAULT_CONFIG } from "../extensions/config/config.js";
import type { ResolvedConfig } from "../extensions/types.js";
import { selectMemoryScopes } from "../extensions/operations/memory-scope.js";
import { recallForContext } from "../extensions/lifecycle/recall.js";
import { buildRetainJob, enqueueRetainFromAgentEnd } from "../extensions/lifecycle/retain.js";
import {
  advanceRetainCursor,
  filterNewRetainMessages,
  readSessionRetainState,
  retainedThroughIndex,
} from "../extensions/lifecycle/retain-cursor.js";
import { stableSessionId } from "../extensions/utils/session.js";
import {
  cleanupSmokeBank,
  createSmokeRecorder,
  envValue,
  sleep,
  smokeConfig,
  writeGitHubSummary,
} from "./smoke-helpers.js";

interface BenchSession {
  label: string;
  transcript: Array<{ role: "user" | "assistant"; content: string }>;
  query?: string;
  expectMarkers?: string[];
}

interface BenchScenario {
  id: string;
  kind: "lifeos" | "coding";
  sessions: BenchSession[];
}

function scenarios(runId: string): BenchScenario[] {
  const m = (name: string) => `bench-${runId}-${name}`;
  return [
    {
      id: "lifeos-preferences",
      kind: "lifeos",
      sessions: [
        {
          label: "day-1-coffee",
          transcript: [
            { role: "user", content: `I always drink my coffee black, no sugar [${m("coffee")}].` },
            { role: "assistant", content: "Got it, I'll remember your coffee preference." },
          ],
        },
        {
          label: "day-2-allergy",
          transcript: [
            { role: "user", content: `Important: I am allergic to peanuts [${m("peanuts")}].` },
            { role: "assistant", content: "Understood, noting your peanut allergy." },
          ],
        },
        {
          label: "day-3-recall-coffee",
          query: "How do I take my coffee?",
          expectMarkers: [m("coffee")],
          transcript: [
            { role: "assistant", content: "You drink your coffee black with no sugar." },
          ],
        },
        {
          label: "day-4-recall-allergy",
          query: "Do I have any food allergies you should consider?",
          expectMarkers: [m("peanuts")],
          transcript: [{ role: "assistant", content: "Yes, you are allergic to peanuts." }],
        },
      ],
    },
    {
      id: "coding-decisions",
      kind: "coding",
      sessions: [
        {
          label: "session-1-database",
          transcript: [
            {
              role: "user",
              content: `Decision: the orders service uses Postgres, not Mongo [${m("db")}].`,
            },
            { role: "assistant", content: "Recorded: orders service on Postgres." },
          ],
        },
        {
          label: "session-2-auth",
          transcript: [
            {
              role: "user",
              content: `Decision: API auth is short-lived JWT with refresh in an httpOnly cookie [${m("auth")}].`,
            },
            { role: "assistant", content: "Recorded the auth decision." },
          ],
        },
        {
          label: "session-3-recall-db",
          query: "What datastore did we choose for the orders service?",
          expectMarkers: [m("db")],
          transcript: [{ role: "assistant", content: "Orders service uses Postgres." }],
        },
      ],
    },
  ];
}

function buildMessages(
  transcript: BenchSession["transcript"],
  baseTimestamp: number,
): AgentEndEvent["messages"] {
  return transcript.map(
    (turn, index) =>
      ({
        role: turn.role,
        content: turn.content,
        timestamp: baseTimestamp + index,
      }) as AgentMessage,
  ) as AgentEndEvent["messages"];
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

async function recallUntil(
  fn: () => Promise<{ rendered: string }>,
  predicate: (value: { rendered: string }) => boolean,
  attempts: number,
  delayMs: number,
): Promise<{ hit: boolean; rendered: string }> {
  let rendered = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const value = await fn();
    rendered = value.rendered;
    if (predicate(value)) return { hit: true, rendered };
    if (attempt < attempts) await sleep(delayMs);
  }
  return { hit: false, rendered };
}

interface ScenarioScore {
  id: string;
  kind: string;
  recallQueries: number;
  recallHits: number;
  retainedMessages: number;
  duplicateRetains: number;
  budgetChecks: number;
  budgetAdherent: number;
}

async function runScenario(args: {
  scenario: BenchScenario;
  config: ResolvedConfig;
  client: ReturnType<typeof createHindsightClient>;
  bankId: string;
  attempts: number;
  delayMs: number;
  recorder: ReturnType<typeof createSmokeRecorder>;
}): Promise<ScenarioScore> {
  const { scenario, config, client, bankId, attempts, delayMs, recorder } = args;
  const cwd = mkdtempSync(join(tmpdir(), `pi-hindsight-bench-${scenario.id}-`));
  mkdirSync(join(cwd, ".git"));
  const sessionFile = join(cwd, "bench-session.jsonl");
  const sessionId = stableSessionId(sessionFile, cwd);
  const budgetTokens = config.recall.maxTokens;

  const score: ScenarioScore = {
    id: scenario.id,
    kind: scenario.kind,
    recallQueries: 0,
    recallHits: 0,
    retainedMessages: 0,
    duplicateRetains: 0,
    budgetChecks: 0,
    budgetAdherent: 0,
  };

  let baseTimestamp = 1;
  for (const session of scenario.sessions) {
    if (session.query) {
      const expect = session.expectMarkers ?? [];
      const scopes = selectMemoryScopes(cwd, config);
      const { hit, rendered } = await recallUntil(
        () =>
          recallForContext({
            client,
            config,
            scopes,
            messages: buildMessages([{ role: "user", content: session.query! }], baseTimestamp),
            cwd,
          }),
        (value) => expect.every((marker) => value.rendered.includes(marker)),
        attempts,
        delayMs,
      );
      score.recallQueries += 1;
      if (hit) score.recallHits += 1;
      score.budgetChecks += 1;
      const tokens = estimateTokens(rendered);
      if (tokens <= budgetTokens) score.budgetAdherent += 1;
      recorder.step("recall", {
        scenario: scenario.id,
        session: session.label,
        hit,
        tokens,
        budgetTokens,
      });
    }

    const messages = buildMessages(session.transcript, baseTimestamp + 10);
    baseTimestamp += 100;

    const state = await readSessionRetainState(cwd, sessionId);
    const newMessages = filterNewRetainMessages(messages as AgentMessage[], state);
    if (newMessages.length > 0) {
      await enqueueRetainFromAgentEnd({
        event: { messages: newMessages } as AgentEndEvent,
        cwd,
        sessionFile,
        config,
        client,
        bankId,
      });
      score.retainedMessages += newMessages.length;
    }
    await advanceRetainCursor(
      cwd,
      sessionId,
      messages as AgentMessage[],
      retainedThroughIndex(messages as AgentMessage[], newMessages),
    );

    const replayState = await readSessionRetainState(cwd, sessionId);
    const replay = filterNewRetainMessages(messages as AgentMessage[], replayState);
    score.duplicateRetains += replay.length;
  }

  recorder.step("scenario_done", { ...score });
  return score;
}

function contaminationCheck(config: ResolvedConfig): { leaked: boolean } {
  const marker = "BENCH_RECALL_BLOCK_PLANTED";
  const messages = [
    {
      role: "user",
      customType: "hindsight-recall",
      content: `<hindsight-memory>\n${marker}\n</hindsight-memory>`,
      timestamp: 1,
    },
    { role: "user", content: "Please continue the task.", timestamp: 2 },
    { role: "assistant", content: "Continuing the task now.", timestamp: 3 },
  ] as unknown as AgentEndEvent["messages"];
  const job = buildRetainJob({ config, cwd: "/bench", bankId: "bench", messages });
  const leaked = (job?.item.content ?? "").includes(marker);
  return { leaked };
}

async function main() {
  const base = smokeConfig();
  const integrationEnabled = envValue("HINDSIGHT_INTEGRATION_ENABLED") === "true";
  const recorder = createSmokeRecorder();
  const runId = `${Date.now().toString(36)}`;
  const reportPath =
    envValue("PI_HINDSIGHT_BENCH_REPORT") ?? join(tmpdir(), `pi-hindsight-bench-${runId}.json`);

  if (!integrationEnabled) {
    recorder.step("skipped", { reason: "HINDSIGHT_INTEGRATION_ENABLED is not true" });
    return;
  }

  const bankId = base.bankId;
  const config: ResolvedConfig = {
    ...DEFAULT_CONFIG,
    hindsight: {
      ...DEFAULT_CONFIG.hindsight,
      baseUrl: base.baseUrl,
      timeoutMs: 90_000,
      ...(base.apiKey ? { apiKey: base.apiKey } : {}),
    },
    banks: [
      { id: "coding", alias: "project", enabled: true, bankId, derive: "manual" },
      { id: "life", alias: "user", enabled: false },
    ],
    recall: { ...DEFAULT_CONFIG.recall, budget: "low" },
  };

  const rawClient = new HindsightClient({
    baseUrl: base.baseUrl,
    ...(base.apiKey ? { apiKey: base.apiKey } : {}),
    userAgent: "pi-hindsight-bench/0.1.0",
  });
  const client = createHindsightClient(config);
  let succeeded = false;

  try {
    await rawClient.createBank(bankId, {
      name: bankId,
      reflectMission: "Benchmark bank for Pi Hindsight memory quality scoring.",
      retainMission:
        "Retain personal facts and project decisions verbatim, preserving bench marker strings.",
      retainExtractionMode: "verbose",
      enableObservations: true,
    });
    recorder.step("bank_ok", { bankId });

    const all = scenarios(runId);
    const scores: ScenarioScore[] = [];
    for (const scenario of all) {
      scores.push(
        await runScenario({
          scenario,
          config,
          client,
          bankId,
          attempts: base.attempts,
          delayMs: 2000,
          recorder,
        }),
      );
    }

    const contamination = contaminationCheck(config);
    const recallQueries = scores.reduce((sum, s) => sum + s.recallQueries, 0);
    const recallHits = scores.reduce((sum, s) => sum + s.recallHits, 0);
    const retainedMessages = scores.reduce((sum, s) => sum + s.retainedMessages, 0);
    const duplicateRetains = scores.reduce((sum, s) => sum + s.duplicateRetains, 0);
    const budgetChecks = scores.reduce((sum, s) => sum + s.budgetChecks, 0);
    const budgetAdherent = scores.reduce((sum, s) => sum + s.budgetAdherent, 0);

    const ratio = (numerator: number, denominator: number) =>
      denominator === 0 ? 1 : Number((numerator / denominator).toFixed(4));

    const report = {
      runId,
      bankId,
      generatedAt: new Date().toISOString(),
      scenarios: scores,
      metrics: {
        recallHitRate: ratio(recallHits, recallQueries),
        contaminationRate: contamination.leaked ? 1 : 0,
        duplicateRetainRate: ratio(duplicateRetains, retainedMessages),
        tokenBudgetAdherence: ratio(budgetAdherent, budgetChecks),
      },
    };
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    recorder.step("report_ok", { reportPath, ...report.metrics });
    console.log(JSON.stringify(report, null, 2));
    succeeded = true;
  } catch (error) {
    console.error(
      JSON.stringify({
        step: "failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  } finally {
    await cleanupSmokeBank({ config: base, bankId, succeeded, recorder });
    const summary = await writeGitHubSummary(
      `## Memory benchmark\n\nRun \`${runId}\` against \`${base.baseUrl}\`. See JSON report at \`${reportPath}\`.\n`,
    );
    if (summary.error) recorder.step("summary_failed", { error: summary.error });
  }
}

await main();
