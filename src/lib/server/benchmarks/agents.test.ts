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

	it("accepts a published ADK Gemini agent runtime", () => {
		const valid = assertDaprAgentPyBenchmarkAgent({
			...baseAgent,
			runtime: "adk-agent-py",
			modelSpec: "googleai/gemini-3.1-pro-preview",
		});
		expect(valid.runtime).toBe("adk-agent-py");
		expect(valid.runtimeAppId).toBe("agent-runtime-solver");
		expect(valid.effectiveProvider).toBe("googleai");
		expect(valid.effectiveLlmComponent).toBe("llm-google-gemini");
	});

	it("accepts the tool-capable Foundry DeepSeek deployment", () => {
		const valid = assertDaprAgentPyBenchmarkAgent({
			...baseAgent,
			modelSpec: "foundry/DeepSeek-V4-Flash",
		});
		expect(valid.effectiveProvider).toBe("foundry");
		expect(valid.effectiveLlmComponent).toBe("llm-foundry-deepseek-v4-flash");
	});

	it("accepts Together coding models that have passed provider gating", () => {
		const glm = assertDaprAgentPyBenchmarkAgent({
			...baseAgent,
			modelSpec: "together/zai-org/GLM-5.1",
		});
		expect(glm.effectiveProvider).toBe("together");
		expect(glm.effectiveLlmComponent).toBe("llm-together-glm-51");

		const qwen = assertDaprAgentPyBenchmarkAgent({
			...baseAgent,
			modelSpec: "together/Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
		});
		expect(qwen.effectiveProvider).toBe("together");
		expect(qwen.effectiveLlmComponent).toBe("llm-together-qwen3-coder-480b");
	});

	it("keeps Together DeepSeek V4 Pro out of SWE-bench until conformance passes", () => {
		expect(() =>
			assertDaprAgentPyBenchmarkAgent({
				...baseAgent,
				modelSpec: "together/deepseek-ai/DeepSeek-V4-Pro",
			}),
		).toThrow(/tool-capable/);
	});

	it("accepts direct DeepSeek V4 models after conformance passes", () => {
		const pro = assertDaprAgentPyBenchmarkAgent({
			...baseAgent,
			modelSpec: "deepseek/deepseek-v4-pro",
		});
		expect(pro.effectiveProvider).toBe("deepseek");
		expect(pro.effectiveLlmComponent).toBe("llm-deepseek-v4-pro");

		const flash = assertDaprAgentPyBenchmarkAgent({
			...baseAgent,
			modelSpec: "deepseek-v4-flash",
		});
		expect(flash.effectiveProvider).toBe("deepseek");
		expect(flash.effectiveLlmComponent).toBe("llm-deepseek-v4-flash");
	});

	it("accepts Alibaba Qwen3-Coder Plus after conformance passes", () => {
		const qwen = assertDaprAgentPyBenchmarkAgent({
			...baseAgent,
			modelSpec: "alibaba/qwen3-coder-plus",
		});
		expect(qwen.effectiveProvider).toBe("alibaba");
		expect(qwen.effectiveLlmComponent).toBe("llm-alibaba-qwen3-coder-plus");
	});

	it("accepts direct Kimi models after conformance passes", () => {
		const k26 = assertDaprAgentPyBenchmarkAgent({
			...baseAgent,
			modelSpec: "kimi/kimi-k2.6",
		});
		expect(k26.effectiveProvider).toBe("kimi");
		expect(k26.effectiveLlmComponent).toBe("llm-kimi-k26");

		const k25 = assertDaprAgentPyBenchmarkAgent({
			...baseAgent,
			modelSpec: "kimi-k2.5",
		});
		expect(k25.effectiveProvider).toBe("kimi");
		expect(k25.effectiveLlmComponent).toBe("llm-kimi-k25");
	});

	it("keeps legacy DeepSeek default out of SWE-bench", () => {
		expect(() =>
			assertDaprAgentPyBenchmarkAgent({
				...baseAgent,
				modelSpec: "deepseek/default",
			}),
		).toThrow(/tool-capable/);
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
		).toThrow(/durable coding runtime/);
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
