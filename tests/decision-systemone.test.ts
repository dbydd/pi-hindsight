import { describe, expect, it, vi } from "vitest";
import {
  createHttpSystemOneBackend,
  createSystemOneBackend,
} from "../extensions/decision/systemone.js";
import type { DecisionQuestion } from "../extensions/decision/types.js";

function question(id: string, instructions = `Is bank ${id} worth reading?`): DecisionQuestion {
  return { id, instructions };
}

/** Named so the cases read the ids they assert, without index access. */
const QUESTIONS = [question("inject"), question("read:coding"), question("write:life")];
const INJECT = QUESTIONS[0]!;
const READ_CODING = QUESTIONS[1]!;
const WRITE_LIFE = QUESTIONS[2]!;

describe("systemone backend", () => {
  it("answers every question from the provider's noul values", async () => {
    const evaluate = vi.fn().mockResolvedValue({
      answers: {
        inject: { type: "noul", noul: 0.9 },
        "read:coding": { type: "noul", noul: 0.2 },
        // The provider returns nothing for this one: the rung reports it as
        // unanswered, and the layer drops that bank rather than guessing.
        "write:life": undefined,
      },
    });
    const backend = createSystemOneBackend({
      source: { evaluate },
      label: "systemone/group/decider",
    });

    await expect(backend.answer(QUESTIONS, "state text", { threshold: 0.5 })).resolves.toEqual({
      inject: true,
      "read:coding": false,
      "write:life": undefined,
    });
    expect(backend.kind).toBe("systemone");
    expect(backend.label).toBe("systemone/group/decider");
  });

  it("sends the question table as noul questions and no model when unset", async () => {
    const evaluate = vi.fn().mockResolvedValue({ answers: {} });
    const backend = createSystemOneBackend({ source: { evaluate }, label: "systemone" });

    await backend.answer(QUESTIONS, "state text", {});

    expect(evaluate).toHaveBeenCalledWith(
      {
        state: "state text",
        questions: {
          inject: { type: "noul", instructions: INJECT.instructions },
          "read:coding": { type: "noul", instructions: READ_CODING.instructions },
          "write:life": { type: "noul", instructions: WRITE_LIFE.instructions },
        },
      },
      {},
    );
  });

  it("passes the configured model and the caller's signal through", async () => {
    const evaluate = vi.fn().mockResolvedValue({ answers: {} });
    const controller = new AbortController();
    const backend = createSystemOneBackend({
      source: { evaluate },
      label: "systemone",
      model: "group/decider",
    });

    await backend.answer([question("inject")], "state", { signal: controller.signal });

    expect(evaluate).toHaveBeenCalledWith(
      {
        state: "state",
        model: "group/decider",
        questions: { inject: { type: "noul", instructions: INJECT.instructions } },
      },
      { signal: controller.signal },
    );
  });

  it("applies the caller's threshold, not the default", async () => {
    const evaluate = vi.fn().mockResolvedValue({
      answers: { inject: { type: "noul", noul: 0.6 } },
    });
    const backend = createSystemOneBackend({ source: { evaluate }, label: "systemone" });

    await expect(
      backend.answer([question("inject")], "state", { threshold: 0.8 }),
    ).resolves.toEqual({
      inject: false,
    });
  });

  it("propagates a transport failure so the layer falls to the next rung", async () => {
    const evaluate = vi.fn().mockRejectedValue(new Error("gateway unreachable"));
    const backend = createSystemOneBackend({ source: { evaluate }, label: "systemone" });

    await expect(backend.answer([question("inject")], "state", {})).rejects.toThrow(
      "gateway unreachable",
    );
  });
});

describe("http systemone backend", () => {
  /** Records the request the published provider would have sent, and answers it. */
  function recordingFetch(response: unknown) {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  it("posts the noul questions to the System One endpoint with the resolved model", async () => {
    const { calls, fetchImpl } = recordingFetch({
      answers: { inject: { type: "noul", noul: 0.95 } },
    });
    const backend = createHttpSystemOneBackend(
      { baseUrl: "http://127.0.0.1:3425", model: "group/decider", fetch: fetchImpl },
      "systemone/group/decider",
    );

    await expect(
      backend.answer([question("inject")], "state text", { threshold: 0.5 }),
    ).resolves.toEqual({
      inject: true,
    });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("http://127.0.0.1:3425/v1/systemone");
    const body = JSON.parse(String(call.init?.body)) as {
      state: string;
      questions: Record<string, { type: string; instructions: string }>;
      model: string;
    };
    expect(body).toEqual({
      state: "state text",
      questions: { inject: { type: "noul", instructions: INJECT.instructions } },
      model: "group/decider",
    });
  });

  /** Answers the request with a non-OK status, so the rung must reject. */
  function failingFetch(status: number) {
    const calls: { url: string; auth: string }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({
        url: String(url),
        auth: String(new Headers(init?.headers).get("authorization") ?? ""),
      });
      return new Response(JSON.stringify({ detail: "nope" }), {
        status,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  it("sends the api key as a bearer token and reports a backend failure", async () => {
    const { calls, fetchImpl } = failingFetch(400);
    const backend = createHttpSystemOneBackend(
      {
        baseUrl: "http://127.0.0.1:3425",
        apiKey: "secret-key",
        model: "group/decider",
        fetch: fetchImpl,
      },
      "systemone",
    );

    await expect(backend.answer([question("inject")], "state", {})).rejects.toThrow(
      /provider error 400/,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.auth).toBe("Bearer secret-key");
  });

  it("treats a malformed response as a failed rung, not a wrong answer", async () => {
    const { fetchImpl } = recordingFetch({ answers: { inject: { type: "noul", noul: 4 } } });
    const backend = createHttpSystemOneBackend(
      { baseUrl: "http://127.0.0.1:3425", fetch: fetchImpl },
      "systemone",
    );

    await expect(backend.answer([question("inject")], "state", {})).rejects.toThrow(/invalid noul/);
  });
});
