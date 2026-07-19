import { describe, expect, it } from 'vitest';
import type { ObservabilityLlmSpan, ObservabilityTraceSpan } from '$lib/types/observability';
import { buildRunDigest } from './run-digest';

const call = (over: Record<string, unknown>) => ({
	callId: 'c0',
	seq: 0,
	kind: 'agent',
	label: null,
	phase: null,
	status: 'done',
	sessionId: null,
	retries: 0,
	errorCode: null,
	...over
});

const span = (over: Partial<ObservabilityTraceSpan>): ObservabilityTraceSpan =>
	({
		traceId: 't1',
		spanId: Math.random().toString(16).slice(2, 10),
		parentSpanId: null,
		operationName: 'op',
		serviceName: 'dapr-agent-py',
		startTime: new Date(1000).toISOString(),
		duration: 1000,
		status: 'ok',
		depth: 0,
		attributes: {},
		...over
	}) as ObservabilityTraceSpan;

const llm = (over: Partial<ObservabilityLlmSpan>): ObservabilityLlmSpan =>
	({
		traceId: 't1',
		spanId: 'l1',
		parentSpanId: null,
		serviceName: 'dapr-agent-py',
		timestamp: new Date(1000).toISOString(),
		sessionId: '',
		workflowExecutionId: 'e1',
		agentRunId: null,
		statusCode: 'Ok',
		inputMessages: [],
		outputMessages: [],
		...over
	}) as unknown as ObservabilityLlmSpan;

const EXEC = {
	id: 'e1',
	status: 'success',
	startedAt: new Date(0),
	completedAt: new Date(100_000)
};

describe('buildRunDigest', () => {
	it('aggregates phases, totals, cache hit rate and budget', () => {
		const calls = [
			call({ callId: 'a', seq: 0, phase: 'P1', label: 'pro', sessionId: 's-a' }),
			call({ callId: 'b', seq: 1, phase: 'P1', label: 'con', sessionId: 's-b' }),
			call({ callId: 'j', seq: 2, phase: 'P2', label: 'judge', sessionId: 's-j' })
		];
		const spans = [
			span({ attributes: { 'session.id': 's-a' }, startTime: new Date(0).toISOString(), duration: 60_000 }),
			span({ attributes: { 'session.id': 's-b' }, startTime: new Date(0).toISOString(), duration: 40_000 }),
			span({ attributes: { 'session.id': 's-j' }, startTime: new Date(60_000).toISOString(), duration: 30_000 })
		];
		const llms = [
			llm({ sessionId: 's-a', promptTokens: 100, completionTokens: 50, cacheReadInputTokens: 900 }),
			llm({ sessionId: 's-j', spanId: 'l2', promptTokens: 200, completionTokens: 100 })
		];
		const digest = buildRunDigest({
			execution: { ...EXEC, budgetTotal: 10_000 },
			calls: calls as never,
			spans,
			llmSpans: llms
		});

		expect(digest.phases.map((p) => p.title)).toEqual(['P1', 'P2']);
		// P1 duration = max of the parallel calls, not the sum
		expect(digest.phases[0].durationMs).toBe(60_000);
		expect(digest.totals.sessions).toBe(3);
		expect(digest.totals.tokensIn).toBe(300);
		expect(digest.totals.cacheRead).toBe(900);
		expect(digest.totals.cacheHitRate).toBeCloseTo(900 / 1200);
		expect(digest.budget).toEqual({ total: 10_000, spentTokens: 300 + 150 });
		// critical path exists and explains a share of the 100s wall clock
		expect(digest.criticalPath).not.toBeNull();
		expect(digest.criticalPath!.pctOfWallClock).toBeGreaterThan(0);
		expect(digest.issues).toHaveLength(0);
	});

	it('collects journal + span issues with a failure chain on the first span error', () => {
		const calls = [
			call({ callId: 'a', seq: 0, phase: 'P', label: 'flaky', sessionId: 's-a', retries: 2 }),
			call({ callId: 'x', seq: 1, phase: 'P', label: 'boomer', sessionId: 's-x', status: 'error', errorCode: 'workflow_child_error' })
		];
		const root = span({ spanId: 'root', operationName: 'execute', serviceName: 'workflow-orchestrator' });
		const mid = span({ spanId: 'mid', parentSpanId: 'root', operationName: 'dispatch' });
		const leaf = span({
			spanId: 'leaf',
			parentSpanId: 'mid',
			operationName: 'llm_request',
			status: 'error',
			statusMessage: '429 rate limited',
			attributes: { 'session.id': 's-x' }
		});
		const digest = buildRunDigest({
			execution: { ...EXEC, status: 'error', output: { error: 'script failed' } },
			calls: calls as never,
			spans: [root, mid, leaf],
			llmSpans: []
		});

		const kinds = digest.issues.map((i) => i.kind);
		expect(kinds).toContain('run_error');
		expect(kinds).toContain('call_retries');
		expect(kinds).toContain('call_error');
		expect(kinds).toContain('span_error');

		const spanIssue = digest.issues.find((i) => i.kind === 'span_error')!;
		expect(spanIssue.callId).toBe('x'); // owner resolved via session.id
		expect(spanIssue.detail).toBe('429 rate limited');
		// chain reads root → leaf
		expect(spanIssue.chain?.map((c) => c.name)).toEqual(['execute', 'dispatch', 'llm_request']);
	});

	it('suppresses expected Kubernetes absence spans without hiding real HTTP failures', () => {
		const expectedAbsence = [
			span({
				spanId: 'warm-pool-delete',
				serviceName: 'workflow-builder',
				status: 'error',
				statusCode: 'Error',
				attributes: {
					'http.method': 'DELETE',
					'http.status_code': '404',
					'http.target':
						'/apis/extensions.agents.x-k8s.io/v1alpha1/namespaces/workflow-builder/sandboxwarmpools/agent-runtime-pool-coding'
				}
			}),
			span({
				spanId: 'template-delete',
				serviceName: 'workflow-builder',
				status: 'error',
				attributes: {
					'http.request.method': 'DELETE',
					'http.response.status_code': 404,
					'url.path':
						'/apis/extensions.agents.x-k8s.io/v1alpha1/namespaces/workflow-builder/sandboxtemplates/agent-runtime-pool-coding'
				}
			}),
			span({
				spanId: 'service-delete',
				serviceName: 'workflow-builder',
				status: 'error',
				attributes: {
					'http.method': 'DELETE',
					'http.status_code': '404',
					'http.url':
						'https://10.96.0.1/api/v1/namespaces/workflow-builder/services/agent-runtime-pool-coding-mcp'
				}
			}),
			span({
				spanId: 'warm-pool-probe',
				serviceName: 'workflow-builder',
				status: 'error',
				attributes: {
					'http.request.method': 'GET',
					'http.response.status_code': '404',
					'url.full':
						'https://10.96.0.1/apis/extensions.agents.x-k8s.io/v1alpha1/namespaces/workflow-builder/sandboxwarmpools/agent-runtime-pool-coding'
				}
			}),
			span({
				spanId: 'warm-pool-delete-repeat',
				serviceName: 'workflow-builder',
				status: 'error',
				attributes: {
					'http.method': 'DELETE',
					'http.status_code': '404',
					'http.target':
						'/apis/extensions.agents.x-k8s.io/v1alpha1/namespaces/workflow-builder/sandboxwarmpools/agent-runtime-pool-coding'
				}
			})
		];
		const unexpectedProducer = span({
			spanId: 'unexpected-producer',
			serviceName: 'workflow-orchestrator',
			status: 'error',
			statusCode: 'Error',
			attributes: {
				'http.method': 'DELETE',
				'http.status_code': '404',
				'http.target':
					'/apis/extensions.agents.x-k8s.io/v1alpha1/namespaces/workflow-builder/sandboxwarmpools/agent-runtime-pool-coding'
			}
		});
		const unexpectedMethod = span({
			spanId: 'unexpected-method',
			serviceName: 'workflow-builder',
			status: 'error',
			statusCode: 'Error',
			attributes: {
				'http.method': 'POST',
				'http.status_code': '404',
				'http.target':
					'/apis/extensions.agents.x-k8s.io/v1alpha1/namespaces/workflow-builder/sandboxwarmpools/agent-runtime-pool-coding'
			}
		});
		const unexpectedPath = span({
			spanId: 'unexpected-path',
			serviceName: 'workflow-builder',
			status: 'error',
			statusCode: 'Error',
			attributes: {
				'http.method': 'DELETE',
				'http.status_code': '404',
				'http.target': '/api/v1/namespaces/workflow-builder/services/workflow-builder'
			}
		});
		const actualFailure = span({
			spanId: 'actual-failure',
			status: 'error',
			statusCode: 'Error',
			statusMessage: 'forbidden',
			attributes: {
				'http.request.method': 'DELETE',
				'http.response.status_code': 403,
				'url.path':
					'/apis/extensions.agents.x-k8s.io/v1alpha1/namespaces/workflow-builder/sandboxwarmpools/agent-runtime-pool-coding'
			}
		});

		const digest = buildRunDigest({
			execution: EXEC,
			calls: [],
			spans: [
				...expectedAbsence,
				unexpectedProducer,
				unexpectedMethod,
				unexpectedPath,
				actualFailure
			],
			llmSpans: []
		});

		expect(
			digest.issues.filter((issue) => issue.kind === 'span_error').map((issue) => issue.spanId)
		).toEqual([
			'unexpected-producer',
			'unexpected-method',
			'unexpected-path',
			'actual-failure'
		]);
	});

	it('handles empty journal (SW runs) without throwing', () => {
		const digest = buildRunDigest({
			execution: EXEC,
			calls: [],
			spans: [span({})],
			llmSpans: [llm({ promptTokens: 10, completionTokens: 5 })]
		});
		expect(digest.phases).toEqual([]);
		expect(digest.totals.tokensIn).toBe(10);
		expect(digest.budget).toBeNull();
	});
});
