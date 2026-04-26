import { describe, expect, it } from "vitest";
import {
	aggregateGraderResults,
	runGrader,
	validateGraderDefinition,
} from "./graders";

describe("evaluation graders", () => {
	it("validates and runs string checks", () => {
		const grader = validateGraderDefinition({
			name: "Exact answer",
			type: "string_check",
			config: { operation: "equals" },
		});
		const result = runGrader(grader, {
			input: { question: "2+2" },
			expectedOutput: "4",
			generatedOutput: "4",
		});
		expect(result).toMatchObject({ score: 1, passed: true });
	});

	it("scores text similarity with a token Jaccard metric", () => {
		const grader = validateGraderDefinition({
			name: "Similarity",
			type: "text_similarity",
			config: { threshold: 0.5 },
		});
		const result = runGrader(grader, {
			input: {},
			expectedOutput: "alpha beta gamma",
			generatedOutput: "alpha beta delta",
		});
		expect(result.score).toBeCloseTo(0.5);
		expect(result.passed).toBe(true);
	});

	it("aggregates weighted grader scores", () => {
		const aggregate = aggregateGraderResults(
			[
				{ id: "a", name: "a", type: "string_check", score: 1, passed: true },
				{ id: "b", name: "b", type: "string_check", score: 0, passed: false },
			],
			new Map([
				["a", 3],
				["b", 1],
			]),
		);
		expect(aggregate.score).toBe(0.75);
		expect(aggregate.passed).toBe(false);
	});

	it("treats model graders as external worker work unless a mock score is supplied", () => {
		const grader = validateGraderDefinition({
			name: "Rubric",
			type: "score_model",
			config: { rubric: "Score correctness" },
		});
		const result = runGrader(grader, {
			input: {},
			expectedOutput: "yes",
			generatedOutput: "yes",
		});
		expect(result.skipped).toBe(true);
		expect(result.error).toContain("external model-grading worker");
	});
});
