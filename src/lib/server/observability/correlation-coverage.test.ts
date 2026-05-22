import { describe, expect, it } from 'vitest';
import type { ObservabilityTraceSpan } from '$lib/types/observability';
import { buildTraceCorrelationCoverage } from './correlation-coverage';

let spanCounter = 0;

function span(
	serviceName: string,
	attributes: Record<string, unknown> = {}
): ObservabilityTraceSpan {
	spanCounter += 1;
	return {
		traceId: 'trace-1',
		spanId: `${serviceName}-${spanCounter}`,
		parentSpanId: null,
		operationName: 'operation',
		serviceName,
		startTime: '2026-05-22T00:00:00.000Z',
		duration: 1,
		status: 'ok',
		statusCode: 'Ok',
		spanKind: 'Internal',
		attributes,
		depth: 0
	};
}

describe('trace correlation coverage', () => {
	it('summarizes semantic workflow and Dapr task coverage by service', () => {
		const coverage = buildTraceCorrelationCoverage([
			span('workflow-orchestrator', {
				'workflow.activity.correlation_id': 'exec-1:step-a:0',
				'workflow.node.id': 'step-a',
				'workflow.execution.id': 'exec-1',
				'durabletask.task.task_id': '1',
				'session.id': 'exec-1'
			}),
			span('workflow-orchestrator', {
				'durabletask.task.task_id': '2'
			}),
			span('function-router', {
				'workflow.execution.id': 'exec-1',
				'workflow.node.id': 'step-a'
			})
		]);

		expect(coverage).toEqual([
			{
				serviceName: 'workflow-orchestrator',
				spans: 2,
				activityCorrelationId: 1,
				workflowNodeId: 1,
				workflowExecutionId: 1,
				daprTaskId: 2,
				sessionId: 1
			},
			{
				serviceName: 'function-router',
				spans: 1,
				activityCorrelationId: 0,
				workflowNodeId: 1,
				workflowExecutionId: 1,
				daprTaskId: 0,
				sessionId: 0
			}
		]);
	});
});
