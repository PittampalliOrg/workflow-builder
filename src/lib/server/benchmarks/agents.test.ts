import { describe, expect, it } from "vitest";
import { assertDaprAgentPyBenchmarkAgent } from "./agents";

const baseAgent = {
	id: "agent_1",
	name: "Solver",
	slug: "solver",
	runtime: "dapr-agent-py",
	runtimeAppId: "agent-runtime-solver",
	currentVersionId: "ver_1",
	registryStatus: "registered",
	version: 1,
	modelSpec: "nvidia/qwen/qwen3-coder-480b-a35b-instruct",
};

describe("benchmark agent validation", () => {
	it("accepts a published dapr-agent-py agent runtime", () => {
		const valid = assertDaprAgentPyBenchmarkAgent(baseAgent);
		expect(valid.runtimeAppId).toBe("agent-runtime-solver");
		expect(valid.effectiveProvider).toBe("nvidia");
		expect(valid.effectiveLlmComponent).toBe("llm-nvidia-qwen3-coder-480b");
	});

	it("accepts the tool-capable Foundry DeepSeek deployment", () => {
		const valid = assertDaprAgentPyBenchmarkAgent({
			...baseAgent,
			modelSpec: "foundry/DeepSeek-V4-Flash",
		});
		expect(valid.effectiveProvider).toBe("foundry");
		expect(valid.effectiveLlmComponent).toBe("llm-foundry-deepseek-v4-flash");
	});

	it("derives the per-agent runtime app id for legacy registered rows", () => {
		expect(
			assertDaprAgentPyBenchmarkAgent({
				...baseAgent,
				runtimeAppId: "dapr-agent-py",
			}).runtimeAppId,
		).toBe("agent-runtime-solver");
		expect(
			assertDaprAgentPyBenchmarkAgent({
				...baseAgent,
				runtimeAppId: null,
			}).runtimeAppId,
		).toBe("agent-runtime-solver");
	});

	it("rejects non-dapr-agent-py runtimes", () => {
		expect(() =>
			assertDaprAgentPyBenchmarkAgent({
				...baseAgent,
				runtime: "browser-use-agent",
			}),
		).toThrow(/dapr-agent-py/);
	});

	it("rejects unpublished or unregistered agents", () => {
		expect(() =>
			assertDaprAgentPyBenchmarkAgent({
				...baseAgent,
				currentVersionId: null,
			}),
		).toThrow(/published version/);
		expect(() =>
			assertDaprAgentPyBenchmarkAgent({
				...baseAgent,
				registryStatus: "failed",
			}),
		).toThrow(/registered/);
	});

	it("rejects non-tool-capable model specs for SWE-bench", () => {
		expect(() =>
			assertDaprAgentPyBenchmarkAgent({
				...baseAgent,
				modelSpec: "mistral/open-mistral-7b",
			}),
		).toThrow(/supported durable coding model|tool-capable/);
	});

	it("rejects requested model mismatches when the request names a known model", () => {
		expect(() =>
			assertDaprAgentPyBenchmarkAgent(baseAgent, {
				requestedModelNameOrPath: "anthropic/claude-opus-4-7",
			}),
		).toThrow(/does not match/);

		expect(
			assertDaprAgentPyBenchmarkAgent(baseAgent, {
				requestedModelNameOrPath: "qwen3-coder-480b-a35b-instruct",
			}).modelSpec,
		).toBe("nvidia/qwen/qwen3-coder-480b-a35b-instruct");
	});
});
