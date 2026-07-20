import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
	const execution = {
		id: 'execution-1',
		userId: 'user-1',
		projectId: 'project-1',
		status: 'error',
		startedAt: new Date('2026-07-19T12:00:00.000Z'),
		completedAt: new Date('2026-07-19T12:01:00.000Z')
	};
	const evidence = {
		traceIds: ['a'.repeat(32)],
		traceSpans: [{ traceId: 'a'.repeat(32), spanId: '1'.repeat(16) }],
		logs: [],
		llmSpans: [],
		toolSpans: [],
		truncated: { spans: true, logs: false, llmSpans: false, toolSpans: false },
		rowTruncated: { spans: true, logs: false, llmSpans: false, toolSpans: false },
		contentTruncated: { spans: true, logs: false, llmSpans: false, toolSpans: false },
		limits: { spans: 200, logs: 100, llmSpans: 20, toolSpans: 50 },
		degradedSources: [],
		warnings: ['Trace spans were limited to 200 rows']
	};
	const getContext = vi.fn(async () => ({ execution }));
	const getInvestigationEvidence = vi.fn(async () => evidence);
	const workflowReader = { getWorkflowSteps: vi.fn() };
	const getApplicationAdapters = vi.fn(() => ({
		workflowData: { getObservabilityServiceGraphContext: getContext },
		workflowDiagnostics: { getInvestigationEvidence },
		observabilityInvestigationWorkflowReader: workflowReader
	}));
	const buildInvestigation = vi.fn(async () => ({
		summary: { totalTokens: 42 },
		traceSpans: evidence.traceSpans,
		logs: [],
		llmSpans: [],
		toolSpans: [],
		agentDecisionSummary: null,
		agentDecisions: [],
		agentDecisionDiagram: null,
		workflowSteps: [],
		workflowTimeline: [],
		events: [],
		issues: []
	}));
	return {
		execution,
		evidence,
		getContext,
		getInvestigationEvidence,
		workflowReader,
		getApplicationAdapters,
		buildInvestigation
	};
});

vi.mock('$lib/server/application', () => ({
	getApplicationAdapters: mocks.getApplicationAdapters
}));
vi.mock('$lib/server/observability/investigation', () => ({
	buildExecutionInvestigationFromEvidence: mocks.buildInvestigation
}));

import { GET } from './+server';

function event(session: { userId: string; projectId: string | null } | null = {
	userId: 'user-1',
	projectId: 'project-1'
}) {
	return {
		params: { executionId: 'execution-1' },
		locals: { session }
	};
}

describe('execution investigation route', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getContext.mockResolvedValue({ execution: mocks.execution });
		mocks.getInvestigationEvidence.mockResolvedValue(mocks.evidence);
	});

	it('requires authentication before composing application adapters', async () => {
		await expect(GET(event(null) as never)).rejects.toMatchObject({ status: 401 });
		expect(mocks.getApplicationAdapters).not.toHaveBeenCalled();
	});

	it('denies executions outside the caller workspace', async () => {
		mocks.getContext.mockResolvedValueOnce(null as never);
		await expect(GET(event() as never)).rejects.toMatchObject({ status: 404 });
		expect(mocks.getInvestigationEvidence).not.toHaveBeenCalled();
	});

	it('returns bounded broker evidence, coverage, and preserved token metrics', async () => {
		const response = (await GET(event() as never)) as Response;
		const body = await response.json();

		expect(mocks.getContext).toHaveBeenCalledExactlyOnceWith({
			userId: 'user-1',
			projectId: 'project-1',
			executionId: 'execution-1'
		});
		expect(mocks.getInvestigationEvidence).toHaveBeenCalledWith({
			execution: mocks.execution,
			request: { limits: { spans: 200, logs: 100, llmSpans: 20, toolSpans: 50 } }
		});
		expect(mocks.buildInvestigation).toHaveBeenCalledWith(
			'execution-1',
			mocks.evidence,
			{ workflowReader: mocks.workflowReader }
		);
		expect(body.summary.totalTokens).toBe(42);
		expect(body.evidenceCoverage).toMatchObject({
			spans: {
				loaded: 1,
				rowTruncated: true,
				contentTruncated: true
			},
			warnings: ['Trace spans were limited to 200 rows']
		});
		expect(body.evidenceCoverage.spans.nextCursor).toEqual(expect.any(String));
		expect(response.headers.get('cache-control')).toBe('no-store');
	});

	it('maps diagnostics transport failures to a generic 502', async () => {
		mocks.getInvestigationEvidence.mockRejectedValueOnce(new Error('broker secret detail'));
		await expect(GET(event() as never)).rejects.toMatchObject({
			status: 502,
			body: { message: 'Failed to build investigation payload' }
		});
	});

	it('keeps persistence and telemetry adapters outside the transport', () => {
		const source = readFileSync(new URL('./+server.ts', import.meta.url), 'utf8');
		expect(source).not.toContain('$lib/server/otel');
		expect(source).not.toContain('$lib/server/db');
		expect(source).not.toContain('drizzle-orm');
	});
});
