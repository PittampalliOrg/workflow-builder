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
vi.mock("./mlflow", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./mlflow")>();
	return {
		...actual,
		getMlflowNativeTrace: vi.fn(),
	};
});

import {
	getMultiTraceLlmSpans,
	getMultiTraceSpans,
	getMultiTraceToolSpans,
} from "$lib/server/otel/clickhouse";
import { getMlflowNativeTrace } from "./mlflow";
import {
	buildSwebenchTraceBundle,
	buildSwebenchTraceBundleFromClickHouse,
	buildSwebenchTraceBundleFromMlflowNative,
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
				"gen_ai.usage.cache_read_input_tokens": "5",
				"llm.token_count.reasoning": 3,
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
		expect(normalized.llmSpans[0].cacheReadInputTokens).toBe(5);
		expect(normalized.llmSpans[0].reasoningTokens).toBe(3);
		expect(normalized.toolSpans).toHaveLength(1);
		expect(normalized.toolSpans[0].toolName).toBe("workspace/edit_file");
		expect(normalized.toolSpans[0].toolArguments).toEqual({ path: "app.py" });
		expect(normalized.toolSpans[0].toolResult).toEqual({ ok: true });
	});

	it("does not classify tool spans as LLM spans when telemetry context carries a model", () => {
		const tool = baseSpan({
			spanId: "tool-with-model-context",
			operationName: "agent-session.run_tool",
			attributes: {
				"mlflow.spanType": "TOOL",
				"gen_ai.request.model": "gemini-3.1-pro-preview",
				"tool.name": "bash_run",
				"input.value": "{\"command\":\"pwd\"}",
				"output.value": "{\"ok\":true}",
			},
		});

		const normalized = normalizeRawTraceSpans([tool]);

		expect(normalized.llmSpans).toHaveLength(0);
		expect(normalized.toolSpans).toHaveLength(1);
		expect(normalized.toolSpans[0].toolName).toBe("bash_run");
	});
});

describe("buildSwebenchTraceBundleFromClickHouse", () => {
	beforeEach(() => {
		vi.mocked(getMultiTraceLlmSpans).mockReset();
		vi.mocked(getMultiTraceToolSpans).mockReset();
		vi.mocked(getMultiTraceSpans).mockReset();
		vi.mocked(getMlflowNativeTrace).mockReset();
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
			cacheReadInputTokens: null,
			cacheCreationInputTokens: null,
			reasoningTokens: null,
			inputMessagesTruncated: false,
			outputMessagesTruncated: false,
			invocationParametersTruncated: false,
		};
		vi.mocked(getMultiTraceLlmSpans).mockResolvedValue([llmSpan]);
		vi.mocked(getMultiTraceToolSpans).mockResolvedValue([]);
		vi.mocked(getMultiTraceSpans).mockResolvedValue([
			baseSpan({
				spanId: "llm-derived",
				attributes: {
					"gen_ai.usage.cache_read_input_tokens": 42,
					"gen_ai.usage.reasoning_tokens": 9,
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
			mlflowRunId: "mlrun",
			artifactPath: "traces/django__django-1/trace-bundle.json",
		});

		expect(bundle.backend).toBe("clickhouse_derived");
		expect(bundle.canonicalTraceId).toBe("abc123");
		expect(bundle.llmSpans).toHaveLength(1);
		expect(bundle.llmSpans[0].cacheReadInputTokens).toBe(42);
		expect(bundle.llmSpans[0].reasoningTokens).toBe(9);
		expect(bundle.traceSpans).toHaveLength(1);
		expect(bundle.warnings).toEqual([]);
	});

	it("fills missing derived tool spans from raw OTel spans", async () => {
		const llmSpan: ObservabilityLlmSpan = {
			traceId: "abc123",
			spanId: "llm-derived",
			parentSpanId: null,
			serviceName: "adk-agent-py",
			timestamp: "2026-05-05T12:00:00.000Z",
			sessionId: "",
			workflowExecutionId: "",
			agentRunId: null,
			statusCode: "OK",
			modelName: "gemini-3.1-pro-preview",
			provider: "googleai",
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
		vi.mocked(getMultiTraceLlmSpans).mockResolvedValue([llmSpan]);
		vi.mocked(getMultiTraceToolSpans).mockResolvedValue([]);
		vi.mocked(getMultiTraceSpans).mockResolvedValue([
			baseSpan({
				spanId: "llm-derived",
				attributes: { "mlflow.spanType": "CHAT_MODEL" },
			}),
			baseSpan({
				spanId: "tool-raw",
				operationName: "agent-session.run_tool",
				attributes: {
					"mlflow.spanType": "TOOL",
					"tool.name": "Bash",
					"input.value": "{\"command\":\"git diff --stat\"}",
					"output.value": "{\"output\":\"file.py | 1 +\"}",
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
			mlflowRunId: "mlrun",
			artifactPath: "traces/django__django-1/trace-bundle.json",
		});

		expect(bundle.backend).toBe("clickhouse_raw");
		expect(bundle.llmSpans).toHaveLength(1);
		expect(bundle.toolSpans).toHaveLength(1);
		expect(bundle.toolSpans[0].toolName).toBe("Bash");
		expect(bundle.warnings[0]).toContain("obs.tool_spans");
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
			cacheReadInputTokens: null,
			cacheCreationInputTokens: null,
			reasoningTokens: null,
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

describe("buildSwebenchTraceBundleFromMlflowNative", () => {
	beforeEach(() => {
		vi.mocked(getMultiTraceLlmSpans).mockReset();
		vi.mocked(getMultiTraceToolSpans).mockReset();
		vi.mocked(getMultiTraceSpans).mockReset();
		vi.mocked(getMlflowNativeTrace).mockReset();
	});

	it("uses native MLflow spans as the preferred bundle source", async () => {
		vi.mocked(getMlflowNativeTrace).mockResolvedValue({
			trace: {
				trace_info: { trace_id: "tr-primary123", state: "OK" },
				spans: [
					{
						name: "workflow.finalize",
						span_id: "root",
						start_time_unix_nano: 1_000_000,
						end_time_unix_nano: 11_000_000,
						status: { code: "STATUS_CODE_OK" },
						attributes: [
							{ key: "gen_ai.operation.name", value: { string_value: "workflow" } },
							{ key: "workflow.status", value: { string_value: "OK" } },
						],
					},
					{
						name: "workflow.node.solve",
						span_id: "node",
						start_time_unix_nano: 12_000_000,
						end_time_unix_nano: 18_000_000,
						status: { code: "STATUS_CODE_OK" },
						attributes: [
							{ key: "gen_ai.operation.name", value: { string_value: "workflow.node" } },
						],
					},
					{
						name: "agent.call_llm",
						span_id: "llm",
						start_time_unix_nano: 20_000_000,
						end_time_unix_nano: 40_000_000,
						status: { code: "STATUS_CODE_OK" },
						attributes: [
							{ key: "mlflow.spanType", value: { string_value: "CHAT_MODEL" } },
							{ key: "gen_ai.request.model", value: { string_value: "deepseek" } },
							{ key: "gen_ai.usage.input_tokens", value: { int_value: 11 } },
							{ key: "gen_ai.usage.output_tokens", value: { int_value: 7 } },
							{ key: "workflow.id", value: { string_value: "wf" } },
							{ key: "workflow.execution.id", value: { string_value: "exec-1" } },
							{ key: "workflow.node.id", value: { string_value: "solve" } },
							{ key: "workflow.node.name", value: { string_value: "Solve" } },
							{ key: "agent.id", value: { string_value: "agent-1" } },
							{ key: "agent.version", value: { string_value: "1" } },
							{ key: "agent.slug", value: { string_value: "agent" } },
							{ key: "agent.app_id", value: { string_value: "agent-runtime-agent" } },
						],
					},
					{
						name: "agent.run_tool",
						span_id: "tool",
						start_time_unix_nano: 41_000_000,
						end_time_unix_nano: 42_000_000,
						status: { code: "STATUS_CODE_OK" },
						attributes: [
							{ key: "mlflow.spanType", value: { string_value: "TOOL" } },
							{ key: "tool.name", value: { string_value: "bash_run" } },
							{ key: "input.value", value: { string_value: "{\"command\":\"pwd\"}" } },
						],
					},
				],
			},
		});

		const bundle = await buildSwebenchTraceBundleFromMlflowNative({
			runId: "run_1",
			runInstanceId: "ri_1",
			instanceId: "django__django-1",
			traceIds: ["primary123"],
			canonicalTraceId: "primary123",
			mlflowExperimentId: "6",
			mlflowRunId: "mlrun",
			artifactPath: "traces/django__django-1/trace-bundle.json",
		});

		expect(bundle.backend).toBe("mlflow_native");
		expect(bundle.requiredContext.rootPresent).toBe(true);
		expect(bundle.requiredContext.statusFinalized).toBe(true);
		expect(bundle.requiredContext.nodeSpansPresent).toBe(true);
		expect(bundle.requiredContext.llmToolSpansPresent).toBe(true);
		expect(bundle.requiredContext.agentIdentityComplete).toBe(true);
		expect(bundle.summary.traceSpanCount).toBe(4);
		expect(bundle.llmSpans[0].modelName).toBe("deepseek");
		expect(bundle.llmSpans[0].promptTokens).toBe(11);
		expect(bundle.toolSpans[0].toolName).toBe("bash_run");
		expect(getMultiTraceSpans).not.toHaveBeenCalled();
	});

	it("falls back to ClickHouse when native MLflow has no spans", async () => {
		vi.mocked(getMlflowNativeTrace).mockResolvedValue({ trace: { spans: [] } });
		vi.mocked(getMultiTraceLlmSpans).mockResolvedValue([]);
		vi.mocked(getMultiTraceToolSpans).mockResolvedValue([]);
		vi.mocked(getMultiTraceSpans).mockResolvedValue([baseSpan({ traceId: "abc123" })]);

		const bundle = await buildSwebenchTraceBundle({
			runId: "run_1",
			runInstanceId: "ri_1",
			instanceId: "django__django-1",
			traceIds: ["abc123"],
			canonicalTraceId: "abc123",
			mlflowExperimentId: "6",
			mlflowRunId: "mlrun",
			artifactPath: "traces/django__django-1/trace-bundle.json",
		});

		expect(bundle.backend).toBe("clickhouse_derived");
		expect(getMultiTraceSpans).toHaveBeenCalledWith(["abc123"]);
	});
});
