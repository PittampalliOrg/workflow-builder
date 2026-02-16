/**
 * Tests for eval scorer.
 */
import { describe, it, expect, vi } from "vitest";
import { runScorers, type ScorerLike } from "../src/mastra/eval-scorer.js";

describe("runScorers", () => {
  it("should return empty array when no scorers", async () => {
    const results = await runScorers([], "input", "output");
    expect(results).toHaveLength(0);
  });

  it("should run all scorers and return results", async () => {
    const scorers: ScorerLike[] = [
      {
        name: "relevance",
        score: vi.fn().mockResolvedValue({ score: 0.9, details: { key: "val" } }),
      },
      {
        name: "toxicity",
        score: vi.fn().mockResolvedValue({ score: 0.1 }),
      },
    ];

    const results = await runScorers(scorers, "What is 2+2?", "4", "run-123");

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      scorer: "relevance",
      score: 0.9,
      details: { key: "val" },
    });
    expect(results[1]).toEqual({
      scorer: "toxicity",
      score: 0.1,
      details: undefined,
    });

    // Verify scorers received correct arguments
    expect(scorers[0].score).toHaveBeenCalledWith({
      input: "What is 2+2?",
      output: "4",
      runId: "run-123",
    });
  });

  it("should handle scorer errors gracefully", async () => {
    const scorers: ScorerLike[] = [
      {
        name: "good-scorer",
        score: vi.fn().mockResolvedValue({ score: 0.8 }),
      },
      {
        name: "bad-scorer",
        score: vi.fn().mockRejectedValue(new Error("Scorer crashed")),
      },
    ];

    const results = await runScorers(scorers, "input", "output");

    expect(results).toHaveLength(2);
    expect(results[0].score).toBe(0.8);
    expect(results[1]).toEqual({
      scorer: "bad-scorer",
      score: -1,
      error: "Scorer crashed",
    });
  });
});
