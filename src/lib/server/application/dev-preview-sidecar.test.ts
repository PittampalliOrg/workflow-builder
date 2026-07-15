import { describe, expect, it, vi } from 'vitest';
import {
	ApplicationDevPreviewSidecarService,
	parseSidecarLastRun
} from '$lib/server/application/dev-preview-sidecar';
import type {
	DevEnvironmentSummaryReadModel,
	DevPreviewSidecarPort
} from '$lib/server/application/ports';

function env(over: Partial<DevEnvironmentSummaryReadModel> = {}): DevEnvironmentSummaryReadModel {
	return {
		executionId: 'exec-1',
		workspaceRef: 'ws',
		service: 'workflow-builder',
		browseUrl: null,
		podIP: '10.0.0.1',
		port: 5173,
		syncUrl: 'http://10.0.0.1:9001/__sync',
		ready: true,
		needsDapr: false,
		daprAppId: null,
		sandboxName: null,
		sessionId: null,
		sessionUrl: null,
		runStatus: 'running',
		createdAt: '2026-07-05T00:00:00Z',
		...over
	};
}

const sidecar = (over: Partial<DevPreviewSidecarPort> = {}): DevPreviewSidecarPort => ({
	status: vi.fn(async () => ({ ok: true as const, data: { ok: true } })),
	run: vi.fn(async () => ({
		ok: true as const,
		data: {
			ok: true,
			cmd: 'test',
			exitCode: 0,
			durationMs: 12,
			truncated: false,
			output: '',
			executedIn: 'app' as const
		}
	})),
	sync: vi.fn(async ({ archive }) => ({
		ok: true as const,
		data: {
			ok: true,
			status: 200,
			bytes: archive.byteLength,
			body: { ok: true }
		}
	})),
	allowedCommands: vi.fn(() => ['deps', 'test']),
	...over
});

describe('parseSidecarLastRun', () => {
	it('parses the sidecar lastRun shape', () => {
		expect(
			parseSidecarLastRun({
				name: 'test',
				exitCode: 1,
				durationMs: 5000,
				executedIn: 'app',
				finishedAt: '2026-07-05T00:00:00Z'
			})
		).toEqual({
			cmd: 'test',
			exitCode: 1,
			durationMs: 5000,
			executedIn: 'app',
			finishedAt: '2026-07-05T00:00:00Z'
		});
	});

	it('returns null for absent/garbage and coerces bad executedIn', () => {
		expect(parseSidecarLastRun(null)).toBeNull();
		expect(parseSidecarLastRun({})).toBeNull();
		expect(parseSidecarLastRun({ name: 'x', executedIn: 'elsewhere' })?.executedIn).toBeNull();
	});
});

describe('ApplicationDevPreviewSidecarService', () => {
	it('resolves the project-scoped env, then parses lastRun into the status view', async () => {
		const scStatus = {
			ok: true as const,
			data: {
				ok: true,
				dest: '/app',
				lastSyncAt: '2026-07-05T00:00:00Z',
				lastSyncBytes: 2048,
				lastSyncTimingsMs: {
					validation: 10,
					staging: 20,
					planning: 30,
					commit: 1,
					total: 62
				},
				frozen: true,
				prepared: false,
				preparedOperationId: null,
				preparedAt: null,
				frozenOperationId: 'teardown-abc',
				commands: ['deps', 'test'],
				lastRun: {
					name: 'test',
					exitCode: 0,
					durationMs: 900,
					executedIn: 'app'
				}
			}
		};
		const sc = sidecar({ status: vi.fn(async () => scStatus) });
		const listEnvironments = vi.fn(async () => [env()]);
		const svc = new ApplicationDevPreviewSidecarService({
			sidecar: sc,
			listEnvironments
		});

		const result = await svc.status({
			executionId: 'exec-1',
			service: 'workflow-builder',
			projectId: 'p1'
		});
		expect(listEnvironments).toHaveBeenCalledWith({ projectId: 'p1' });
		expect(sc.status).toHaveBeenCalledWith({
			syncUrl: 'http://10.0.0.1:9001/__sync',
			executionId: 'exec-1',
			service: 'workflow-builder'
		});
		expect(result?.status.ok).toBe(true);
		if (result?.status.ok) {
			expect(result.status.data.lastSyncTimingsMs).toEqual({
				validation: 10,
				staging: 20,
				planning: 30,
				commit: 1,
				total: 62
			});
			expect(result.status.data.lastRun).toEqual({
				cmd: 'test',
				exitCode: 0,
				durationMs: 900,
				executedIn: 'app',
				finishedAt: null
			});
			expect(result.status.data.commands).toEqual(['deps', 'test']);
			expect(result.status.data).toMatchObject({
				frozen: true,
				prepared: false,
				preparedOperationId: null,
				frozenOperationId: 'teardown-abc'
			});
		}
		expect(result?.allowedCommands).toEqual(['deps', 'test']);
	});

	it('returns null when no env matches (route → 404)', async () => {
		const svc = new ApplicationDevPreviewSidecarService({
			sidecar: sidecar(),
			listEnvironments: vi.fn(async () => [env({ service: 'other' })])
		});
		expect(
			await svc.status({
				executionId: 'exec-1',
				service: 'workflow-builder',
				projectId: 'p1'
			})
		).toBeNull();
	});

	it("forwards a run to the resolved env's pod", async () => {
		const sc = sidecar();
		const svc = new ApplicationDevPreviewSidecarService({
			sidecar: sc,
			listEnvironments: vi.fn(async () => [env()])
		});
		const result = await svc.run({
			executionId: 'exec-1',
			service: 'workflow-builder',
			projectId: 'p1',
			cmd: 'test'
		});
		expect(sc.run).toHaveBeenCalledWith({
			syncUrl: 'http://10.0.0.1:9001/__sync',
			executionId: 'exec-1',
			service: 'workflow-builder',
			cmd: 'test'
		});
		expect(result?.cmd).toBe('test');
		expect(result?.result.ok).toBe(true);
	});

	it("forwards sync archives to the resolved env's sync endpoint", async () => {
		const sc = sidecar();
		const archive = new Uint8Array([1, 2, 3]);
		const svc = new ApplicationDevPreviewSidecarService({
			sidecar: sc,
			listEnvironments: vi.fn(async () => [env()])
		});
		const result = await svc.sync({
			executionId: 'exec-1',
			service: 'workflow-builder',
			projectId: 'p1',
			archive,
			contentType: 'application/gzip'
		});
		expect(sc.sync).toHaveBeenCalledWith({
			syncUrl: 'http://10.0.0.1:9001/__sync',
			executionId: 'exec-1',
			service: 'workflow-builder',
			archive,
			contentType: 'application/gzip'
		});
		expect(result?.result.ok).toBe(true);
	});

	it('surfaces an unreachable sidecar as ok:false status data', async () => {
		const sc = sidecar({
			status: vi.fn(async () => ({
				ok: false as const,
				reason: 'unreachable' as const,
				message: 'boom'
			}))
		});
		const svc = new ApplicationDevPreviewSidecarService({
			sidecar: sc,
			listEnvironments: vi.fn(async () => [env()])
		});
		const result = await svc.status({
			executionId: 'exec-1',
			service: 'workflow-builder',
			projectId: 'p1'
		});
		expect(result?.status.ok).toBe(false);
		if (result && !result.status.ok) expect(result.status.reason).toBe('unreachable');
	});
});
