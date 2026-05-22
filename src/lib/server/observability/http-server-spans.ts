import { SpanKind, trace } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';

const registryKey = '__workflow_builder_active_otel_spans__';
const globals = globalThis as typeof globalThis & {
	[registryKey]?: Map<string, Span>;
};
const activeSpans = (globals[registryKey] ??= new Map<string, Span>());

export const activeSpanRegistryProcessor: SpanProcessor = {
	onStart(span) {
		activeSpans.set(span.spanContext().spanId, span);
	},
	onEnd(span: ReadableSpan) {
		activeSpans.delete(span.spanContext().spanId);
	},
	forceFlush() {
		return Promise.resolve();
	},
	shutdown() {
		activeSpans.clear();
		return Promise.resolve();
	}
};

export function activeHttpServerSpan(): Span | undefined {
	let span = trace.getActiveSpan() as Span | undefined;
	const traceId = span?.spanContext().traceId;
	for (let depth = 0; span && depth < 16; depth += 1) {
		if (span.kind === SpanKind.SERVER) return span;
		const parentSpanId = span.parentSpanContext?.spanId;
		if (!parentSpanId) break;
		span = activeSpans.get(parentSpanId);
	}
	if (traceId) {
		for (const candidate of activeSpans.values()) {
			const spanContext = candidate.spanContext();
			if (candidate.kind === SpanKind.SERVER && spanContext.traceId === traceId) {
				return candidate;
			}
		}
	}
	return undefined;
}
