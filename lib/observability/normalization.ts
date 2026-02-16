import type {
	ObservabilitySpan,
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
			} satisfies ObservabilitySpan;
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

	return {
		trace: summary,
		spans: normalizeJaegerSpans(trace),
	};
}

export type JaegerTraceContext = TraceContext;
