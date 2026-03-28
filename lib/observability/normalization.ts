import type {
	ObservabilityServiceRole,
	ObservabilitySpan,
	ObservabilitySpanCategory,
	ObservabilityTraceBreakdown,
	ObservabilityTraceRuntime,
	ObservabilityTraceDetails,
	ObservabilityTraceStatus,
	ObservabilityTraceSummary,
} from "@/lib/types/observability";
import type { JaegerSpan, JaegerTag, JaegerTrace } from "./jaeger-types";

type TraceContext = {
	workflowId: string | null;
	workflowName: string | null;
	executionId: string | null;
	daprInstanceId: string | null;
	phase: string | null;
	agentRunId?: string | null;
	agentWorkflowId?: string | null;
	correlationConfidence?: "execution" | "instance" | "workflow" | "unknown";
};

function getTagValue(tags: JaegerTag[] | undefined, key: string): unknown {
	return tags?.find((tag) => tag.key === key)?.value;
}

function getStringTag(
	tags: JaegerTag[] | undefined,
	keys: string[],
): string | null {
	for (const key of keys) {
		const value = getTagValue(tags, key);
		if (typeof value === "string" && value.trim()) {
			return value;
		}
	}
	return null;
}

function getFirstStringTagAcrossSpans(
	spans: JaegerSpan[],
	keys: string[],
): string | null {
	for (const span of spans) {
		const value = getStringTag(span.tags, keys);
		if (value) {
			return value;
		}
	}
	return null;
}

function getStatusFromTags(
	tags: JaegerTag[] | undefined,
): ObservabilityTraceStatus {
	const statusCode = getStringTag(tags, ["otel.status_code", "status.code"]);
	if (statusCode?.toUpperCase() === "ERROR") {
		return "error";
	}

	const errorFlag = getTagValue(tags, "error");
	if (errorFlag === true || errorFlag === "true") {
		return "error";
	}

	if (statusCode) {
		return "ok";
	}

	return "unknown";
}

function hasAttributePrefix(
	attributes: Record<string, unknown>,
	prefix: string,
): boolean {
	return Object.keys(attributes).some((key) => key.startsWith(prefix));
}

function hasStringAttribute(
	attributes: Record<string, unknown>,
	keys: string[],
): boolean {
	return keys.some((key) => {
		const value = attributes[key];
		return typeof value === "string" && value.trim().length > 0;
	});
}

function classifyServiceRole(
	serviceName: string | null,
): ObservabilityServiceRole {
	const normalized = (serviceName ?? "").trim().toLowerCase();
	if (!normalized) {
		return "unknown";
	}
	if (normalized === "workflow-orchestrator") {
		return "orchestrator";
	}
	if (
		normalized === "dapr-agent-runtime" ||
		normalized === "ms-agent-workflow" ||
		normalized === "durable-agent"
	) {
		return "agent-runtime";
	}
	if (normalized === "workflow-builder") {
		return "builder-ui";
	}
	if (normalized === "function-router") {
		return "function-router";
	}
	if (normalized === "fn-system" || normalized.startsWith("fn-")) {
		return "system-function";
	}
	return "service";
}

function classifySpanCategory(args: {
	name: string;
	serviceRole: ObservabilityServiceRole;
	attributes: Record<string, unknown>;
	kind: string | null;
}): ObservabilitySpanCategory {
	const name = args.name.trim().toLowerCase();
	const attrs = args.attributes;
	const serviceRole = args.serviceRole;
	const kind = (args.kind ?? "").trim().toLowerCase();

	const hasWorkflowInstance = hasStringAttribute(attrs, [
		"workflow.instance_id",
		"workflow.instanceId",
		"dapr.instance_id",
		"daprInstanceId",
	]);
	const hasAgentWorkflow = hasStringAttribute(attrs, [
		"agent.workflow_id",
		"agent.workflowId",
		"workflow.agent_workflow_id",
		"workflow.agentWorkflowId",
	]);
	const hasToolName = hasStringAttribute(attrs, [
		"tool.name",
		"toolName",
		"agent.tool_name",
		"agent.toolName",
	]);
	const hasHttpMethod = hasStringAttribute(attrs, [
		"http.method",
		"http.request.method",
	]);

	if (
		name.startsWith("activity.") ||
		hasStringAttribute(attrs, [
			"workflow.activity_name",
			"workflow.activityName",
			"activity.name",
			"activity.type",
			"action.type",
		])
	) {
		return "activity";
	}

	if (
		name.includes("child workflow") ||
		name.includes("call_child_workflow") ||
		name.includes("call child workflow") ||
		hasStringAttribute(attrs, [
			"workflow.child_workflow_name",
			"workflow.childWorkflowName",
			"child.workflow.name",
		])
	) {
		return "child-workflow";
	}

	if (
		name.includes("call_llm") ||
		name.includes("model") ||
		name.includes("chat.completions") ||
		hasAttributePrefix(attrs, "gen_ai.") ||
		hasAttributePrefix(attrs, "llm.")
	) {
		return "llm";
	}

	if (name.includes("tool") || hasToolName) {
		return "tool";
	}

	if (
		serviceRole === "agent-runtime" ||
		hasAgentWorkflow ||
		name.includes("agent_workflow") ||
		name.includes("dapr-coding-agent") ||
		name.includes("repo-review") ||
		name.includes("planner") ||
		name.includes("reviewer")
	) {
		return "agent";
	}

	if (
		hasWorkflowInstance ||
		name.includes("dynamic_workflow") ||
		name.includes("workflow.") ||
		name === "workflow" ||
		name.includes("workflowrun") ||
		name.includes("workflow run")
	) {
		return "workflow";
	}

	if (hasHttpMethod || kind === "server" || kind === "client") {
		return "http";
	}

	if (serviceRole === "orchestrator" || serviceRole === "builder-ui") {
		return "runtime";
	}

	return "unknown";
}

function runtimeFromBreakdown(
	breakdown: ObservabilityTraceBreakdown,
	rootSpanCategory: ObservabilitySpanCategory,
): ObservabilityTraceRuntime {
	if (
		rootSpanCategory === "workflow" ||
		rootSpanCategory === "child-workflow" ||
		breakdown.workflowSpans > 0 ||
		breakdown.activitySpans > 0 ||
		breakdown.childWorkflowSpans > 0
	) {
		return "dapr-workflow";
	}

	if (
		rootSpanCategory === "agent" ||
		breakdown.agentSpans > 0 ||
		breakdown.toolSpans > 0 ||
		breakdown.llmSpans > 0
	) {
		return "dapr-agent";
	}

	if (breakdown.httpSpans > 0) {
		return "app-trace";
	}

	return "unknown";
}

function microsToIso(value: number | undefined): string {
	if (!value || Number.isNaN(value)) {
		return new Date(0).toISOString();
	}
	return new Date(Math.trunc(value / 1000)).toISOString();
}

function microsDurationToMs(value: number | undefined): number {
	if (!value || Number.isNaN(value)) {
		return 0;
	}
	return Math.max(0, Math.round(value / 1000));
}

function getSpanId(span: JaegerSpan): string {
	return span.spanID ?? span.spanId ?? "";
}

function getTraceId(trace: JaegerTrace, spans: JaegerSpan[]): string {
	return (
		trace.traceID ??
		trace.traceId ??
		spans[0]?.traceID ??
		spans[0]?.traceId ??
		""
	);
}

function pickRootSpan(spans: JaegerSpan[]): JaegerSpan | null {
	if (spans.length === 0) {
		return null;
	}

	const byId = new Map<string, JaegerSpan>();
	for (const span of spans) {
		const spanId = getSpanId(span);
		if (spanId) {
			byId.set(spanId, span);
		}
	}

	const candidate = spans.find((span) => {
		const refs = span.references ?? [];
		const parentRef = refs.find((ref) => {
			const refType = ref.refType?.toUpperCase();
			return refType === "CHILD_OF" || refType === "FOLLOWS_FROM";
		});

		if (!parentRef) {
			return true;
		}

		const parentSpanId = parentRef.spanID ?? parentRef.spanId;
		return !parentSpanId || !byId.has(parentSpanId);
	});

	if (candidate) {
		return candidate;
	}

	return [...spans].sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0))[0];
}

function spanAttributes(
	tags: JaegerTag[] | undefined,
): Record<string, unknown> {
	const attrs: Record<string, unknown> = {};
	for (const tag of tags ?? []) {
		if (!tag.key) {
			continue;
		}
		attrs[tag.key] = tag.value;
	}
	return attrs;
}

function getServiceName(
	trace: JaegerTrace,
	span: JaegerSpan | null,
): string | null {
	if (!span) {
		return null;
	}

	const processId = span.processID ?? span.processId;
	if (!processId) {
		return null;
	}

	return trace.processes?.[processId]?.serviceName ?? null;
}

function spanParentId(span: JaegerSpan): string | null {
	const parent = span.references?.find((ref) => {
		const refType = ref.refType?.toUpperCase();
		return refType === "CHILD_OF" || refType === "FOLLOWS_FROM";
	});

	return (parent?.spanID ?? parent?.spanId ?? null) as string | null;
}

export function normalizeJaegerSpans(trace: JaegerTrace): ObservabilitySpan[] {
	const spans = Array.isArray(trace.spans) ? trace.spans : [];
	const traceId = getTraceId(trace, spans);

	return spans
		.map((span) => {
			const startedAt = microsToIso(span.startTime);
			const durationMs = microsDurationToMs(span.duration);
			const endedAt = new Date(
				new Date(startedAt).getTime() + durationMs,
			).toISOString();

			return {
				traceId,
				spanId: getSpanId(span),
				parentSpanId: spanParentId(span),
				name: span.operationName ?? "span",
				serviceName: getServiceName(trace, span),
				startedAt,
				endedAt,
				durationMs,
				statusCode: getStringTag(span.tags, [
					"otel.status_code",
					"status.code",
				]),
				kind: getStringTag(span.tags, ["span.kind"]),
				attributes: spanAttributes(span.tags),
				category: "unknown",
				serviceRole: "unknown",
			} satisfies ObservabilitySpan;
		})
		.map((span) => {
			const serviceRole = classifyServiceRole(span.serviceName);
			return {
				...span,
				serviceRole,
				category: classifySpanCategory({
					name: span.name,
					serviceRole,
					attributes: span.attributes,
					kind: span.kind,
				}),
			};
		})
		.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export function normalizeJaegerTraceSummary(
	trace: JaegerTrace,
	context: TraceContext,
): ObservabilityTraceSummary | null {
	const spans = Array.isArray(trace.spans) ? trace.spans : [];
	const traceId = getTraceId(trace, spans);

	if (!traceId || spans.length === 0) {
		return null;
	}

	const rootSpan = pickRootSpan(spans);
	const normalizedSpans = normalizeJaegerSpans(trace);
	const startedMicros = Math.min(
		...spans.map((span) => span.startTime ?? Number.MAX_SAFE_INTEGER),
	);
	const endedMicros = Math.max(
		...spans.map((span) => (span.startTime ?? 0) + (span.duration ?? 0)),
	);

	const startedAt = microsToIso(startedMicros);
	const endedAt = endedMicros > 0 ? microsToIso(endedMicros) : null;
	const durationMs = microsDurationToMs(
		endedMicros > startedMicros
			? endedMicros - startedMicros
			: rootSpan?.duration,
	);

	let status: ObservabilityTraceStatus = "unknown";
	for (const span of spans) {
		const spanStatus = getStatusFromTags(span.tags);
		if (spanStatus === "error") {
			status = "error";
			break;
		}
		if (spanStatus === "ok") {
			status = "ok";
		}
	}

	const nodeId = getFirstStringTagAcrossSpans(spans, [
		"workflow.node_id",
		"workflow.nodeId",
		"node.id",
		"node_id",
		"nodeId",
	]);
	const nodeName = getFirstStringTagAcrossSpans(spans, [
		"workflow.node_name",
		"workflow.nodeName",
		"node.name",
		"node_name",
		"nodeName",
	]);
	const activityName = getFirstStringTagAcrossSpans(spans, [
		"workflow.activity_name",
		"workflow.activityName",
		"workflow.activity",
		"activity.name",
		"activity.type",
		"action.type",
		"actionType",
	]);
	const agentRunId =
		getFirstStringTagAcrossSpans(spans, [
			"workflow.agent_run_id",
			"workflow.agentRunId",
		]) ??
		context.agentRunId ??
		null;
	const agentWorkflowId =
		getFirstStringTagAcrossSpans(spans, [
			"workflow.agent_workflow_id",
			"workflow.agentWorkflowId",
		]) ??
		context.agentWorkflowId ??
		null;
	const parentExecutionId = getFirstStringTagAcrossSpans(spans, [
		"workflow.parent_execution_id",
		"workflow.parentExecutionId",
		"parent_execution_id",
		"parentExecutionId",
	]);
	const serviceNames = Array.from(
		new Set(
			normalizedSpans
				.map((span) => span.serviceName)
				.filter((serviceName): serviceName is string => Boolean(serviceName)),
		),
	);
	const serviceRoles = Array.from(
		new Set(normalizedSpans.map((span) => span.serviceRole)),
	);
	const breakdown = normalizedSpans.reduce<ObservabilityTraceBreakdown>(
		(acc, span) => {
			switch (span.category) {
				case "workflow":
					acc.workflowSpans += 1;
					break;
				case "child-workflow":
					acc.childWorkflowSpans += 1;
					break;
				case "activity":
					acc.activitySpans += 1;
					break;
				case "agent":
					acc.agentSpans += 1;
					break;
				case "tool":
					acc.toolSpans += 1;
					break;
				case "llm":
					acc.llmSpans += 1;
					break;
				case "http":
					acc.httpSpans += 1;
					break;
				default:
					acc.otherSpans += 1;
					break;
			}
			return acc;
		},
		{
			workflowSpans: 0,
			childWorkflowSpans: 0,
			activitySpans: 0,
			agentSpans: 0,
			toolSpans: 0,
			llmSpans: 0,
			httpSpans: 0,
			otherSpans: 0,
		},
	);
	const rootSpanId = rootSpan ? getSpanId(rootSpan) : null;
	const rootSpanCategory =
		normalizedSpans.find((span) => span.spanId === rootSpanId)?.category ??
		"unknown";

	return {
		traceId,
		name: rootSpan?.operationName ?? "trace",
		startedAt,
		endedAt,
		durationMs,
		spanCount: spans.length,
		serviceName: getServiceName(trace, rootSpan),
		status,
		workflowId: context.workflowId,
		workflowName: context.workflowName,
		executionId: context.executionId,
		daprInstanceId: context.daprInstanceId,
		phase: context.phase,
		nodeId,
		nodeName,
		activityName,
		agentRunId,
		agentWorkflowId,
		parentExecutionId,
		correlationConfidence: context.correlationConfidence ?? "unknown",
		runtime: runtimeFromBreakdown(breakdown, rootSpanCategory),
		rootSpanCategory,
		serviceNames,
		serviceRoles,
		breakdown,
	};
}

export function normalizeJaegerTraceDetails(
	trace: JaegerTrace,
	context: TraceContext,
): ObservabilityTraceDetails | null {
	const summary = normalizeJaegerTraceSummary(trace, context);
	if (!summary) {
		return null;
	}
	const normalizedSpans = normalizeJaegerSpans(trace);

	return {
		trace: summary,
		spans: normalizedSpans,
	};
}

export type JaegerTraceContext = TraceContext;
