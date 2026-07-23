import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	allowedSidecarCommands,
	fetchSidecarStatus,
	runSidecarCommand,
	sidecarBaseUrl,
	syncDevPreviewSource
} from '$lib/server/workflows/dev-preview-sidecar';

beforeEach(() => {
	vi.stubEnv('PREVIEW_DEV_SYNC_MINT_TOKEN', '');
	vi.stubEnv('WFB_DEV_SYNC_TOKEN', '1'.repeat(64));
});

describe('sidecarBaseUrl', () => {
	it('derives the base from a stored syncUrl', () => {
		expect(sidecarBaseUrl('http://10.0.0.5:8001/__sync')).toBe('http://10.0.0.5:8001');
		expect(sidecarBaseUrl('http://10.0.0.5:3000/__sync/')).toBe('http://10.0.0.5:3000');
	});
	it('returns null when nothing is recorded', () => {
		expect(sidecarBaseUrl(null)).toBeNull();
		expect(sidecarBaseUrl('  ')).toBeNull();
	});
});

describe('allowedSidecarCommands', () => {
	it("exposes the registry's deps + testCommands names", () => {
		expect(allowedSidecarCommands('workflow-builder')).toEqual([
			'boundaries',
			'check',
			'contract',
			'deps',
			'migrate',
			'test-unit'
		]);
	});
	it('denies unknown services instead of throwing', () => {
		expect(allowedSidecarCommands('not-a-service')).toEqual([]);
	});
});

describe('fetchSidecarStatus', () => {
	it('parses a sidecar status payload', async () => {
		const fetchImpl = vi.fn(
			async (_url: RequestInfo | URL, _init?: RequestInit) =>
				new Response(
					JSON.stringify({
						ok: true,
						service: 'dev-sync-sidecar',
						dest: '/app',
						lastSyncAt: '2026-07-04T10:00:00.000Z',
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
						lastRun: null,
						commands: ['contract', 'deps']
					}),
					{ status: 200 }
				)
		);
		const result = await fetchSidecarStatus({
			syncUrl: 'http://10.0.0.5:8001/__sync',
			executionId: 'exec-1',
			service: 'workflow-builder',
			fetchImpl
		});
		expect(result).toMatchObject({
			ok: true,
			data: {
				ok: true,
				dest: '/app',
				commands: ['contract', 'deps'],
				frozen: true,
				prepared: false,
				frozenOperationId: 'teardown-abc',
				lastSyncTimingsMs: { planning: 30, total: 62 }
			}
		});
		expect(fetchImpl.mock.calls[0][0]).toBe('http://10.0.0.5:8001/__status');
	});

	it('classifies a plugin-mode dev server (non-sidecar body) as no-sidecar', async () => {
		const result = await fetchSidecarStatus({
			syncUrl: 'http://10.0.0.5:3000/__sync',
			executionId: 'exec-1',
			service: 'workflow-builder',
			fetchImpl: vi.fn(async () => new Response(JSON.stringify({ hello: 'app' }), { status: 200 }))
		});
		expect(result).toMatchObject({ ok: false, reason: 'no-sidecar' });
	});

	it('degrades to unreachable on network failure', async () => {
		const result = await fetchSidecarStatus({
			syncUrl: 'http://10.0.0.5:8001/__sync',
			executionId: 'exec-1',
			service: 'workflow-builder',
			fetchImpl: vi.fn(async () => {
				throw new Error('timeout');
			})
		});
		expect(result).toMatchObject({ ok: false, reason: 'unreachable' });
	});
});

describe('runSidecarCommand', () => {
	it('refuses commands outside the registry allowlist BEFORE any request', async () => {
		const fetchImpl = vi.fn();
		const result = await runSidecarCommand({
			syncUrl: 'http://10.0.0.5:8001/__sync',
			executionId: 'exec-1',
			service: 'workflow-builder',
			cmd: 'rm -rf /',
			fetchImpl
		});
		expect(result).toMatchObject({ ok: false, reason: 'forbidden' });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('POSTs an allowlisted command and returns the run output', async () => {
		const fetchImpl = vi.fn(
			async (_url: RequestInfo | URL, _init?: RequestInit) =>
				new Response(
					JSON.stringify({
						ok: true,
						cmd: 'contract',
						exitCode: 0,
						durationMs: 1234,
						truncated: false,
						output: '8 passed'
					}),
					{ status: 200 }
				)
		);
		const result = await runSidecarCommand({
			syncUrl: 'http://10.0.0.5:8001/__sync',
			executionId: 'exec-1',
			service: 'workflow-builder',
			cmd: 'contract',
			fetchImpl
		});
		expect(fetchImpl.mock.calls[0][0]).toBe('http://10.0.0.5:8001/__run?cmd=contract');
		expect((fetchImpl.mock.calls[0][1] as RequestInit).method).toBe('POST');
		expect(result).toMatchObject({
			ok: true,
			data: { ok: true, exitCode: 0, output: '8 passed' }
		});
	});

	it('passes through a failed run (non-zero exit) as data, not an error', async () => {
		const result = await runSidecarCommand({
			syncUrl: 'http://10.0.0.5:8001/__sync',
			executionId: 'exec-1',
			service: 'workflow-orchestrator',
			cmd: 'contract',
			fetchImpl: vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							ok: false,
							cmd: 'contract',
							exitCode: 1,
							durationMs: 900,
							truncated: false,
							output: '1 failed'
						}),
						{ status: 200 }
					)
			)
		});
		expect(result).toMatchObject({
			ok: true,
			data: { ok: false, exitCode: 1, output: '1 failed' }
		});
	});

	it('reports a fail-closed exec bridge response as unreachable', async () => {
		const result = await runSidecarCommand({
			syncUrl: 'http://10.0.0.5:8001/__sync',
			executionId: 'exec-1',
			service: 'workflow-builder',
			cmd: 'contract',
			fetchImpl: vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							ok: false,
							error: 'exec bridge unavailable: bridge unreachable'
						}),
						{ status: 503 }
					)
			)
		});
		expect(result).toEqual({
			ok: false,
			reason: 'unreachable',
			message: 'exec bridge unavailable: bridge unreachable'
		});
	});
});

describe("syncDevPreviewSource", () => {
  it("forwards a stable generation and explicit replace mode", async () => {
    const fetchImpl = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    await syncDevPreviewSource({
      syncUrl: "http://10.0.0.5:8001/__sync",
      executionId: "exec-1",
      service: "workflow-builder",
      archive: new Uint8Array([1, 2, 3]),
      generation: "pws-stable-generation",
      mode: "replace",
      fetchImpl,
    });
    const headers = (fetchImpl.mock.calls[0][1] as RequestInit)
      .headers as Record<string, string>;
    expect(headers["x-sync-generation"]).toBe("pws-stable-generation");
    expect(headers["x-sync-mode"]).toBe("replace");
    expect(headers["x-sync-token"]).toMatch(/^[0-9a-f]{64}$/);
  });
});
