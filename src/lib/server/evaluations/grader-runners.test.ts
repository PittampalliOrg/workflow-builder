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

describe("LLM judge runner", () => {
	beforeEach(() => {
		mocks.daprFetch.mockReset();
		mocks.daprFetch.mockResolvedValue(
			Response.json({ score: 0.8, rationale: "Correct", raw: { verdict: "GOOD" } }),
		);
	});

	it.each(["llm_judge", "mlflow_judge"] as const)(
		"dispatches %s through the provider-neutral orchestrator endpoint",
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
				runGraderAsync(grader, {
					input: {},
					expectedOutput: "expected",
					generatedOutput: "actual",
				}),
			).resolves.toMatchObject({
				type,
				score: 0.8,
				passed: true,
				details: { model: "judge-default", rationale: "Correct" },
			});

			expect(mocks.daprFetch).toHaveBeenCalledTimes(1);
			const [url, init] = mocks.daprFetch.mock.calls[0] as [string, RequestInit];
			expect(url).toBe("http://workflow-orchestrator/api/v2/observability/judge");
			const body = JSON.parse(String(init.body));
			expect(body).toMatchObject({
				model: "judge-default",
				prompt: "Compare expected with actual",
				metadata: {
					eval_grader_type: "llm_judge",
					legacy_grader_type: type === "mlflow_judge" ? "mlflow_judge" : null,
				},
			});
		},
	);
});
