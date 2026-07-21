import { describe, expect, it } from "vitest";
import { categorizeSpan } from "./span-presentation";

describe("categorizeSpan", () => {
	it("keeps an explicit CHAIN llm_request helper out of the LLM tab", () => {
		expect(
			categorizeSpan({
				operationName: "claude_code.llm_request",
				attributes: {
					"openinference.span.kind": "CHAIN",
					"gen_ai.request.model": "kimi-k3",
				},
			}),
		).toBe("internal");
	});

	it("keeps the canonical OpenInference LLM activity in the LLM tab", () => {
		expect(
			categorizeSpan({
				operationName: "WorkflowActivity.dapr-agent-py.call_llm",
				attributes: { "openinference.span.kind": "LLM" },
			}),
		).toBe("llm");
	});
});
