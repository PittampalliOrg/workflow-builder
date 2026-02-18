import { describe, expect, it } from "vitest";
import {
	evaluateStopConditions,
	normalizeLoopPolicy,
	prepareLoopStep,
} from "../src/workflow/loop-policy.js";
import type { LoopStepRecord } from "../src/types/loop-policy.js";

describe("loop policy", () => {
	it("normalizes done tool declarations and prepare-step defaults", () => {
		const policy = normalizeLoopPolicy({
			doneTool: { enabled: true, name: "done", responseField: "answer" },
			prepareStep: {
				model: "openai/gpt-4o",
				toolChoice: "required",
				activeTools: ["read_file", "write_file"],
				rules: [{ fromStep: 3, model: "openai/gpt-4.1" }],
			},
		});

		const step1 = prepareLoopStep(policy, 1, {
			workflow: { input_as_text: "test" },
			state: { stepCount: 0 },
			input: {},
		});
		const step3 = prepareLoopStep(policy, 3, {
			workflow: { input_as_text: "test" },
			state: { stepCount: 2 },
			input: {},
		});

		expect(step1.modelSpec).toBe("openai/gpt-4o");
		expect(step1.toolChoice).toBe("required");
		expect(step1.declarationOnlyTools?.[0]?.name).toBe("done");
		expect(step3.modelSpec).toBe("openai/gpt-4.1");
	});

	it("supports CEL-gated prepare-step rules", () => {
		const policy = normalizeLoopPolicy({
			prepareStep: {
				model: "openai/gpt-4o-mini",
				rules: [
					{
						fromStep: 2,
						when: "state.stepCount >= 1",
						model: "openai/gpt-4o",
					},
				],
			},
		});

		const prepared = prepareLoopStep(policy, 2, {
			workflow: { input_as_text: "x" },
			state: { stepCount: 1 },
			input: {},
		});
		expect(prepared.modelSpec).toBe("openai/gpt-4o");
	});

	it("matches built-in and CEL stop conditions", () => {
		const policy = normalizeLoopPolicy({
			stopWhen: [
				{ type: "hasToolCall", toolName: "write_file" },
				{
					type: "celExpression",
					expression: "state.totalUsage.totalTokens >= 1000",
				},
			],
		});

		const step: LoopStepRecord = {
			stepNumber: 2,
			assistantText: "working",
			toolCalls: [
				{
					id: "tc-1",
					type: "function",
					function: {
						name: "write_file",
						arguments: '{"path":"a.txt","content":"x"}',
					},
				},
			],
			usage: { inputTokens: 400, outputTokens: 200, totalTokens: 600 },
		};

		const result = evaluateStopConditions({
			policy,
			currentStep: step,
			allSteps: [step],
			executableByToolName: new Map([["write_file", true]]),
			celBindings: {
				workflow: { input_as_text: "test" },
				state: { totalUsage: { totalTokens: 1500 } },
				input: step,
			},
		});

		expect(result.shouldStop).toBe(true);
	});
});
