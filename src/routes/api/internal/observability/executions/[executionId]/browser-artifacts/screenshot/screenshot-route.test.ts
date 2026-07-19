import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	guardAnalystAccess: vi.fn(),
	getScreenshot: vi.fn()
}));

vi.mock('../../guard', () => ({ guardAnalystAccess: mocks.guardAnalystAccess }));
vi.mock('$lib/server/application', () => ({
	getApplicationAdapters: () => ({
		workflowBrowserArtifacts: { getScreenshot: mocks.getScreenshot }
	})
}));

import { GET } from './+server';

describe('internal workflow browser screenshot route', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.guardAnalystAccess.mockResolvedValue({
			ok: true,
			execution: {
				id: 'execution-1',
				userId: 'user-1',
				projectId: 'project-1'
			}
		});
		mocks.getScreenshot.mockResolvedValue({
			status: 'ok',
			body: {
				storageRef: 'screenshots/frame.png',
				contentType: 'image/png',
				payloadBase64: 'cGl4ZWxz',
				sizeBytes: 6
			}
		});
	});

	it('binds the requested screenshot to the guarded execution', async () => {
		const response = (await GET({
			params: { executionId: 'execution-1' },
			request: new Request('http://localhost'),
			url: new URL(
				'http://localhost/api/internal/observability/executions/execution-1/browser-artifacts/screenshot?storageRef=screenshots%2Fframe.png'
			)
		} as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			contentType: 'image/png',
			payloadBase64: 'cGl4ZWxz'
		});
		expect(mocks.getScreenshot).toHaveBeenCalledWith({
			executionId: 'execution-1',
			userId: 'user-1',
			projectId: 'project-1',
			storageRef: 'screenshots/frame.png',
			maxBytes: 5 * 1024 * 1024
		});
	});
});
