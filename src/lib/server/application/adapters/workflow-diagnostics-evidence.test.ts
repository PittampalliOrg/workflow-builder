import { describe, expect, it, vi } from 'vitest';
import type { WorkflowDiagnosticsExecution } from '$lib/server/application/ports';
import { collectWorkflowDiagnosticsEvidence } from './workflow-diagnostics-evidence';

const execution: WorkflowDiagnosticsExecution = {
	id: 'execution-1',
	userId: 'user-1',
	projectId: 'project-1',
	status: 'error',
	startedAt: new Date('2026-07-19T12:00:00.000Z'),
	completedAt: new Date('2026-07-19T12:01:00.000Z'),
	output: null,
	executionIr: null,
	primaryTraceId: 'a'.repeat(32),
	workflowSessionId: 'session-1'
};

function span(spanId: string) {
	return {
		traceId: 'a'.repeat(32),
		spanId,
		parentSpanId: null,
		operationName: 'agent.call',
		serviceName: 'agent-runtime',
		startTime: '2026-07-19T12:00:01.000Z',
		duration: 10,
		status: 'ok' as const,
		attributes: { api_key: 'secret-value', payload: 'x'.repeat(2_000) },
		resourceAttributes: {},
		attributesTruncated: true,
		depth: 0
	};
}

describe('collectWorkflowDiagnosticsEvidence', () => {
	it('redacts and bounds selected evidence while retaining truncation metadata', async () => {
		const evidence = await collectWorkflowDiagnosticsEvidence({
			execution,
			request: {
				categories: ['spans', 'logs'],
				serviceNames: [],
				limits: { spans: 1, logs: 1, llmSpans: 1, toolSpans: 1 }
			},
			resolveTraceIds: async () => ({ traceIds: ['a'.repeat(32)], warnings: [] }),
			queries: {
				spans: vi.fn(async () => [span('1'.repeat(16)), span('2'.repeat(16))]),
				logs: vi.fn(async () => [
					{
						timestamp: '2026-07-19T12:00:01.000Z',
						traceId: 'a'.repeat(32),
						spanId: '1'.repeat(16),
						serviceName: 'agent-runtime',
						severityText: 'info',
						body: `authorization: Bearer secret-value ${'x'.repeat(2_000)}`,
						resourceAttributes: {},
						logAttributes: {}
					}
				]),
				llmSpans: vi.fn(async () => []),
				toolSpans: vi.fn(async () => [])
			}
		});

		expect(evidence.traceSpans).toHaveLength(1);
		expect(evidence.truncated).toMatchObject({ spans: true, logs: true });
		expect(evidence.rowTruncated).toMatchObject({ spans: true, logs: false });
		expect(evidence.contentTruncated).toMatchObject({ spans: true, logs: true });
		expect(evidence.traceSpans[0]?.attributesTruncated).toBe(true);
		expect(evidence.warnings).toEqual(
			expect.arrayContaining([
				'Trace spans were limited to 1 row',
				'Trace spans content is truncated',
				'Trace logs content is truncated'
			])
		);
		expect(JSON.stringify(evidence)).not.toContain('secret-value');
	});

	it('propagates truncation already recorded by LLM and tool ingestion', async () => {
		const evidence = await collectWorkflowDiagnosticsEvidence({
			execution,
			request: {
				categories: ['llmSpans', 'toolSpans'],
				serviceNames: [],
				limits: { spans: 1, logs: 1, llmSpans: 2, toolSpans: 2 }
			},
			resolveTraceIds: async () => ({ traceIds: ['a'.repeat(32)], warnings: [] }),
			queries: {
				spans: vi.fn(async () => []),
				logs: vi.fn(async () => []),
				llmSpans: vi.fn(async () => [{
					timestamp: '2026-07-19T12:00:01.000Z',
					traceId: 'a'.repeat(32),
					spanId: '1'.repeat(16),
					parentSpanId: null,
					serviceName: 'agent-runtime',
					sessionId: 'session-1',
					workflowExecutionId: execution.id,
					agentRunId: null,
					statusCode: 'Ok',
					modelName: 'kimi/kimi-k3',
					provider: 'kimi',
					inputMessages: [],
					outputMessages: [],
					invocationParameters: {},
					finishReason: 'stop',
					promptTokens: 10,
					completionTokens: 2,
					totalTokens: 12,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					reasoningTokens: 1,
					inputMessagesTruncated: false,
					outputMessagesTruncated: true,
					invocationParametersTruncated: false
				}]),
				toolSpans: vi.fn(async () => [{
					timestamp: '2026-07-19T12:00:02.000Z',
					traceId: 'a'.repeat(32),
					spanId: '2'.repeat(16),
					parentSpanId: null,
					serviceName: 'agent-runtime',
					sessionId: 'session-1',
					workflowExecutionId: execution.id,
					agentRunId: null,
					statusCode: 'Ok',
					toolName: 'browser',
					toolArguments: {},
					toolResult: {},
					toolArgumentsTruncated: true,
					toolResultTruncated: false
				}])
			}
		});

		expect(evidence.rowTruncated).toMatchObject({ llmSpans: false, toolSpans: false });
		expect(evidence.contentTruncated).toMatchObject({ llmSpans: true, toolSpans: true });
		expect(evidence.truncated).toMatchObject({ llmSpans: true, toolSpans: true });
		expect(evidence.warnings).toEqual(
			expect.arrayContaining(['LLM spans content is truncated', 'Tool spans content is truncated'])
		);
	});
});
