import { describe, expect, it } from 'vitest';
import type { ObservabilityTraceSpan } from '$lib/types/observability';
import { buildServiceGraphFromSpans, isBenignControlPlaneError } from './service-graph';

function span(overrides: Partial<ObservabilityTraceSpan>): ObservabilityTraceSpan {
	return {
		traceId: 'trace-1',
		spanId: 'span-1',
		parentSpanId: null,
		operationName: 'GET /',
		serviceName: 'service-a',
		startTime: '2026-05-22T00:00:00.000Z',
		duration: 1,
		status: 'error',
		statusCode: 'Error',
		spanKind: 'Server',
		depth: 0,
		...overrides
	};
}

describe('service graph error classification', () => {
	it('does not mark known Dapr control-plane shutdown spans as workflow errors', () => {
		const spans = [
			span({
				spanId: 'sub-1',
				operationName: '/dapr.proto.runtime.v1.Dapr/SubscribeTopicEventsAlpha1',
				serviceName: 'agent-session-1234567890abcdef',
				statusMessage: 'context canceled'
			}),
			span({
				spanId: 'app-1',
				operationName: 'POST /execute',
				serviceName: 'function-router',
				statusMessage: 'HTTP 500'
			})
		];

		expect(isBenignControlPlaneError(spans[0])).toBe(true);
		expect(isBenignControlPlaneError(spans[1])).toBe(false);

		const graph = buildServiceGraphFromSpans(spans);
		const agent = graph.nodes.find((node) => node.id === 'agent-session');
		const router = graph.nodes.find((node) => node.id === 'function-router');

		expect(agent?.red.errors).toBe(0);
		expect(agent?.status).toBe('ok');
		expect(router?.red.errors).toBe(1);
		expect(router?.status).toBe('error');
	});
});
