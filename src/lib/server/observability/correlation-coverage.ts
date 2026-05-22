import type { ObservabilityTraceSpan } from '$lib/types/observability';

export type TraceCorrelationCoverage = {
	serviceName: string;
	spans: number;
	activityCorrelationId: number;
	workflowNodeId: number;
	workflowExecutionId: number;
	daprTaskId: number;
	sessionId: number;
};

function hasAttr(span: ObservabilityTraceSpan, key: string): boolean {
	const value = span.attributes?.[key];
	return value != null && String(value).trim().length > 0;
}

export function buildTraceCorrelationCoverage(
	spans: ObservabilityTraceSpan[]
): TraceCorrelationCoverage[] {
	const byService = new Map<string, TraceCorrelationCoverage>();
	for (const span of spans) {
		const key = span.serviceName || 'unknown';
		let coverage = byService.get(key);
		if (!coverage) {
			coverage = {
				serviceName: key,
				spans: 0,
				activityCorrelationId: 0,
				workflowNodeId: 0,
				workflowExecutionId: 0,
				daprTaskId: 0,
				sessionId: 0
			};
			byService.set(key, coverage);
		}
		coverage.spans += 1;
		if (hasAttr(span, 'workflow.activity.correlation_id')) coverage.activityCorrelationId += 1;
		if (hasAttr(span, 'workflow.node.id')) coverage.workflowNodeId += 1;
		if (hasAttr(span, 'workflow.execution.id')) coverage.workflowExecutionId += 1;
		if (hasAttr(span, 'durabletask.task.task_id')) coverage.daprTaskId += 1;
		if (hasAttr(span, 'session.id')) coverage.sessionId += 1;
	}
	return [...byService.values()].sort((a, b) => {
		if (b.spans !== a.spans) return b.spans - a.spans;
		return a.serviceName.localeCompare(b.serviceName);
	});
}
