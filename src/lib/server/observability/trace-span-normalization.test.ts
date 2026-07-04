import { describe, expect, it } from "vitest";
import {
	enrichLlmSpansWithRawTraceAttributes,
	normalizeRawTraceSpans,
} from "$lib/server/observability/trace-span-normalization";
import type {
	ObservabilityLlmSpan,
	ObservabilityTraceSpan,
} from "$lib/types/observability";

describe("trace span normalization", () => {
	it("derives LLM and tool spans from raw trace spans", () => {
		const normalized = normalizeRawTraceSpans([
			rawSpan("llm-1", {
				"gen_ai.request.model": "gpt-test",
				"gen_ai.usage.input_tokens": 10,
				"gen_ai.usage.output_tokens": 5,
			}),
			rawSpan("tool-1", {
				"tool.name": "shell",
				"tool.arguments": '{"cmd":"pwd"}',
			}),
		]);

		expect(normalized.llmSpans).toHaveLength(1);
		expect(normalized.llmSpans[0]).toMatchObject({
			spanId: "llm-1",
			modelName: "gpt-test",
			promptTokens: 10,
			completionTokens: 5,
		});
		expect(normalized.toolSpans).toHaveLength(1);
		expect(normalized.toolSpans[0]).toMatchObject({
			spanId: "tool-1",
			toolName: "shell",
			toolArguments: { cmd: "pwd" },
		});
	});

	it("fills missing usage fields on derived LLM spans from raw spans", () => {
		const llm: ObservabilityLlmSpan = {
			traceId: "trace-1",
			spanId: "llm-1",
			parentSpanId: null,
			serviceName: "agent",
			timestamp: "2026-01-01T00:00:00.000Z",
			sessionId: "session-1",
			workflowExecutionId: "execution-1",
			agentRunId: null,
			statusCode: "OK",
			modelName: "gpt-test",
			provider: "openai",
			inputMessages: [],
			outputMessages: [],
			invocationParameters: null,
			finishReason: null,
			promptTokens: null,
			completionTokens: null,
			totalTokens: null,
			cacheReadInputTokens: null,
			cacheCreationInputTokens: null,
			reasoningTokens: null,
			inputMessagesTruncated: false,
			outputMessagesTruncated: false,
			invocationParametersTruncated: false,
		};

		const enriched = enrichLlmSpansWithRawTraceAttributes(
			[llm],
			[rawSpan("llm-1", { "usage.total_tokens": 15 })],
		);

		expect(enriched[0].totalTokens).toBe(15);
	});
});

function rawSpan(
	spanId: string,
	attributes: Record<string, unknown>,
): ObservabilityTraceSpan {
	return {
		traceId: "trace-1",
		spanId,
		parentSpanId: null,
		serviceName: "agent",
		operationName: spanId,
		spanKind: "Internal",
		startTime: "2026-01-01T00:00:00.000Z",
		duration: 1000,
		statusCode: "OK",
		status: "ok",
		depth: 0,
		attributes,
		resourceAttributes: {
			"session.id": "session-1",
			"workflow.execution.id": "execution-1",
		},
	};
}
