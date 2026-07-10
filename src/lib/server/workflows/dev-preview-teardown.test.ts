import { afterEach, describe, expect, it, vi } from 'vitest';
import { teardownDevPreview, type DevPreviewPersistence } from '$lib/server/workflows/dev-preview';

function fakePersistence(
	rows: Array<{ workspaceRef: string; service: string }>
): DevPreviewPersistence {
	return {
		upsertWorkflowWorkspaceSession: vi.fn(async (input) => ({
			workspaceRef: input.workspaceRef
		})),
		listWorkflowWorkspaceSessionsByExecutionId: vi.fn(
			async () =>
				rows.map((r) => ({
					workspaceRef: r.workspaceRef,
					workflowExecutionId: 'exec-1',
					sandboxState: {
						details: {
							kind: 'dev-preview',
							sandboxName: r.workspaceRef,
							service: r.service,
							// podIP/syncPort present → the capture step fetches once and
							// skips fast (stubbed non-gzip body), instead of retry-sleeping.
							podIP: '10.0.0.1',
							syncPort: 8001
						}
					}
				})) as never
		),
		markWorkflowWorkspaceSessionCleaned: vi.fn(async () => true),
		getExecutionById: vi.fn(async () => ({
			id: 'exec-1',
			userId: 'user-1',
			projectId: null
		})),
		persistSourceBundleArtifact: vi.fn(async () => ({
			id: 'art-1',
			fileId: 'file-1',
			bytes: 0
		}))
	};
}

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function stubSea() {
	const calls: Array<{ url: string; method: string }> = [];
	vi.stubEnv('SANDBOX_EXECUTION_API_URL', 'http://sea.test');
	vi.stubEnv('INTERNAL_API_TOKEN', 'tok');
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string | URL, init?: RequestInit) => {
			calls.push({ url: String(url), method: init?.method ?? 'GET' });
			return new Response(JSON.stringify({ ok: true, restored: [] }), { status: 200 });
		})
	);
	return calls;
}

describe('teardownDevPreview (B5 restore-all)', () => {
	it('tears down peers before the self-adopted BFF, then fires the orphan sweep', async () => {
		const calls = stubSea();
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const persistence = fakePersistence([
			{ workspaceRef: 'dev-exec-1-workflow-builder', service: 'workflow-builder' },
			{ workspaceRef: 'dev-exec-1-workflow-orchestrator', service: 'workflow-orchestrator' }
		]);

		const result = await teardownDevPreview({ executionId: 'exec-1' }, persistence);

		expect(result.ok).toBe(true);
		const deletes = calls.filter((c) => c.method === 'DELETE');
		expect(deletes.map((c) => c.url)).toEqual([
			'http://sea.test/internal/dev-preview/dev-exec-1-workflow-orchestrator',
			'http://sea.test/internal/dev-preview/dev-exec-1-workflow-builder'
		]);
		const sweeps = calls.filter(
			(c) => c.method === 'POST' && c.url.endsWith('/internal/dev-preview/restore-orphans')
		);
		expect(sweeps).toHaveLength(1);
		// The sweep fires AFTER the per-sandbox deletes.
		expect(calls.indexOf(sweeps[0])).toBeGreaterThan(calls.indexOf(deletes[1]));
		expect(persistence.markWorkflowWorkspaceSessionCleaned).toHaveBeenCalledTimes(2);
	});

	it('still sweeps when NO session rows exist (SEA-restart orphan case)', async () => {
		const calls = stubSea();
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const persistence = fakePersistence([]);

		// No rows → the capture step retry-sleeps before giving up; fake timers
		// flush those sleeps instead of waiting 16s of wall clock.
		vi.useFakeTimers();
		try {
			const pending = teardownDevPreview({ executionId: 'exec-1' }, persistence);
			await vi.runAllTimersAsync();
			const result = await pending;
			expect(result).toEqual({ ok: true, sandboxName: null });
		} finally {
			vi.useRealTimers();
		}
		expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
		expect(
			calls.filter((c) => c.url.endsWith('/internal/dev-preview/restore-orphans'))
		).toHaveLength(1);
	});

	it('a failing sweep never fails the teardown', async () => {
		vi.stubEnv('SANDBOX_EXECUTION_API_URL', 'http://sea.test');
		vi.stubEnv('INTERNAL_API_TOKEN', 'tok');
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string | URL) => {
				if (String(url).endsWith('/restore-orphans')) throw new Error('SEA down');
				return new Response('{}', { status: 200 });
			})
		);
		const persistence = fakePersistence([
			{ workspaceRef: 'dev-exec-1-workflow-builder', service: 'workflow-builder' }
		]);

		const result = await teardownDevPreview({ executionId: 'exec-1' }, persistence);
		expect(result.ok).toBe(true);
		expect(warn).toHaveBeenCalledWith('[dev-preview] restore-orphans sweep failed:', 'SEA down');
	});
});
