import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sandbox } from '$lib/types/sandbox';

const workflowData = vi.hoisted(() => ({
	listSandboxSessionOwners: vi.fn(),
}));

vi.mock('$lib/server/application', () => ({
	getApplicationAdapters: () => ({ workflowData }),
}));

import {
	attachSandboxSessions,
	resolveSandboxSessions,
} from '$lib/server/sandbox-sessions';

describe('sandbox session owner enrichment', () => {
	beforeEach(() => {
		workflowData.listSandboxSessionOwners.mockReset();
		workflowData.listSandboxSessionOwners.mockResolvedValue([
			{
				sandboxName: 'sandbox-1',
				id: 'session-1',
				title: 'Solve task',
				status: 'running',
				workspaceSlug: 'workspace-1',
			},
		]);
	});

	it('resolves sandbox owners through workflow-data', async () => {
		const owners = await resolveSandboxSessions(['sandbox-1']);

		expect(workflowData.listSandboxSessionOwners).toHaveBeenCalledWith({
			sandboxNames: ['sandbox-1'],
		});
		expect(owners.get('sandbox-1')).toEqual({
			id: 'session-1',
			title: 'Solve task',
			status: 'running',
			workspaceSlug: 'workspace-1',
		});
	});

	it('attaches owner sessions to sandbox rows', async () => {
		const sandboxes: Sandbox[] = [
			{ name: 'sandbox-1', type: 'openshell', phase: 'READY' },
			{ name: 'sandbox-2', type: 'agent-runtime', phase: 'READY' },
		];

		await expect(attachSandboxSessions(sandboxes)).resolves.toEqual([
			{
				name: 'sandbox-1',
				type: 'openshell',
				phase: 'READY',
				session: {
					id: 'session-1',
					title: 'Solve task',
					status: 'running',
					workspaceSlug: 'workspace-1',
				},
			},
			{
				name: 'sandbox-2',
				type: 'agent-runtime',
				phase: 'READY',
				session: null,
			},
		]);
	});

	it('does not call workflow-data for empty input', async () => {
		await expect(resolveSandboxSessions([])).resolves.toEqual(new Map());
		expect(workflowData.listSandboxSessionOwners).not.toHaveBeenCalled();
	});

	it('does not import DB or Drizzle modules', () => {
		const source = readFileSync(
			new URL('./sandbox-sessions.ts', import.meta.url),
			'utf8',
		);

		expect(source).toContain('workflowData.listSandboxSessionOwners');
		expect(source).not.toContain(['$lib', 'server', 'db'].join('/'));
		expect(source).not.toContain(['drizzle', 'orm'].join('-'));
	});
});
