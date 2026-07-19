import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	guardAnalystAccess: vi.fn(),
	getExecutionStatus: vi.fn()
}));

vi.mock('../guard', () => ({ guardAnalystAccess: mocks.guardAnalystAccess }));
vi.mock('$lib/server/application', () => ({
	getApplicationAdapters: () => ({
		workflowExecutionControl: { getExecutionStatus: mocks.getExecutionStatus }
	})
}));

import { GET } from './+server';

function event() {
	return {
		params: { executionId: 'execution-1' },
		request: new Request('http://localhost/api/internal/observability/executions/execution-1/overview')
	};
}

describe('internal observability execution overview', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.guardAnalystAccess.mockResolvedValue({
			ok: true,
			execution: {
				id: 'execution-1',
				workflowId: 'workflow-1',
				userId: 'user-1',
				projectId: 'project-1',
				status: 'error',
				primaryTraceId: 'trusted-trace-id',
				daprInstanceId: 'instance-1',
				startedAt: new Date('2026-07-19T12:00:00.000Z'),
				completedAt: new Date('2026-07-19T12:01:00.000Z')
			}
		});
		mocks.getExecutionStatus.mockResolvedValue({
			status: 'ok',
			body: {
				executionId: 'execution-1',
				workflowId: 'workflow-1',
				status: 'error',
				error: 'failed',
				summaryOutput: {
					message: `api_key=top-secret ${'x'.repeat(12_000)}`
				},
				traceIds: ['output-controlled-trace-id'],
				steps: [{ logId: 'log-1', stepName: 'render', status: 'error', error: 'boom' }],
				agentEvents: [{ id: 1, type: 'tool.failed', data: { secret: 'omit' } }],
				agentRuns: [],
				artifacts: [{ id: 'artifact-1', kind: 'screenshot', metadata: { secret: 'omit' } }],
				browserArtifacts: [
					{
						id: 'browser-1',
						manifestJson: {
							steps: [
								{
									id: 'step-1',
									url: 'https://user:password@example.test/path?token=secret#fragment'
								}
							]
						}
					}
				]
			}
		});
	});

	it('returns bounded metadata without step IO or event payloads', async () => {
		const response = (await GET(event() as never)) as Response;
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({
			execution: {
				executionId: 'execution-1',
				status: 'error',
				traceId: 'trusted-trace-id',
				traceIds: ['trusted-trace-id']
			},
			steps: [{ stepName: 'render', status: 'error', error: 'boom' }],
			recentEvents: [{ id: 1, type: 'tool.failed' }],
			artifacts: [{ id: 'artifact-1', kind: 'screenshot' }]
		});
		expect(JSON.stringify(body)).not.toContain('secret');
		expect(JSON.stringify(body)).not.toContain('output-controlled-trace-id');
		expect(body.execution.summaryOutputTruncated).toBe(true);
		expect(body.browserArtifacts[0].steps[0].url).toBe('https://example.test/path');
		expect(mocks.getExecutionStatus).toHaveBeenCalledWith({
			executionId: 'execution-1',
			userId: 'user-1',
			projectId: 'project-1',
			includeAgentEvents: true
		});
	});
});
