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
		expect(JSON.stringify(logs.body)).not.toContain('Bearer secret');
		expect(logs.body.logs).toEqual([
			expect.objectContaining({
				traceId: 'a'.repeat(32),
				bodyTruncated: false,
				bodyOriginalBytes: Buffer.byteLength('Bearer secret', 'utf8')
			})
		]);
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
});
