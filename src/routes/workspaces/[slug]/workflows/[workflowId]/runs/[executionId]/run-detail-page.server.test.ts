import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	workflowData: {
		getScopedWorkflowById: vi.fn(async () => ({ id: 'wf-1' })),
		getScopedExecutionById: vi.fn(async () => ({ id: 'exec-1', workflowId: 'wf-1' }))
	}
}));

vi.mock('$lib/server/application', () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData })
}));

import { load } from './+page.server';

function event(overrides: Record<string, unknown> = {}) {
	return {
		params: { slug: 'default', workflowId: 'wf-1', executionId: 'exec-1' },
		locals: { session: { userId: 'user-1', projectId: 'project-1' } },
		...overrides
	};
}

describe('workspace workflow run detail loader', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.getScopedWorkflowById.mockResolvedValue({ id: 'wf-1' });
		mocks.workflowData.getScopedExecutionById.mockResolvedValue({
			id: 'exec-1',
			workflowId: 'wf-1'
		});
	});

	it('keeps workflow and execution scope checks behind workflow-data', () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), '+page.server.ts'),
			'utf8'
		);

		expect(source).toContain('workflowData.getScopedWorkflowById');
		expect(source).toContain('workflowData.getScopedExecutionById');
		expect(source).not.toContain('$lib/server/db');
		expect(source).not.toContain('drizzle-orm');
	});

	it('loads a run only when both records are visible and related', async () => {
		await expect(load(event() as never)).resolves.toEqual({});
		expect(mocks.workflowData.getScopedWorkflowById).toHaveBeenCalledWith({
			workflowId: 'wf-1',
			userId: 'user-1',
			projectId: 'project-1'
		});
		expect(mocks.workflowData.getScopedExecutionById).toHaveBeenCalledWith({
			executionId: 'exec-1',
			userId: 'user-1',
			projectId: 'project-1'
		});
	});

	it('returns not found for a foreign or mismatched run', async () => {
		mocks.workflowData.getScopedExecutionById.mockResolvedValueOnce({
			id: 'exec-1',
			workflowId: 'wf-2'
		});

		await expect(load(event() as never)).rejects.toMatchObject({ status: 404 });
	});
});
