import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	WorkflowDiagnosticsExecution,
	WorkflowDiagnosticsReadPort
} from '$lib/server/application/ports/workflow-diagnostics';
import { ApplicationWorkflowDiagnosticsQueryService } from '$lib/server/application/workflow-diagnostics';

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
	workflowSessionId: 'execution-1'
};

function digest() {
	return {
		executionId: execution.id,
		status: execution.status,
		startedAt: execution.startedAt?.toISOString() ?? null,
		completedAt: execution.completedAt?.toISOString() ?? null,
		wallClockMs: 60_000,
		totals: {
			calls: 1,
			sessions: 1,
			llmCalls: 1,
			tokensIn: 10,
			tokensOut: 5,
			cacheRead: 0,
			cacheCreation: 0,
			tokens: 15,
			costUsd: 0,
			cacheHitRate: 0
		},
		phases: [],
		criticalPath: null,
		budget: null,
		issues: [
			{
				kind: 'run_error',
				label: 'Run failed',
				detail: 'api_key=sk-secret',
				callId: null,
				spanId: null,
				traceId: null
			}
		]
	} as const;
}

function traceSpan(index = 1) {
	return {
		traceId: 'a'.repeat(32),
		spanId: String(index).padStart(16, '0'),
		parentSpanId: null,
		operationName: `operation-${index}`,
		serviceName: 'agent-runtime',
		startTime: `2026-07-19T12:00:0${index}.000Z`,
		duration: index * 10,
		status: 'error',
		statusCode: 'Error',
		statusMessage: 'password: hidden',
		spanKind: 'Internal',
		attributes: { 'session.id': 'session-1', authorization: 'Bearer secret' },
		resourceAttributes: {},
		depth: 0
	};
}

function port(): WorkflowDiagnosticsReadPort {
	return {
		isConfigured: vi.fn(() => true),
		loadDigest: vi.fn(async () => ({
			digest: digest() as never,
			traceIds: ['a'.repeat(32)],
			spans: [traceSpan() as never],
			llmTurnCount: 1,
			llmSpansTruncated: false,
			llmSpanLimit: 200,
			degradedSources: [],
			warnings: [],
			calls: [
				{
					callId: 'call-1',
					seq: 0,
					kind: 'agent',
					label: 'Analyze',
					phase: 'Analyze',
					status: 'error',
					sessionId: 'session-1',
					retries: 0,
					errorCode: null
				}
			]
		})),
		loadInvestigationEvidence: vi.fn(async (_execution, request) => ({
			traceIds: ['a'.repeat(32)],
			traceSpans: [traceSpan() as never],
			logs: [],
			llmSpans: [],
			toolSpans: [],
			truncated: {
				spans: false,
				logs: false,
				llmSpans: false,
				toolSpans: false
			},
			rowTruncated: {
				spans: false,
				logs: false,
				llmSpans: false,
				toolSpans: false
			},
			contentTruncated: {
				spans: false,
				logs: false,
				llmSpans: false,
				toolSpans: false
			},
			limits: request.limits,
			degradedSources: [],
			warnings: []
		})),
		resolveTraceIds: vi.fn(async () => ({ traceIds: ['a'.repeat(32)], warnings: [] })),
		searchSpans: vi.fn(async () => [traceSpan(1), traceSpan(2)] as never),
		getSpan: vi.fn(async () => traceSpan() as never),
		searchLlmSpans: vi.fn(async () => [
			{
				timestamp: '2026-07-19T12:00:01.000Z',
				traceId: 'a'.repeat(32),
				spanId: '1'.padStart(16, '0'),
				parentSpanId: null,
				serviceName: 'agent-runtime',
				sessionId: 'session-1',
				workflowExecutionId: execution.id,
				agentRunId: 'run-1',
				statusCode: 'Ok',
				modelName: 'kimi/kimi-k3',
				provider: 'kimi',
				inputMessages: [{ role: 'user', content: 'password: hidden' }],
				outputMessages: [{ role: 'assistant', content: 'ok' }],
				invocationParameters: { api_key: 'sk-secret' },
				finishReason: 'stop',
				promptTokens: 10,
				completionTokens: 2,
				totalTokens: 12,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				reasoningTokens: 1,
				inputMessagesTruncated: false,
				outputMessagesTruncated: false,
				invocationParametersTruncated: false
			}
		] as never),
		searchLogs: vi.fn(async () => [
			{
				timestamp: '2026-07-19T12:00:01.000Z',
				traceId: 'a'.repeat(32),
				spanId: '1'.padStart(16, '0'),
				serviceName: 'agent-runtime',
				severityText: 'error',
				body: 'Bearer secret',
				resourceAttributes: {},
				logAttributes: {}
			}
		] as never),
		loadSpanSummaries: vi.fn(async () => ({
			spans: [traceSpan(1), traceSpan(2)] as never[],
			truncated: false
		})),
		searchToolSpans: vi.fn(async () => [
			{
				timestamp: '2026-07-19T12:00:02.000Z',
				traceId: 'a'.repeat(32),
				spanId: '2'.padStart(16, '0'),
				parentSpanId: '1'.padStart(16, '0'),
				serviceName: 'pydantic-ai-agent-py',
				sessionId: 'session-1',
				workflowExecutionId: execution.id,
				agentRunId: null,
				toolName: 'run_command',
				toolArguments: { command: 'echo hi', token: 'api_key=sk-secret' },
				toolResult: 'hi',
				statusCode: 'Ok',
				toolArgumentsTruncated: false,
				toolResultTruncated: false
			}
		] as never)
	};
}

describe('ApplicationWorkflowDiagnosticsQueryService', () => {
	let reads: WorkflowDiagnosticsReadPort;
	let service: ApplicationWorkflowDiagnosticsQueryService;

	beforeEach(() => {
		reads = port();
		service = new ApplicationWorkflowDiagnosticsQueryService(reads);
	});

	it('keeps infrastructure imports in the driven adapter', () => {
		const source = readFileSync(
			resolve(process.cwd(), 'src/lib/server/application/workflow-diagnostics.ts'),
			'utf8'
		);
		expect(source).not.toContain('$lib/server/otel');
		expect(source).not.toContain('run-digest-loader');
		expect(source).not.toContain('$lib/server/application/adapters');
		expect(source).not.toContain('$lib/server/db');
		expect(source).not.toMatch(/\bfetch\s*\(/);
		const adapterSource = readFileSync(
			resolve(
				process.cwd(),
				'src/lib/server/application/adapters/workflow-diagnostics.ts'
			),
			'utf8'
		);
		expect(adapterSource).not.toContain('getApplicationAdapters');
		expect(adapterSource).not.toContain('run-digest-loader');
	});

	it('assembles and redacts the digest projection', async () => {
		const result = await service.getDigest({ execution });

		expect(result.body).toMatchObject({
			executionId: execution.id,
			evidence: {
				spanCount: 1,
				llmTurnCount: 1,
				sessions: ['session-1']
			},
			telemetry: { state: 'complete', isFinal: true }
		});
		expect(JSON.stringify(result.body)).not.toContain('sk-secret');
	});

	it('normalizes bounded investigation categories and service scope before the port', async () => {
		const result = await service.getInvestigationEvidence({
			execution,
			request: {
				categories: ['spans', 'logs', 'spans'],
				serviceNames: [' agent-runtime ', 'agent-runtime', ''],
				limits: { spans: 99_999, logs: 2, llmSpans: 0, toolSpans: 3.8 }
			}
		});

		expect(reads.loadInvestigationEvidence).toHaveBeenCalledWith(execution, {
			categories: ['spans', 'logs'],
			serviceNames: ['agent-runtime'],
			limits: { spans: 200, logs: 2, llmSpans: 1, toolSpans: 3 }
		});
		expect(result.traceSpans).toHaveLength(1);
	});

	it('degrades an investigation transport failure without exposing backend secrets', async () => {
		vi.mocked(reads.loadInvestigationEvidence).mockRejectedValue(
			new Error('authorization: Bearer transport-secret')
		);

		const result = await service.getInvestigationEvidence({ execution });

		expect(result).toMatchObject({
			traceIds: [],
			degradedSources: ['correlation'],
			limits: { spans: 200, logs: 200, llmSpans: 50, toolSpans: 200 }
		});
		expect(result.warnings[0]).toContain('[REDACTED]');
		expect(JSON.stringify(result)).not.toContain('transport-secret');
	});

	it('marks digest telemetry partial when LLM metadata is truncated', async () => {
		const projection = await reads.loadDigest(execution);
		vi.mocked(reads.loadDigest).mockResolvedValue({
			...projection,
			llmTurnCount: 200,
			llmSpansTruncated: true,
			llmSpanLimit: 200
		});

		const result = await service.getDigest({ execution });

		expect(result.body.telemetry).toMatchObject({
			state: 'partial',
			warnings: [expect.stringContaining('limited to 200 rows')]
		});
		expect(result.body.evidence).toMatchObject({
			truncated: { llmTurns: true },
			limits: { llmTurns: 200 }
		});
	});

	it('owns span pagination and lean response mapping', async () => {
		const result = await service.searchSpans({
			execution,
			query: 'operation',
			errorsOnly: true,
			limit: 1,
			offset: 4,
			encodeCursor: (offset) => `cursor-${offset}`
		});

		expect(reads.searchSpans).toHaveBeenCalledWith(execution, ['a'.repeat(32)], {
			query: 'operation',
			errorsOnly: true,
			limit: 2,
			offset: 4
		});
		expect(result.body).toMatchObject({
			spans: [{ spanId: '1'.padStart(16, '0'), name: 'operation-1' }],
			page: { limit: 1, truncated: true, nextCursor: 'cursor-5' }
		});
		expect(JSON.stringify(result.body)).not.toContain('hidden');
	});

	it('removes only expected Kubernetes absence spans from error triage', async () => {
		const cleanupProbe = {
			...traceSpan(1),
			serviceName: 'workflow-builder',
			operationName: 'DELETE',
			attributes: {
				'http.request.method': 'DELETE',
				'http.response.status_code': 404,
				'url.path':
					'/apis/extensions.agents.x-k8s.io/v1alpha1/namespaces/workflow-builder/sandboxtemplates/agent-runtime-pool-coding'
			}
		};
		const missingSessionSandbox = {
			...traceSpan(3),
			serviceName: 'workflow-builder',
			operationName: 'DELETE',
			attributes: {
				'http.method': 'DELETE',
				'http.status_code': 404,
				'http.url':
					'https://10.96.0.1/apis/agents.x-k8s.io/v1alpha1/namespaces/workflow-builder/sandboxes/agent-host-agent-session-b3859df99ea09c31123c'
			}
		};
		const actionable = {
			...traceSpan(2),
			statusMessage: 'MCP tool timed out'
		};
		vi.mocked(reads.searchSpans).mockResolvedValue([
			cleanupProbe,
			missingSessionSandbox,
			actionable
		] as never[]);

		const result = await service.searchSpans({
			execution,
			errorsOnly: true,
			limit: 20,
			offset: 0,
			encodeCursor: String
		});

		expect(result.body).toMatchObject({
			spans: [{ spanId: actionable.spanId, statusMessage: 'MCP tool timed out' }],
			page: { count: 1, truncated: false }
		});
	});

	it('keeps active-run trace reads partial and refreshable', async () => {
		const result = await service.searchSpans({
			execution: { ...execution, status: 'running', completedAt: null },
			errorsOnly: false,
			limit: 20,
			offset: 0,
			encodeCursor: String
		});

		expect(result.body.telemetry).toMatchObject({
			state: 'partial',
			isFinal: false,
			refreshAfterMs: 5_000,
			warnings: [expect.stringContaining('still be ingesting')]
		});
	});

	it('surfaces degraded secondary-trace correlation', async () => {
		vi.mocked(reads.resolveTraceIds).mockResolvedValue({
			traceIds: ['a'.repeat(32)],
			warnings: ['Execution attribute trace correlation unavailable: timeout']
		});

		const result = await service.searchLogs({
			execution,
			errorsOnly: false,
			limit: 20,
			offset: 0,
			encodeCursor: String
		});

		expect(result.body.telemetry).toMatchObject({
			state: 'partial',
			isFinal: false,
			refreshAfterMs: 5_000,
			warnings: [expect.stringContaining('correlation unavailable')]
		});
	});

	it('binds LLM evidence to the guarded workflow execution id', async () => {
		const result = await service.getLlmTurns({
			execution,
			sessionId: 'session-1',
			limit: 10,
			offset: 0,
			encodeCursor: String
		});

		expect(reads.searchLlmSpans).toHaveBeenCalledWith(execution, ['a'.repeat(32)], {
			workflowExecutionId: execution.id,
			spanId: undefined,
			sessionId: 'session-1',
			limit: 4,
			offset: 0
		});
		expect(result.body.page).toMatchObject({ limit: 3 });
		expect(JSON.stringify(result.body)).not.toContain('hidden');
		expect(JSON.stringify(result.body)).not.toContain('sk-secret');
	});

	it('returns redacted exact span and log evidence', async () => {
		const [span, logs] = await Promise.all([
			service.getSpan({ execution, spanId: '1'.padStart(16, '0') }),
			service.searchLogs({
				execution,
				errorsOnly: true,
				limit: 10,
				offset: 0,
				encodeCursor: String
			})
		]);

		expect(JSON.stringify(span.body)).not.toContain('hidden');
		expect(JSON.stringify(span.body)).not.toContain('Bearer secret');
		expect(span.body.span).toMatchObject({
			operationName: 'operation-1',
			serviceName: 'agent-runtime',
			duration: 10,
			status: 'error',
			attributesTruncated: false,
			truncated: false
		});
		expect(JSON.stringify(logs.body)).not.toContain('Bearer secret');
		expect(logs.body.logs).toEqual([
			expect.objectContaining({
				traceId: 'a'.repeat(32),
				bodyTruncated: false,
				bodyOriginalBytes: Buffer.byteLength('Bearer secret', 'utf8')
			})
		]);
	});

	it('preserves exact span truncation in both browser and MCP fields', async () => {
		vi.mocked(reads.getSpan).mockResolvedValue({
			...traceSpan(),
			attributes: { payload: 'x'.repeat(60_000) }
		} as never);

		const result = await service.getSpan({
			execution,
			spanId: '1'.padStart(16, '0')
		});

		expect(result.body.span).toMatchObject({
			operationName: 'operation-1',
			name: 'operation-1',
			attributesTruncated: true,
			truncated: true
		});
	});

	it('removes serialized screenshot pixels from exact span evidence', async () => {
		const pixels = 'iVBORw0KGgo-sensitive-pixels';
		vi.mocked(reads.getSpan).mockResolvedValue({
			...traceSpan(),
			attributes: {
				'session.id': 'session-1',
				'output.value': JSON.stringify({
					status: 200,
					body: {
						storageRef: 'screenshots/frame.png',
						contentType: 'image/png',
						payloadBase64: pixels
					}
				})
			}
		} as never);

		const result = await service.getSpan({
			execution,
			spanId: '1'.padStart(16, '0')
		});
		const serialized = JSON.stringify(result.body);

		expect(serialized).toContain('screenshots/frame.png');
		expect(serialized).toContain('image/png');
		expect(serialized).toContain('[REDACTED]');
		expect(serialized).not.toContain(pixels);
	});

	it('removes signed session credentials from JSON-encoded exact span attributes', async () => {
		const sessionToken = 'signed-workflow-session-token';
		const truncatedToken = 'truncated-workflow-session-token';
		const commaToken = 'part-one,part-two';
		const objectToken = 'nested-object-token';
		vi.mocked(reads.getSpan).mockResolvedValue({
			...traceSpan(),
			attributes: {
				'input.value': JSON.stringify({
					workflowMcpSessionToken: sessionToken,
					runtimeConfig: { model: 'kimi/kimi-k3', reasoningEffort: 'max' }
				}),
				'input.truncated': `{"workflowMcpSessionToken":"${truncatedToken}`,
				'input.comma': `{"workflowMcpSessionToken":"${commaToken}`,
				'input.object': `{"workflowMcpSessionToken":{"raw":"${objectToken}`
			}
		} as never);

		const result = await service.getSpan({
			execution,
			spanId: '1'.padStart(16, '0')
		});
		const body = result.body as {
			span: { attributes: Record<string, string> };
		};
		const input = JSON.parse(body.span.attributes['input.value']);

		expect(input).toEqual({
			workflowMcpSessionToken: '[REDACTED]',
			runtimeConfig: { model: 'kimi/kimi-k3', reasoningEffort: 'max' }
		});
		expect(body.span.attributes['input.truncated']).toBe('[REDACTED malformed JSON]');
		expect(body.span.attributes['input.comma']).toBe('[REDACTED malformed JSON]');
		expect(body.span.attributes['input.object']).toBe('[REDACTED malformed JSON]');
		expect(JSON.stringify(result.body)).not.toContain(sessionToken);
		expect(JSON.stringify(result.body)).not.toContain(truncatedToken);
		expect(JSON.stringify(result.body)).not.toContain(commaToken);
		expect(JSON.stringify(result.body)).not.toContain(objectToken);
	});

	it('does not touch telemetry storage when ClickHouse is unavailable', async () => {
		vi.mocked(reads.isConfigured).mockReturnValue(false);

		const result = await service.searchSpans({
			execution,
			errorsOnly: false,
			limit: 20,
			offset: 0,
			encodeCursor: String
		});

		expect(result.body).toMatchObject({ telemetry: { state: 'unavailable' } });
		expect(reads.resolveTraceIds).not.toHaveBeenCalled();
		expect(reads.searchSpans).not.toHaveBeenCalled();
	});

	it('binds tool-call evidence to the guarded execution and redacts payloads', async () => {
		const result = await service.getToolCalls({
			execution,
			sessionId: 'session-1',
			toolName: 'run_command',
			errorsOnly: false,
			limit: 20,
			offset: 0,
			encodeCursor: String
		});

		expect(reads.searchToolSpans).toHaveBeenCalledWith(
			execution,
			['a'.repeat(32)],
			expect.objectContaining({
				workflowExecutionId: execution.id,
				sessionId: 'session-1',
				toolName: 'run_command'
			})
		);
		const body = result.body as {
			toolCalls: Array<{ toolName: string; arguments: unknown }>;
		};
		expect(body.toolCalls).toHaveLength(1);
		expect(body.toolCalls[0]).toMatchObject({
			toolName: 'run_command',
			sessionId: 'session-1',
			status: 'Ok'
		});
		expect(JSON.stringify(body)).not.toContain('sk-secret');
	});

	it('projects a compact span tree with collapsed repetitive siblings and a node cap', async () => {
		const parent = {
			...traceSpan(1),
			spanId: 'p'.repeat(16),
			parentSpanId: null,
			status: 'ok' as const,
			statusCode: 'Unset',
			statusMessage: ''
		};
		const child = (index: number, name: string, status: 'ok' | 'error' = 'ok') => ({
			...traceSpan(1),
			spanId: String(index).padStart(16, 'c'),
			parentSpanId: parent.spanId,
			operationName: name,
			startTime: `2026-07-19T12:00:${String(10 + index).padStart(2, '0')}.000Z`,
			status,
			statusCode: status === 'error' ? 'Error' : 'Unset',
			statusMessage: status === 'error' ? 'boom' : ''
		});
		const spans = [
			parent,
			child(1, 'sveltekit.handle'),
			child(2, 'sveltekit.handle'),
			child(3, 'sveltekit.handle'),
			child(4, 'sveltekit.handle'),
			child(5, 'sveltekit.handle', 'error'),
			child(6, 'call_llm')
		];
		vi.mocked(reads.loadSpanSummaries).mockResolvedValue({
			spans: spans as never[],
			truncated: false
		});

		const result = await service.getSpanTree({ execution, maxNodes: 300 });
		const body = result.body as {
			nodes: Array<{
				spanId: string;
				depth: number;
				name: string;
				status: string;
				omittedChildren?: number;
			}>;
			renderedCount: number;
			omittedSiblings: number;
		};
		expect(body.nodes[0]).toMatchObject({ depth: 0, spanId: 'p'.repeat(16) });
		const children = body.nodes.filter((node) => node.depth === 1);
		const names = children.map((node) => node.name);
		// 3 healthy sveltekit.handle kept, 4th collapsed; the ERROR sibling always survives.
		expect(names.filter((name) => name === 'sveltekit.handle')).toHaveLength(4);
		expect(
			children.some((node) => node.name === 'sveltekit.handle' && node.status === 'error')
		).toBe(true);
		expect(names).toContain('call_llm');
		expect(body.nodes[0].omittedChildren).toBe(1);
		expect(body.omittedSiblings).toBe(1);
		expect(body.renderedCount).toBe(6);
	});

	it('caps the rendered span tree at maxNodes', async () => {
		const root = {
			...traceSpan(1),
			spanId: 'r'.repeat(16),
			parentSpanId: null,
			status: 'ok' as const,
			statusMessage: ''
		};
		const many = Array.from({ length: 60 }, (_, index) => ({
			...traceSpan(1),
			spanId: String(index).padStart(16, 'd'),
			parentSpanId: root.spanId,
			operationName: `op-${index}`,
			startTime: `2026-07-19T12:00:0${index % 10}.00${index % 10}Z`,
			status: 'ok' as const,
			statusMessage: ''
		}));
		vi.mocked(reads.loadSpanSummaries).mockResolvedValue({
			spans: [root, ...many] as never[],
			truncated: false
		});

		const result = await service.getSpanTree({ execution, maxNodes: 20 });
		const body = result.body as {
			renderedCount: number;
			truncated: { nodes: boolean };
		};
		expect(body.renderedCount).toBe(20);
		expect(body.truncated.nodes).toBe(true);
	});
});
