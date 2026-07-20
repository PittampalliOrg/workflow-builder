import { describe, expect, it, vi } from "vitest";
import type { ModelCompletionPort } from "$lib/server/application/ports";
import { ApplicationEvaluationJudgeService } from "./evaluation-judge";

function completionPort(output: string): ModelCompletionPort {
	return {
		isAvailable: () => true,
		complete: vi.fn(async () => output),
		generate: vi.fn(),
	};
}

describe("ApplicationEvaluationJudgeService", () => {
	it("requests structured output through the injected completion port", async () => {
		const completion = completionPort(
			JSON.stringify({ score: 0.8, verdict: "GOOD", rationale: "Correct" }),
		);
		const service = new ApplicationEvaluationJudgeService(completion, {
			modelName: "kimi-k3",
		});

		await expect(
			service.judge({ name: "Correctness", prompt: "Compare expected and actual" }),
		).resolves.toEqual({
			model: "kimi-k3",
			score: 0.8,
			rationale: "Correct",
			raw: { score: 0.8, verdict: "GOOD", rationale: "Correct" },
		});
		expect(completion.complete).toHaveBeenCalledWith(
			expect.objectContaining({
				maxOutputTokens: 1_024,
				responseFormat: { type: "json_object" },
			}),
		);
	});

	it("maps legacy verdict-only JSON and rejects malformed model output", async () => {
		const passService = new ApplicationEvaluationJudgeService(
			completionPort('```json\n{"verdict":"PASS","reasoning":"Matches"}\n```'),
		);
		await expect(passService.judge({ prompt: "Judge" })).resolves.toMatchObject({
			score: 1,
			rationale: "Matches",
		});

		const malformed = new ApplicationEvaluationJudgeService(completionPort("GOOD"));
		await expect(malformed.judge({ prompt: "Judge" })).rejects.toThrow(
			"invalid JSON",
		);
	});

	it("fails before completion when the configured model port is unavailable", async () => {
		const completion = completionPort("{}");
		completion.isAvailable = () => false;
		const service = new ApplicationEvaluationJudgeService(completion);

		await expect(service.judge({ prompt: "Judge" })).rejects.toThrow("unavailable");
		expect(completion.complete).not.toHaveBeenCalled();
	});
});
