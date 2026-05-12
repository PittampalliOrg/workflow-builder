import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ObservabilityLlmSpan,
	ObservabilityTraceSpan,
} from "$lib/types/observability";

vi.mock("$lib/server/otel/clickhouse", () => ({
	getMultiTraceLlmSpans: vi.fn(),
	getMultiTraceToolSpans: vi.fn(),
	getMultiTraceSpans: vi.fn(),
}));

import {
	getMultiTraceLlmSpans,
	getMultiTraceSpans,
	getMultiTraceToolSpans,
} from "$lib/server/otel/clickhouse";
import {
	buildSwebenchTraceBundleFromClickHouse,
	normalizeRawTraceSpans,
	safeSwebenchTraceArtifactPath,
} from "./trace-bundle";

const baseSpan = (overrides: Partial<ObservabilityTraceSpan>): ObservabilityTraceSpan => ({
	traceId: "abc123",
	spanId: "span-1",
	parentSpanId: null,
	operationName: "operation",
	serviceName: "dapr-agent-py",
	startTime: "2026-05-05T12:00:00.000Z",
	duration: 10,
	status: "ok",
	statusCode: "OK",
	spanKind: "SPAN_KIND_INTERNAL",
	attributes: {},
	resourceAttributes: {},
	depth: 0,
	...overrides,
});

describe("safeSwebenchTraceArtifactPath", () => {
	it("keeps normal SWE-bench instance ids readable", () => {
		expect(safeSwebenchTraceArtifactPath("django__django-12345")).toBe(
			"traces/django__django-12345/trace-bundle.json",
		);
	});

	it("normalizes path separators and unsafe characters", () => {
		expect(safeSwebenchTraceArtifactPath("../weird/id:value ")).toBe(
			"traces/weird_id_value/trace-bundle.json",
		);
	});
});

describe("normalizeRawTraceSpans", () => {
	it("derives LLM and tool spans from raw OTel attributes", () => {
		const llm = baseSpan({
			spanId: "llm-1",
			operationName: "chat.completions",
			attributes: {
				"openinference.span.kind": "LLM",
				"model": "deepseek/deepseek-v4-pro",
				"input.value": JSON.stringify([{ role: "user", content: "fix it" }]),
				"output.value": JSON.stringify([{ role: "assistant", content: "done" }]),
				"gen_ai.usage.input_tokens": "11",
				"gen_ai.usage.output_tokens": 7,
				"gen_ai.usage.total_tokens": "18",
			},
		});
		const tool = baseSpan({
			spanId: "tool-1",
			operationName: "workspace/edit_file",
			startTime: "2026-05-05T12:00:01.000Z",
			attributes: {
				"span.type": "tool",
				"tool_name": "workspace/edit_file",
				"input.value": "{\"path\":\"app.py\"}",
				"output.value": "{\"ok\":true}",
			},
		});

		const normalized = normalizeRawTraceSpans([llm, tool]);

		expect(normalized.llmSpans).toHaveLength(1);
		expect(normalized.llmSpans[0].modelName).toBe("deepseek/deepseek-v4-pro");
		expect(normalized.llmSpans[0].promptTokens).toBe(11);
		expect(normalized.llmSpans[0].completionTokens).toBe(7);
		expect(normalized.llmSpans[0].totalTokens).toBe(18);
		expect(normalized.toolSpans).toHaveLength(1);
		expect(normalized.toolSpans[0].toolName).toBe("workspace/edit_file");
		expect(normalized.toolSpans[0].toolArguments).toEqual({ path: "app.py" });
		expect(normalized.toolSpans[0].toolResult).toEqual({ ok: true });
	});
});

describe("buildSwebenchTraceBundleFromClickHouse", () => {
	beforeEach(() => {
		vi.mocked(getMultiTraceLlmSpans).mockReset();
		vi.mocked(getMultiTraceToolSpans).mockReset();
		vi.mocked(getMultiTraceSpans).mockReset();
	});

	it("uses derived spans when obs tables are populated", async () => {
		const llmSpan: ObservabilityLlmSpan = {
			traceId: "abc123",
			spanId: "llm-derived",
			parentSpanId: null,
			serviceName: "dapr-agent-py",
			timestamp: "2026-05-05T12:00:00.000Z",
			sessionId: "",
			workflowExecutionId: "",
			agentRunId: null,
			statusCode: "OK",
			modelName: "claude",
			provider: "anthropic",
			inputMessages: [],
			outputMessages: [],
			invocationParameters: null,
			finishReason: null,
			promptTokens: null,
			completionTokens: null,
			totalTokens: null,
			inputMessagesTruncated: false,
			outputMessagesTruncated: false,
			invocationParametersTruncated: false,
		};
		vi.mocked(getMultiTraceLlmSpans).mockResolvedValue([llmSpan]);
		vi.mocked(getMultiTraceToolSpans).mockResolvedValue([]);
		vi.mocked(getMultiTraceSpans).mockResolvedValue([baseSpan({ spanId: "raw" })]);

		const bundle = await buildSwebenchTraceBundleFromClickHouse({
			runId: "run_1",
			runInstanceId: "ri_1",
			instanceId: "django__django-1",
			traceIds: ["abc123"],
			canonicalTraceId: "abc123",
			mlflowExperimentId: "1",
			mlflowRunId: "mlrun",
			artifactPath: "traces/django__django-1/trace-bundle.json",
		});

		expect(bundle.backend).toBe("clickhouse_derived");
		expect(bundle.canonicalTraceId).toBe("abc123");
		expect(bundle.llmSpans).toHaveLength(1);
		expect(bundle.traceSpans).toHaveLength(1);
		expect(bundle.warnings).toEqual([]);
	});

	it("reports canonical root health and missing auxiliary traces", async () => {
		const llmSpan: ObservabilityLlmSpan = {
			traceId: "primary123",
			spanId: "llm-1",
			parentSpanId: null,
			serviceName: "dapr-agent-py",
			timestamp: "2026-05-05T12:00:02.000Z",
			sessionId: "session-1",
			workflowExecutionId: "exec-1",
			agentRunId: null,
			statusCode: "OK",
			modelName: "claude",
			provider: "anthropic",
			inputMessages: [],
			outputMessages: [],
			invocationParameters: null,
			finishReason: null,
			promptTokens: null,
			completionTokens: null,
			totalTokens: null,
			inputMessagesTruncated: false,
			outputMessagesTruncated: false,
			invocationParametersTruncated: false,
		};
		vi.mocked(getMultiTraceLlmSpans).mockResolvedValue([llmSpan]);
		vi.mocked(getMultiTraceToolSpans).mockResolvedValue([]);
		vi.mocked(getMultiTraceSpans).mockResolvedValue([
			baseSpan({
				traceId: "primary123",
				spanId: "root",
				operationName: "workflow.finalize",
				attributes: {
					"gen_ai.operation.name": "workflow",
					"workflow.status": "OK",
				},
			}),
			baseSpan({
				traceId: "primary123",
				spanId: "node",
				operationName: "workflow.node.solve",
				attributes: { "gen_ai.operation.name": "workflow.node" },
			}),
			baseSpan({
				traceId: "primary123",
				spanId: "llm-1",
				operationName: "claude_code.llm_request",
				attributes: {
					"workflow.id": "wf",
					"workflow.execution.id": "exec-1",
					"workflow.node.id": "solve",
					"workflow.node.name": "Solve",
					"agent.id": "agent-1",
					"agent.version": 1,
					"agent.slug": "agent",
					"agent.app_id": "agent-runtime-agent",
					"mlflow.spanType": "CHAT_MODEL",
				},
			}),
		]);

		const bundle = await buildSwebenchTraceBundleFromClickHouse({
			runId: "run_1",
			runInstanceId: "ri_1",
			instanceId: "django__django-1",
			traceIds: ["primary123", "secondary456"],
			canonicalTraceId: "primary123",
			mlflowExperimentId: "1",
			mlflowRunId: null,
			artifactPath: "traces/django__django-1/trace-bundle.json",
		});

		expect(bundle.requiredContext.rootPresent).toBe(true);
		expect(bundle.requiredContext.statusFinalized).toBe(true);
		expect(bundle.requiredContext.nodeSpansPresent).toBe(true);
		expect(bundle.requiredContext.llmToolSpansPresent).toBe(true);
		expect(bundle.requiredContext.agentIdentityComplete).toBe(true);
		expect(bundle.requiredContext.auxiliaryTracesMissing).toBe(1);
		expect(bundle.auxiliaryTraces).toEqual([
			{ traceId: "secondary456", status: "missing" },
		]);
	});

	it("falls back to raw OTel normalization when derived tables are empty", async () => {
		vi.mocked(getMultiTraceLlmSpans).mockResolvedValue([]);
		vi.mocked(getMultiTraceToolSpans).mockResolvedValue([]);
		vi.mocked(getMultiTraceSpans).mockResolvedValue([
			baseSpan({
				spanId: "llm-raw",
				attributes: {
					"openinference.span.kind": "LLM",
					"model": "deepseek",
					"input.value": "prompt",
					"output.value": "answer",
				},
			}),
		]);

		const bundle = await buildSwebenchTraceBundleFromClickHouse({
			runId: "run_1",
			runInstanceId: "ri_1",
			instanceId: "django__django-1",
			traceIds: ["abc123"],
			canonicalTraceId: "abc123",
			mlflowExperimentId: "1",
			mlflowRunId: null,
			artifactPath: "traces/django__django-1/trace-bundle.json",
		});

		expect(bundle.backend).toBe("clickhouse_raw");
		expect(bundle.llmSpans).toHaveLength(1);
		expect(bundle.summary.traceSpanCount).toBe(1);
		expect(bundle.warnings[0]).toContain("derived obs.llm_spans");
	});
});
