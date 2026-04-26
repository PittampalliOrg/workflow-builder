import { describe, expect, it } from "vitest";
import {
	buildAgentEvaluationWorkflowSpec,
	buildSwebenchEvaluationWorkflowSpec,
	extractEvaluationGeneratedOutput,
	extractSwebenchModelPatch,
	parseDatasetImport,
	prepareEvaluationWorkflowTriggerData,
} from "./service";

describe("evaluation dataset import", () => {
	it("parses JSONL rows", () => {
		const rows = parseDatasetImport(
			'{"id":"row-1","input":{"prompt":"A"},"expectedOutput":"B"}\n{"id":"row-2","answer":"D"}\n',
			"jsonl",
		);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({ id: "row-1" });
	});

	it("parses CSV rows with quoted fields", () => {
		const rows = parseDatasetImport(
			'id,prompt,expectedOutput\nrow-1,"hello, world",ok\n',
			"csv",
		);
		expect(rows).toEqual([
			{ id: "row-1", prompt: "hello, world", expectedOutput: "ok" },
		]);
	});

	it("wraps a single JSON object as one row", () => {
		const rows = parseDatasetImport('{"id":"row-1","output":"ok"}', "json");
		expect(rows).toEqual([{ id: "row-1", output: "ok" }]);
	});
});

describe("evaluation agent workflow", () => {
	it("renders a durable/run workflow from a prompt template", () => {
		const spec = buildAgentEvaluationWorkflowSpec({
			evaluationName: "Answer quality",
			agentId: "agent_1",
			agentVersion: 2,
			input: { prompt: "What is 2+2?", locale: "en" },
			taskConfig: { promptTemplate: "{{input.prompt}}\nLocale: {{input.locale}}" },
		});
		const step = (spec.do as Array<Record<string, { call: string; with: { body: { prompt: string; agentRef: { version: number } } } }>>)[0]
			.evaluate;
		expect(step.call).toBe("durable/run");
		expect(step.with.body.prompt).toContain("What is 2+2?");
		expect(step.with.body.agentRef.version).toBe(2);
	});

	it("builds workflow trigger data with row fields and evaluation metadata", async () => {
		const triggerData = await prepareEvaluationWorkflowTriggerData({
			spec: {
				document: {
					dsl: "1.0.0",
					namespace: "tests",
					name: "workflow-eval",
					"x-workflow-builder": {
						input: {
							fields: {
								locale: { defaultValue: "en" },
							},
						},
					},
				},
				do: [
					{
						step: {
							with: {
								body: {
									prompt: "${ .trigger.prompt }",
									locale: "${ .trigger.locale }",
								},
							},
						},
					},
				],
			},
			runId: "run_1",
			itemId: "item_1",
			datasetRowId: "row_1",
			input: { prompt: "What is 2+2?" },
			expectedOutput: "4",
		});

		expect(triggerData).toMatchObject({
			prompt: "What is 2+2?",
			locale: "en",
			evaluation: {
				runId: "run_1",
				itemId: "item_1",
				datasetRowId: "row_1",
				input: { prompt: "What is 2+2?" },
				expectedOutput: "4",
			},
		});
	});

	it("renders a SWE-bench workflow that captures a model patch", () => {
		const spec = buildSwebenchEvaluationWorkflowSpec({
			evaluationName: "SWE-bench Lite",
			agentId: "agent_1",
			agentVersion: 3,
			input: {
				instanceId: "django__django-12345",
				repo: "django/django",
				baseCommit: "abc123",
				problemStatement: "Fix the failing test.",
			},
			taskConfig: {
				adapter: "swebench",
				datasetName: "princeton-nlp/SWE-bench_Lite",
			},
			executionConfig: { timeoutSeconds: 3600, maxTurns: 25 },
		});
		const steps = spec.do as Array<Record<string, Record<string, unknown>>>;
		expect(steps.map((step) => Object.keys(step)[0])).toEqual([
			"workspace_profile",
			"checkout_repo",
			"solve",
			"extract_patch",
		]);
		const solve = steps[2].solve as { call: string; with: { body: { agentRef: { version: number } } } };
		expect(solve.call).toBe("durable/run");
		expect(solve.with.body.agentRef.version).toBe(3);
		expect(JSON.stringify(spec.output)).toContain("modelPatch");
	});
});

describe("evaluation output extraction", () => {
	it("prefers generated output fields from workflow results", () => {
		expect(
			extractEvaluationGeneratedOutput({
				raw: "ignored",
				generatedOutput: { answer: "42" },
			}),
		).toEqual({ answer: "42" });
	});

	it("unwraps nested output/result objects", () => {
		expect(
			extractEvaluationGeneratedOutput({
				output: {
					result: {
						text: "final answer",
					},
				},
			}),
		).toBe("final answer");
	});

	it("extracts SWE-bench patches from generated output", () => {
		expect(
			extractSwebenchModelPatch({
				modelPatch: "diff --git a/a.py b/a.py\n+change",
			}),
		).toContain("diff --git");
	});
});
