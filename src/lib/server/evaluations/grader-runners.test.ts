import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	daprFetch: vi.fn(),
}));

vi.mock("$env/dynamic/private", () => ({
	env: { WORKFLOW_ORCHESTRATOR_URL: "http://workflow-orchestrator" },
}));

vi.mock("$lib/server/dapr-client", () => ({
	daprFetch: (...args: unknown[]) => mocks.daprFetch(...args),
	getCodeRuntimeUrl: () => "http://code-runtime",
	getDaprSidecarUrl: () => "http://localhost:3500",
}));

vi.mock("$lib/server/kube/client", () => ({
	wakeAgentRuntime: vi.fn(),
}));

import { runGraderAsync, validateGraderDefinition } from "./graders";

const judge = {
	isAvailable: () => true,
	judge: vi.fn(async () => ({
		model: "kimi-k3",
		score: 0.8,
		rationale: "Correct",
		raw: { verdict: "GOOD" },
	})),
};

describe("LLM judge runner", () => {
	beforeEach(() => {
		mocks.daprFetch.mockReset();
		judge.judge.mockClear();
	});

	it.each(["llm_judge", "mlflow_judge"] as const)(
		"dispatches %s through the injected application judge",
		async (type) => {
			const grader = validateGraderDefinition({
				id: "judge-1",
				name: "Correctness",
				type,
				config: {
					model: "judge-default",
					prompt: "Compare {{expected}} with {{actual}}",
				},
				passThreshold: 0.75,
			});

			await expect(
				runGraderAsync(
					grader,
					{
						input: {},
						expectedOutput: "expected",
						generatedOutput: "actual",
					},
					{ judge },
				),
			).resolves.toMatchObject({
				type,
				score: 0.8,
				passed: true,
				details: {
					model: "kimi-k3",
					rationale: "Correct",
					evalGraderType: "llm_judge",
					legacyGraderType: type === "mlflow_judge" ? "mlflow_judge" : null,
				},
			});

			expect(judge.judge).toHaveBeenCalledWith({
				name: "Correctness",
				prompt: "Compare expected with actual",
			});
			expect(mocks.daprFetch).not.toHaveBeenCalled();
		},
	);

	it("uses 0.5 as the canonical judge threshold when none is supplied", async () => {
		const grader = validateGraderDefinition({
			name: "Default threshold",
			type: "llm_judge",
			config: { prompt: "Judge {{actual}}" },
		});

		expect(grader.passThreshold).toBe(0.5);
		expect(grader.config.passThreshold).toBe(0.5);
		await expect(
			runGraderAsync(
				grader,
				{ input: {}, expectedOutput: null, generatedOutput: "answer" },
				{ judge },
			),
		).resolves.toMatchObject({ passed: true });
	});
});
