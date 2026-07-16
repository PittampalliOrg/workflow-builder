import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	teardownDevPreview,
	type DevPreviewPersistence,
} from '$lib/server/workflows/dev-preview';
import { DEV_PREVIEW_DELETE_ATTEMPT_TIMEOUT_MS } from '$lib/dev-preview-teardown-timing';

function fakePersistence(
	rows: Array<{
		workspaceRef: string;
		service: string;
		kind?: string;
		executionId?: string;
		sandboxName?: string;
	}>,
): DevPreviewPersistence {
	return {
		upsertWorkflowWorkspaceSession: vi.fn(async (input) => ({
			workspaceRef: input.workspaceRef,
		})),
		listWorkflowWorkspaceSessionsByExecutionId: vi.fn(
			async () =>
				rows.map((r) => ({
					workspaceRef: r.workspaceRef,
					workflowExecutionId: 'exec-1',
					sandboxState: {
						details: {
							kind: r.kind ?? 'dev-preview',
							executionId: r.executionId ?? 'exec-1',
							sandboxName: r.sandboxName ?? r.workspaceRef,
							service: r.service,
							// podIP/syncPort present -> the capture step fetches once and
							// skips fast (stubbed non-gzip body), instead of retry-sleeping.
							podIP: '10.0.0.1',
							syncPort: 8001,
						},
					},
				})) as never,
		),
		markWorkflowWorkspaceSessionCleaned: vi.fn(async () => true),
		getExecutionById: vi.fn(async () => ({
			id: 'exec-1',
			userId: 'user-1',
			projectId: null,
		})),
		persistSourceBundleArtifact: vi.fn(async () => ({
			id: 'art-1',
			fileId: 'file-1',
			bytes: 0,
		})),
	};
}

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function teardownRequestIdentity(target: string): {
	sandboxName: string;
	executionId: string | null;
	service: string | null;
} {
	const url = new URL(target);
	return {
		sandboxName: decodeURIComponent(url.pathname.split('/').at(-1) ?? ''),
		executionId: url.searchParams.get('executionId'),
		service: url.searchParams.get('service'),
	};
}

function stubSea() {
	const calls: Array<{ url: string; method: string }> = [];
	vi.stubEnv('SANDBOX_EXECUTION_API_URL', 'http://sea.test');
	vi.stubEnv('INTERNAL_API_TOKEN', 'tok');
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string | URL, init?: RequestInit) => {
			const target = String(url);
			calls.push({ url: target, method: init?.method ?? 'GET' });
			if (target.endsWith('/internal/dev-previews/teardown-intent')) {
				return Response.json({ accepted: true, executionId: 'exec-1' });
			}
			if (target.includes('/internal/dev-previews?')) {
				return Response.json({
					executionId: 'exec-1',
					complete: true,
					services: [],
				});
			}
			if (init?.method === 'DELETE') {
				const { sandboxName } = teardownRequestIdentity(target);
				const deferred = sandboxName.includes('workflow-builder');
				return Response.json(
					{
						sandboxName,
						accepted: true,
						deleted: !deferred,
						deferred,
					},
					{ status: deferred ? 202 : 200 },
				);
			}
			return Response.json({ restored: [], releasedLeases: [] });
		}),
	);
	return calls;
}

describe('teardownDevPreview (B5 restore-all)', () => {
	it('deletes independent ordinary services concurrently before final inventory proof', async () => {
		vi.stubEnv('SANDBOX_EXECUTION_API_URL', 'http://sea.test');
		vi.stubEnv('INTERNAL_API_TOKEN', 'tok');
		const services = [
			'mcp-gateway',
			'workflow-mcp-server',
			'workflow-orchestrator',
		];
		const live = new Map(
			services.map((service) => [
				service,
				`wfb-dev-preview-${service}-exec-1`,
			]),
		);
		const started: string[] = [];
		const release = new Map<string, () => void>();
		let inventoryReads = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string | URL, init?: RequestInit) => {
				const target = String(url);
				if (target.endsWith('/internal/dev-previews/teardown-intent')) {
					return Response.json({
						accepted: true,
						executionId: 'exec-1',
					});
				}
				if (target.includes('/internal/dev-previews?')) {
					inventoryReads += 1;
					return Response.json({
						executionId: 'exec-1',
						complete: true,
						services: [...live].map(([service, sandboxName]) => ({
							service,
							sandboxName,
						})),
					});
				}
				if (init?.method === 'DELETE') {
					const request = teardownRequestIdentity(target);
					const service = request.service;
					expect(service).not.toBeNull();
					started.push(service!);
					return new Promise<Response>((resolve) => {
						release.set(service!, () => {
							live.delete(service!);
							resolve(
								Response.json({
									sandboxName: request.sandboxName,
									accepted: true,
									deleted: true,
									deferred: false,
								}),
							);
						});
					});
				}
				return Response.json({ restored: [], releasedLeases: [] });
			}),
		);
		const persistence = fakePersistence(
			services.map((service) => ({
				workspaceRef: `wfb-dev-preview-${service}-exec-1`,
				service,
			})),
		);

		const pending = teardownDevPreview(
			{
				executionId: 'exec-1',
				sourceCheckpoint: { status: 'teardown-resume' },
			},
			persistence,
		);

		await vi.waitFor(() => expect(started).toHaveLength(services.length));
		expect([...started].sort()).toEqual([...services].sort());
		expect(inventoryReads).toBe(1);
		for (const service of services) release.get(service)!();

		await expect(pending).resolves.toMatchObject({
			ok: true,
			complete: true,
			pending: false,
		});
		expect(inventoryReads).toBe(2);
		expect(
			vi.mocked(persistence.markWorkflowWorkspaceSessionCleaned).mock.calls
				.map(([input]) => input.workspaceRef)
				.sort(),
		).toEqual(services.map((service) => `wfb-dev-preview-${service}-exec-1`).sort());
	});

	it('allows one SEA delete attempt to cover endpoint restore and CR removal waits', async () => {
		vi.stubEnv('SANDBOX_EXECUTION_API_URL', 'http://sea.test');
		const name = 'wfb-dev-preview-workflow-orchestrator-exec-1';
		const timeout = vi
			.spyOn(AbortSignal, 'timeout')
			.mockReturnValue(new AbortController().signal);
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string | URL, init?: RequestInit) => {
				if (init?.method === 'DELETE') {
					return Response.json({
						sandboxName: teardownRequestIdentity(String(url)).sandboxName,
						accepted: true,
						deleted: true,
						deferred: false,
					});
				}
				return Response.json({ restored: [], releasedLeases: [] });
			}),
		);
		const persistence = fakePersistence([
			{ workspaceRef: name, service: 'workflow-orchestrator' },
		]);

		await expect(
			teardownDevPreview(
				{
					executionId: 'exec-1',
					sandboxName: name,
					sourceCheckpoint: { status: 'teardown-resume' },
				},
				persistence,
			),
		).resolves.toMatchObject({ ok: true, complete: true, pending: false });
		expect(timeout).toHaveBeenCalledOnce();
		expect(timeout).toHaveBeenCalledWith(
			DEV_PREVIEW_DELETE_ATTEMPT_TIMEOUT_MS,
		);
	});

	it('ignores unrelated and malformed persistence rows when selecting delete targets', async () => {
		const calls = stubSea();
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const validName = 'wfb-dev-preview-workflow-orchestrator-exec-1';
		const persistence = fakePersistence([
			{ workspaceRef: validName, service: 'workflow-orchestrator' },
			{
				workspaceRef: 'unrelated-workspace',
				service: 'workflow-orchestrator',
				kind: 'interactive-session',
			},
			{
				workspaceRef: 'wfb-dev-preview-workflow-orchestrator-exec-2',
				service: 'workflow-orchestrator',
				executionId: 'exec-2',
			},
			{
				workspaceRef: 'malformed-preview-name',
				service: 'function-router',
			},
		]);

		await expect(
			teardownDevPreview({ executionId: 'exec-1' }, persistence),
		).resolves.toMatchObject({ ok: true, complete: true, pending: false });

		expect(
			calls
				.filter((call) => call.method === 'DELETE')
				.map((call) => call.url),
		).toEqual([
			`http://sea.test/internal/dev-preview/${validName}?executionId=exec-1&service=workflow-orchestrator`,
		]);
		expect(
			persistence.markWorkflowWorkspaceSessionCleaned,
		).toHaveBeenCalledOnce();
		expect(
			persistence.markWorkflowWorkspaceSessionCleaned,
		).toHaveBeenCalledWith({
			workspaceRef: validName,
		});
	});

	it('rejects an explicit sandbox unless an exact execution-owned row proves it', async () => {
		vi.stubEnv('SANDBOX_EXECUTION_API_URL', 'http://sea.test');
		const fetch = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
			Response.json({ restored: [], releasedLeases: [] }),
		);
		vi.stubGlobal('fetch', fetch);
		const persistence = fakePersistence([
			{
				workspaceRef: 'wfb-dev-preview-workflow-orchestrator-exec-1',
				service: 'workflow-orchestrator',
			},
		]);

		await expect(
			teardownDevPreview(
				{
					executionId: 'exec-1',
					sandboxName: 'wfb-dev-preview-workflow-builder-exec-1',
				},
				persistence,
			),
		).resolves.toEqual({
			ok: false,
			complete: false,
			pending: false,
			sandboxName: 'wfb-dev-preview-workflow-builder-exec-1',
		});
		expect(
			fetch.mock.calls.some(([, init]) => init?.method === 'DELETE'),
		).toBe(false);
		expect(
			persistence.markWorkflowWorkspaceSessionCleaned,
		).not.toHaveBeenCalled();
	});

	it('returns pending without polling or sweeping while response-path cleanup is deferred', async () => {
		const calls = stubSea();
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const persistence = fakePersistence([
			{
				workspaceRef: 'wfb-dev-preview-workflow-builder-exec-1',
				service: 'workflow-builder',
			},
			{
				workspaceRef: 'wfb-dev-preview-workflow-orchestrator-exec-1',
				service: 'workflow-orchestrator',
			},
		]);

		const result = await teardownDevPreview(
			{ executionId: 'exec-1' },
			persistence,
			undefined,
			{ rootToken: () => 'a'.repeat(64) },
		);

		expect(result).toMatchObject({
			ok: true,
			complete: false,
			pending: true,
			sandboxName: 'wfb-dev-preview-workflow-orchestrator-exec-1',
		});
		const deletes = calls.filter((c) => c.method === 'DELETE');
		expect(deletes.map((c) => c.url)).toEqual([
			'http://sea.test/internal/dev-preview/wfb-dev-preview-workflow-orchestrator-exec-1?executionId=exec-1&service=workflow-orchestrator',
			'http://sea.test/internal/dev-preview/wfb-dev-preview-workflow-builder-exec-1?executionId=exec-1&service=workflow-builder',
		]);
		const sweeps = calls.filter(
			(c) =>
				c.method === 'POST' &&
				c.url.endsWith('/internal/dev-preview/restore-orphans'),
		);
		expect(sweeps).toHaveLength(0);
		const inventories = calls.filter((c) =>
			c.url.includes('/internal/dev-previews?'),
		);
		expect(inventories).toHaveLength(2);
		const intent = calls.find((c) =>
			c.url.endsWith('/internal/dev-previews/teardown-intent'),
		);
		const capture = calls.find((c) => c.url.includes('/__export?'));
		expect(intent).toBeDefined();
		expect(capture).toBeDefined();
		expect(calls.indexOf(intent!)).toBeLessThan(calls.indexOf(capture!));
		expect(calls.indexOf(intent!)).toBeLessThan(
			calls.indexOf(inventories[0]!),
		);
		expect(
			persistence.markWorkflowWorkspaceSessionCleaned,
		).toHaveBeenCalledOnce();
		expect(
			persistence.markWorkflowWorkspaceSessionCleaned,
		).toHaveBeenCalledWith({
			workspaceRef: 'wfb-dev-preview-workflow-orchestrator-exec-1',
		});
	});

	it('marks a deferred row cleaned only when a later idempotent teardown proves completion', async () => {
		vi.stubEnv('SANDBOX_EXECUTION_API_URL', 'http://sea.test');
		vi.stubEnv('INTERNAL_API_TOKEN', 'tok');
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		let deleteCalls = 0;
		let sweepCalls = 0;
		let live = true;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string | URL, init?: RequestInit) => {
				const target = String(url);
				if (target.endsWith('/internal/dev-previews/teardown-intent')) {
					return Response.json({
						accepted: true,
						executionId: 'exec-1',
					});
				}
				if (target.includes('/internal/dev-previews?')) {
					return Response.json({
						executionId: 'exec-1',
						complete: true,
						services: live
							? [
									{
										service: 'workflow-builder',
										sandboxName:
											'wfb-dev-preview-workflow-builder-exec-1',
									},
								]
							: [],
					});
				}
				if (init?.method === 'DELETE') {
					deleteCalls += 1;
					if (deleteCalls > 1) live = false;
					return Response.json(
						{
							sandboxName:
								'wfb-dev-preview-workflow-builder-exec-1',
							accepted: true,
							deleted: deleteCalls > 1,
							deferred: deleteCalls === 1,
						},
						{ status: deleteCalls === 1 ? 202 : 200 },
					);
				}
				if (target.endsWith('/restore-orphans')) {
					sweepCalls += 1;
					return Response.json({ restored: [], releasedLeases: [] });
				}
				return Response.json({});
			}),
		);
		const persistence = fakePersistence([
			{
				workspaceRef: 'wfb-dev-preview-workflow-builder-exec-1',
				service: 'workflow-builder',
			},
		]);

		const first = await teardownDevPreview(
			{ executionId: 'exec-1' },
			persistence,
		);
		expect(first).toEqual({
			ok: true,
			complete: false,
			pending: true,
			sandboxName: 'wfb-dev-preview-workflow-builder-exec-1',
		});
		expect(
			persistence.markWorkflowWorkspaceSessionCleaned,
		).not.toHaveBeenCalled();
		expect(sweepCalls).toBe(0);

		const second = await teardownDevPreview(
			{ executionId: 'exec-1' },
			persistence,
		);
		expect(second).toEqual({
			ok: true,
			complete: true,
			pending: false,
			sandboxName: 'wfb-dev-preview-workflow-builder-exec-1',
		});
		expect(
			persistence.markWorkflowWorkspaceSessionCleaned,
		).toHaveBeenCalledOnce();
		expect(sweepCalls).toBe(1);
	});

	it('still sweeps when NO session rows exist (SEA-restart orphan case)', async () => {
		const calls = stubSea();
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const persistence = fakePersistence([]);

		// No rows -> the capture step retry-sleeps before giving up; fake timers
		// flush those sleeps instead of waiting 16s of wall clock.
		vi.useFakeTimers();
		try {
			const pending = teardownDevPreview(
				{ executionId: 'exec-1' },
				persistence,
			);
			await vi.runAllTimersAsync();
			const result = await pending;
			expect(result).toEqual({
				ok: true,
				complete: true,
				pending: false,
				sandboxName: null,
			});
		} finally {
			vi.useRealTimers();
		}
		expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
		expect(
			calls.filter((c) =>
				c.url.endsWith('/internal/dev-preview/restore-orphans'),
			),
		).toHaveLength(1);
	});

	it('does not report teardown complete when the restore-orphans proof fails', async () => {
		vi.stubEnv('SANDBOX_EXECUTION_API_URL', 'http://sea.test');
		vi.stubEnv('INTERNAL_API_TOKEN', 'tok');
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string | URL, init?: RequestInit) => {
				const target = String(url);
				if (target.endsWith('/internal/dev-previews/teardown-intent')) {
					return Response.json({
						accepted: true,
						executionId: 'exec-1',
					});
				}
				if (target.includes('/internal/dev-previews?')) {
					return Response.json({
						executionId: 'exec-1',
						complete: true,
						services: [
							{
								service: 'workflow-builder',
								sandboxName:
									'wfb-dev-preview-workflow-builder-exec-1',
							},
						],
					});
				}
				if (target.endsWith('/restore-orphans')) {
					return Response.json({ restored: [] });
				}
				if (init?.method === 'DELETE') {
					const { sandboxName } = teardownRequestIdentity(
						String(url),
					);
					return Response.json({
						sandboxName,
						accepted: true,
						deleted: true,
						deferred: false,
					});
				}
				return Response.json({});
			}),
		);
		const persistence = fakePersistence([
			{
				workspaceRef: 'wfb-dev-preview-workflow-builder-exec-1',
				service: 'workflow-builder',
			},
		]);

		const result = await teardownDevPreview(
			{ executionId: 'exec-1' },
			persistence,
		);
		expect(result).toMatchObject({
			ok: false,
			complete: false,
			pending: false,
		});
		expect(warn).toHaveBeenCalledWith(
			'[dev-preview] restore-orphans sweep failed:',
			'restore-orphans failed (HTTP 200)',
		);
	});

	it('fails closed and preserves the active row when deletion is not proven', async () => {
		vi.stubEnv('SANDBOX_EXECUTION_API_URL', 'http://sea.test');
		const persistence = fakePersistence([
			{
				workspaceRef: 'wfb-dev-preview-function-router-exec-1',
				service: 'function-router',
			},
		]);
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string | URL, init?: RequestInit) => {
				if (
					String(url).endsWith(
						'/internal/dev-previews/teardown-intent',
					)
				) {
					return Response.json({
						accepted: true,
						executionId: 'exec-1',
					});
				}
				if (String(url).includes('/internal/dev-previews?')) {
					return Response.json({
						executionId: 'exec-1',
						complete: true,
						services: [
							{
								service: 'function-router',
								sandboxName:
									'wfb-dev-preview-function-router-exec-1',
							},
						],
					});
				}
				if (init?.method === 'DELETE') {
					return Response.json(
						{ detail: 'ownership mismatch' },
						{ status: 409 },
					);
				}
				return Response.json({ restored: [], releasedLeases: [] });
			}),
		);

		const result = await teardownDevPreview(
			{ executionId: 'exec-1' },
			persistence,
		);

		expect(result.ok).toBe(false);
		expect(result.complete).toBe(false);
		expect(result.pending).toBe(false);
		expect(
			persistence.markWorkflowWorkspaceSessionCleaned,
		).not.toHaveBeenCalled();
	});

	it('deletes an inventory-only SEA member that has no persistence row', async () => {
		vi.stubEnv('SANDBOX_EXECUTION_API_URL', 'http://sea.test');
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		let live = true;
		const deletes: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string | URL, init?: RequestInit) => {
				const target = String(url);
				if (target.endsWith('/internal/dev-previews/teardown-intent')) {
					return Response.json({
						accepted: true,
						executionId: 'exec-1',
					});
				}
				if (target.includes('/internal/dev-previews?')) {
					return Response.json({
						executionId: 'exec-1',
						complete: true,
						services: live
							? [
									{
										service: 'workflow-orchestrator',
										sandboxName:
											'wfb-dev-preview-workflow-orchestrator-exec-1',
									},
								]
							: [],
					});
				}
				if (init?.method === 'DELETE') {
					const request = teardownRequestIdentity(target);
					const name = request.sandboxName;
					expect(request).toMatchObject({
						executionId: 'exec-1',
						service: 'workflow-orchestrator',
					});
					deletes.push(name);
					live = false;
					return Response.json({
						sandboxName: name,
						accepted: true,
						deleted: true,
						deferred: false,
					});
				}
				return Response.json({ restored: [], releasedLeases: [] });
			}),
		);
		const persistence = fakePersistence([]);
		vi.useFakeTimers();
		try {
			const pending = teardownDevPreview(
				{ executionId: 'exec-1' },
				persistence,
			);
			await vi.runAllTimersAsync();
			await expect(pending).resolves.toMatchObject({
				ok: true,
				complete: true,
			});
		} finally {
			vi.useRealTimers();
		}
		expect(deletes).toEqual([
			'wfb-dev-preview-workflow-orchestrator-exec-1',
		]);
		expect(
			persistence.markWorkflowWorkspaceSessionCleaned,
		).not.toHaveBeenCalled();
	});

	it('rejects a noncanonical SEA inventory member before deletion', async () => {
		vi.stubEnv('SANDBOX_EXECUTION_API_URL', 'http://sea.test');
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const fetch = vi.fn(async (url: string | URL, _init?: RequestInit) => {
			const target = String(url);
			if (target.endsWith('/internal/dev-previews/teardown-intent')) {
				return Response.json({ accepted: true, executionId: 'exec-1' });
			}
			return Response.json({
				executionId: 'exec-1',
				complete: true,
				services: [
					{
						service: 'workflow-orchestrator',
						sandboxName: 'other-execution-sandbox',
					},
				],
			});
		});
		vi.stubGlobal('fetch', fetch);
		const persistence = fakePersistence([]);

		vi.useFakeTimers();
		try {
			const pending = teardownDevPreview(
				{ executionId: 'exec-1' },
				persistence,
			);
			await vi.runAllTimersAsync();
			await expect(pending).resolves.toMatchObject({
				ok: false,
				complete: false,
				pending: false,
			});
		} finally {
			vi.useRealTimers();
		}
		expect(
			fetch.mock.calls.some(([, init]) => init?.method === 'DELETE'),
		).toBe(false);
	});

	it('fails closed before deletion when execution-wide SEA inventory is unavailable', async () => {
		vi.stubEnv('SANDBOX_EXECUTION_API_URL', 'http://sea.test');
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const fetch = vi.fn(async (url: string | URL, _init?: RequestInit) =>
			String(url).endsWith('/internal/dev-previews/teardown-intent')
				? Response.json({ accepted: true, executionId: 'exec-1' })
				: Response.json({ detail: 'down' }, { status: 503 }),
		);
		vi.stubGlobal('fetch', fetch);
		const persistence = fakePersistence([
			{
				workspaceRef: 'wfb-dev-preview-workflow-orchestrator-exec-1',
				service: 'workflow-orchestrator',
			},
		]);

		await expect(
			teardownDevPreview({ executionId: 'exec-1' }, persistence),
		).resolves.toMatchObject({
			ok: false,
			complete: false,
			pending: false,
		});
		expect(
			fetch.mock.calls.some(([, init]) => init?.method === 'DELETE'),
		).toBe(false);
		expect(
			persistence.markWorkflowWorkspaceSessionCleaned,
		).not.toHaveBeenCalled();
	});

	it('fails closed before inventory and deletion when teardown intent is rejected', async () => {
		vi.stubEnv('SANDBOX_EXECUTION_API_URL', 'http://sea.test');
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const fetch = vi.fn(async (url: string | URL, _init?: RequestInit) =>
			String(url).endsWith('/internal/dev-previews/teardown-intent')
				? Response.json(
						{ accepted: false, detail: 'intent rejected' },
						{ status: 409 },
					)
				: Response.json({ detail: 'unexpected' }, { status: 500 }),
		);
		vi.stubGlobal('fetch', fetch);
		const persistence = fakePersistence([
			{
				workspaceRef: 'wfb-dev-preview-workflow-orchestrator-exec-1',
				service: 'workflow-orchestrator',
			},
		]);

		await expect(
			teardownDevPreview({ executionId: 'exec-1' }, persistence),
		).resolves.toMatchObject({
			ok: false,
			complete: false,
			pending: false,
		});
		const seaCalls = fetch.mock.calls.filter(([url]) =>
			String(url).startsWith('http://sea.test/'),
		);
		expect(seaCalls).toHaveLength(1);
		expect(String(seaCalls[0]?.[0])).toContain('teardown-intent');
		expect(
			persistence.markWorkflowWorkspaceSessionCleaned,
		).not.toHaveBeenCalled();
	});

	it.each(['transport', 'body'] as const)(
		'replays the exact SEA DELETE after %s receipt loss',
		async (loss) => {
			vi.stubEnv('SANDBOX_EXECUTION_API_URL', 'http://sea.test');
			vi.stubEnv('INTERNAL_API_TOKEN', 'tok');
			const name = 'wfb-dev-preview-workflow-orchestrator-exec-1';
			const deleteCalls: Array<[string, RequestInit | undefined]> = [];
			let attempts = 0;
			vi.stubGlobal(
				'fetch',
				vi.fn(async (url: string | URL, init?: RequestInit) => {
					const target = String(url);
					if (target.includes('/__export?')) {
						return new Response('not-gzip');
					}
					if (init?.method === 'DELETE') {
						deleteCalls.push([target, init]);
						attempts += 1;
						if (attempts === 1) {
							if (loss === 'transport')
								throw new TypeError('connection reset');
							return new Response('truncated', { status: 200 });
						}
						return Response.json({
							sandboxName: name,
							accepted: true,
							deleted: true,
							deferred: false,
						});
					}
					return Response.json({ restored: [], releasedLeases: [] });
				}),
			);
			const persistence = fakePersistence([
				{ workspaceRef: name, service: 'workflow-orchestrator' },
			]);

			await expect(
				teardownDevPreview(
					{ executionId: 'exec-1', sandboxName: name },
					persistence,
				),
			).resolves.toMatchObject({
				ok: true,
				complete: true,
				pending: false,
			});
			expect(deleteCalls).toHaveLength(2);
			expect(deleteCalls[1]?.[0]).toBe(deleteCalls[0]?.[0]);
			expect(deleteCalls[1]?.[1]?.headers).toEqual(
				deleteCalls[0]?.[1]?.headers,
			);
			expect(
				persistence.markWorkflowWorkspaceSessionCleaned,
			).toHaveBeenCalledOnce();
		},
	);

	it.each([
		[200, { deleted: false, deferred: true }],
		[202, { deleted: true, deferred: false }],
	] as const)(
		'rejects a teardown disposition paired with HTTP %s',
		async (status, disposition) => {
			vi.stubEnv('SANDBOX_EXECUTION_API_URL', 'http://sea.test');
			const name = 'wfb-dev-preview-workflow-orchestrator-exec-1';
			let deleteCalls = 0;
			vi.stubGlobal(
				'fetch',
				vi.fn(async (url: string | URL, init?: RequestInit) => {
					if (String(url).includes('/__export?')) {
						return new Response('not-gzip');
					}
					if (init?.method === 'DELETE') {
						deleteCalls += 1;
						return Response.json(
							{
								sandboxName: name,
								accepted: true,
								...disposition,
							},
							{ status },
						);
					}
					return Response.json({ restored: [], releasedLeases: [] });
				}),
			);
			const persistence = fakePersistence([
				{ workspaceRef: name, service: 'workflow-orchestrator' },
			]);

			await expect(
				teardownDevPreview(
					{ executionId: 'exec-1', sandboxName: name },
					persistence,
				),
			).resolves.toMatchObject({
				ok: false,
				complete: false,
				pending: false,
			});
			expect(deleteCalls).toBe(3);
			expect(
				persistence.markWorkflowWorkspaceSessionCleaned,
			).not.toHaveBeenCalled();
		},
	);

	it('does not replay an explicit terminal SEA teardown receipt', async () => {
		vi.stubEnv('SANDBOX_EXECUTION_API_URL', 'http://sea.test');
		const name = 'wfb-dev-preview-workflow-orchestrator-exec-1';
		let deleteCalls = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string | URL, init?: RequestInit) => {
				if (String(url).includes('/__export?'))
					return new Response('not-gzip');
				if (init?.method === 'DELETE') {
					deleteCalls += 1;
					return Response.json(
						{
							accepted: false,
							sandboxName: name,
							detail: 'restore rejected',
						},
						{ status: 409 },
					);
				}
				return Response.json({ restored: [], releasedLeases: [] });
			}),
		);
		const persistence = fakePersistence([
			{ workspaceRef: name, service: 'workflow-orchestrator' },
		]);

		await expect(
			teardownDevPreview(
				{ executionId: 'exec-1', sandboxName: name },
				persistence,
			),
		).resolves.toMatchObject({
			ok: false,
			complete: false,
			pending: false,
		});
		expect(deleteCalls).toBe(1);
		expect(
			persistence.markWorkflowWorkspaceSessionCleaned,
		).not.toHaveBeenCalled();
	});

	it('keeps explicit single-sandbox teardown independent of the execution-wide intent fence', async () => {
		vi.stubEnv('SANDBOX_EXECUTION_API_URL', 'http://sea.test');
		const calls: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string | URL, init?: RequestInit) => {
				const target = String(url);
				calls.push(target);
				if (init?.method === 'DELETE') {
					return Response.json({
						sandboxName:
							'wfb-dev-preview-workflow-orchestrator-exec-1',
						accepted: true,
						deleted: true,
						deferred: false,
					});
				}
				return Response.json({ restored: [], releasedLeases: [] });
			}),
		);
		const persistence = fakePersistence([
			{
				workspaceRef: 'wfb-dev-preview-workflow-orchestrator-exec-1',
				service: 'workflow-orchestrator',
			},
		]);
		const databases = {
			provision: vi.fn(),
			drop: vi.fn(async () => undefined),
		};

		await expect(
			teardownDevPreview(
				{
					executionId: 'exec-1',
					sandboxName: 'wfb-dev-preview-workflow-orchestrator-exec-1',
				},
				persistence,
				databases as never,
			),
		).resolves.toMatchObject({ ok: true, complete: true, pending: false });
		expect(calls).toContain(
			'http://sea.test/internal/dev-preview/wfb-dev-preview-workflow-orchestrator-exec-1?executionId=exec-1&service=workflow-orchestrator',
		);
		expect(calls.some((url) => url.includes('teardown-intent'))).toBe(
			false,
		);
		expect(
			calls.some((url) => url.includes('/internal/dev-previews?')),
		).toBe(false);
		expect(databases.drop).not.toHaveBeenCalled();
	});

	it('reports failure rather than 202 when one response-path delete is deferred and another fails', async () => {
		vi.stubEnv('SANDBOX_EXECUTION_API_URL', 'http://sea.test');
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string | URL, init?: RequestInit) => {
				const target = String(url);
				if (target.endsWith('/internal/dev-previews/teardown-intent')) {
					return Response.json({
						accepted: true,
						executionId: 'exec-1',
					});
				}
				if (target.includes('/internal/dev-previews?')) {
					return Response.json({
						executionId: 'exec-1',
						complete: true,
						services: [
							{
								service: 'function-router',
								sandboxName:
									'wfb-dev-preview-function-router-exec-1',
							},
							{
								service: 'workflow-builder',
								sandboxName:
									'wfb-dev-preview-workflow-builder-exec-1',
							},
						],
					});
				}
				if (init?.method === 'DELETE') {
					const name = teardownRequestIdentity(target).sandboxName;
					return name === 'wfb-dev-preview-function-router-exec-1'
						? Response.json(
								{ detail: 'router restore failed' },
								{ status: 409 },
							)
						: Response.json(
								{
									sandboxName: name,
									accepted: true,
									deleted: false,
									deferred: true,
								},
								{ status: 202 },
							);
				}
				return Response.json({ restored: [], releasedLeases: [] });
			}),
		);
		const persistence = fakePersistence([
			{
				workspaceRef: 'wfb-dev-preview-function-router-exec-1',
				service: 'function-router',
			},
			{
				workspaceRef: 'wfb-dev-preview-workflow-builder-exec-1',
				service: 'workflow-builder',
			},
		]);

		await expect(
			teardownDevPreview({ executionId: 'exec-1' }, persistence),
		).resolves.toEqual({
			ok: false,
			complete: false,
			pending: true,
			sandboxName: 'wfb-dev-preview-function-router-exec-1',
		});
	});

	it('drops the execution database even when persistence and SEA inventories are empty', async () => {
		stubSea();
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const persistence = fakePersistence([]);
		const databases = {
			provision: vi.fn(),
			drop: vi.fn(async () => undefined),
		};
		vi.useFakeTimers();
		try {
			const pending = teardownDevPreview(
				{ executionId: 'exec-1' },
				persistence,
				databases as never,
			);
			await vi.runAllTimersAsync();
			await expect(pending).resolves.toMatchObject({
				ok: true,
				complete: true,
			});
		} finally {
			vi.useRealTimers();
		}
		expect(databases.drop).toHaveBeenCalledOnce();
		expect(databases.drop).toHaveBeenCalledWith({ executionId: 'exec-1' });
	});

	it('does not report execution-wide teardown complete when the database drop fails', async () => {
		stubSea();
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const persistence = fakePersistence([]);
		const databases = {
			provision: vi.fn(),
			drop: vi.fn(async () => {
				throw new Error('database unavailable');
			}),
		};
		vi.useFakeTimers();
		try {
			const pending = teardownDevPreview(
				{ executionId: 'exec-1' },
				persistence,
				databases as never,
			);
			await vi.runAllTimersAsync();
			await expect(pending).resolves.toEqual({
				ok: false,
				complete: false,
				pending: false,
				sandboxName: null,
			});
		} finally {
			vi.useRealTimers();
		}
	});
});
