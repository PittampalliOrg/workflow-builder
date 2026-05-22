import type { ObservabilityTraceSpan } from '$lib/types/observability';

export type DrilldownIoFallback = {
	input?: DrilldownIoFallbackValue;
	output?: DrilldownIoFallbackValue;
};

export type DrilldownIoFallbackValue = {
	sourceLabel: string;
	sourceRelation: 'descendant' | 'ancestor';
	value: unknown;
};

function hasAttr(span: ObservabilityTraceSpan, attr: 'input.value' | 'output.value'): boolean {
	const value = span.attributes?.[attr];
	if (value == null) return false;
	if (typeof value === 'string') return value.trim().length > 0;
	return true;
}

function labelFor(span: ObservabilityTraceSpan): string {
	return `${span.serviceName} ${span.operationName}`.trim();
}

function childrenByParent(spans: ObservabilityTraceSpan[]): Map<string, ObservabilityTraceSpan[]> {
	const childrenOf = new Map<string, ObservabilityTraceSpan[]>();
	for (const span of spans) {
		if (!span.parentSpanId) continue;
		const list = childrenOf.get(span.parentSpanId);
		if (list) list.push(span);
		else childrenOf.set(span.parentSpanId, [span]);
	}
	return childrenOf;
}

function fallbackFrom(
	span: ObservabilityTraceSpan,
	sourceRelation: DrilldownIoFallbackValue['sourceRelation'],
	attr: 'input.value' | 'output.value'
): DrilldownIoFallbackValue {
	return {
		sourceLabel: labelFor(span),
		sourceRelation,
		value: span.attributes?.[attr]
	};
}

/**
 * Resolve request/response content for metadata-only infrastructure spans.
 *
 * Dapr and framework auto-instrumentation often create useful causal spans that
 * do not carry bodies, while our app-owned wrapper spans nearby do. Prefer a
 * descendant when a high-level wrapper encloses the contentful call; otherwise
 * use the closest ancestor so selecting a native Dapr state/pubsub child still
 * shows the app-owned request/response payload.
 */
export function buildIoFallbackBySpanId(
	spans: ObservabilityTraceSpan[]
): Map<string, DrilldownIoFallback> {
	const out = new Map<string, DrilldownIoFallback>();
	const byId = new Map(spans.map((span) => [span.spanId, span]));
	const childrenOf = childrenByParent(spans);

	function resolveMissing(
		span: ObservabilityTraceSpan,
		attr: 'input.value' | 'output.value'
	): DrilldownIoFallbackValue | undefined {
		if (hasAttr(span, attr)) return undefined;
		const queue = [...(childrenOf.get(span.spanId) ?? [])];
		const seen = new Set<string>();
		while (queue.length) {
			const child = queue.shift()!;
			if (seen.has(child.spanId)) continue;
			seen.add(child.spanId);
			if (hasAttr(child, attr)) return fallbackFrom(child, 'descendant', attr);
			queue.push(...(childrenOf.get(child.spanId) ?? []));
		}

		let parent = span.parentSpanId ? byId.get(span.parentSpanId) : undefined;
		while (parent) {
			if (hasAttr(parent, attr)) return fallbackFrom(parent, 'ancestor', attr);
			parent = parent.parentSpanId ? byId.get(parent.parentSpanId) : undefined;
		}
	}

	for (const span of spans) {
		const input = resolveMissing(span, 'input.value');
		const output = resolveMissing(span, 'output.value');
		if (input || output) {
			out.set(span.spanId, { input, output });
		}
	}

	return out;
}
