import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { findFirstSettings } = vi.hoisted(() => ({ findFirstSettings: vi.fn() }));

vi.mock("@/lib/db", () => ({
  db: { query: { settings: { findFirst: findFirstSettings } } },
}));

// Minimal stand-ins for the openai SDK's error hierarchy, matching the
// `instanceof` checks in lib/llm.ts's isRetryableLlmError/retryDelayMs.
class FakeAPIError extends Error {
  status?: number;
  headers?: Headers;
  constructor(status?: number, message = "error", headers?: Headers) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}
class FakeRateLimitError extends FakeAPIError {
  constructor(headers?: Headers) {
    super(429, "rate limited", headers);
  }
}
class FakeAPIConnectionError extends FakeAPIError {
  constructor() {
    super(undefined, "connection error", undefined);
  }
}

const createMock = vi.fn();

vi.mock("openai", () => {
  class OpenAI {
    chat = { completions: { create: createMock } };
  }
  return {
    default: OpenAI,
    APIError: FakeAPIError,
    RateLimitError: FakeRateLimitError,
    APIConnectionError: FakeAPIConnectionError,
  };
});

const { analyze, LlmUnavailableError } = await import("./llm");

function completion(content: string) {
  return { choices: [{ message: { content } }], usage: null };
}

const VALID_ANALYSIS_JSON = JSON.stringify({
  summary: { key_achievements: [], fixes_and_refactoring: [], architectural_changes: [] },
  next_steps: [],
  brainstorm_ideas: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  findFirstSettings.mockResolvedValue({
    llmApiKey: "test-key",
    llmBaseUrl: null,
    llmModel: "test-model",
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("analyze retry/degradation", () => {
  it("retries on a transient rate limit and succeeds", async () => {
    createMock
      .mockRejectedValueOnce(new FakeRateLimitError())
      .mockResolvedValueOnce(completion(VALID_ANALYSIS_JSON));

    const promise = analyze({ mode: "single", text: "some context", droppedCommits: 0 });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(createMock).toHaveBeenCalledTimes(2);
    expect(result.analysis.next_steps).toEqual([]);
  });

  it("throws LlmUnavailableError after exhausting retries on repeated connection errors", async () => {
    createMock.mockRejectedValue(new FakeAPIConnectionError());

    const promise = analyze({ mode: "single", text: "some context", droppedCommits: 0 });
    const expectation = expect(promise).rejects.toBeInstanceOf(LlmUnavailableError);
    await vi.runAllTimersAsync();
    await expectation;
    // APP_MAX_ATTEMPTS = 3
    expect(createMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry on a non-retryable error", async () => {
    createMock.mockRejectedValue(new FakeAPIError(400, "bad request"));

    const promise = analyze({ mode: "single", text: "some context", droppedCommits: 0 });
    const expectation = expect(promise).rejects.not.toBeInstanceOf(LlmUnavailableError);
    await vi.runAllTimersAsync();
    await expectation;
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});
