import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	HmacPreviewDevSyncLeafIssuerAdapter,
	HttpPreviewDevSyncCredentialBrokerAdapter
} from '$lib/server/application/adapters/preview-dev-sync-credentials';

const request = {
	previewName: 'preview-one',
	environmentRequestId: 'request-1',
	environmentPlatformRevision: 'a'.repeat(40),
	environmentSourceRevision: 'b'.repeat(40),
	catalogDigest: `sha256:${'c'.repeat(64)}` as const,
	executionId: 'execution-1',
	service: 'workflow-builder'
};

describe('preview dev-sync credential adapters', () => {
	afterEach(() => vi.restoreAllMocks());

	it('mints deterministic, purpose-separated, tuple-scoped leaves', () => {
		const issuer = new HmacPreviewDevSyncLeafIssuerAdapter(() => '1'.repeat(64));
		const pair = issuer.issue(request);
		expect(pair.receiverToken).toMatch(/^[a-f0-9]{64}$/);
		expect(pair.agentActionToken).toMatch(/^[a-f0-9]{64}$/);
		expect(pair.receiverToken).not.toBe(pair.agentActionToken);
		expect(issuer.issue(request)).toEqual(pair);
		expect(issuer.issue({ ...request, executionId: 'execution-2' })).not.toEqual(pair);
		expect(issuer.issue({ ...request, service: 'function-router' })).not.toEqual(pair);
		expect(issuer.issue({ ...request, previewName: 'preview-two' })).not.toEqual(pair);
	});

	it('calls only the mint endpoint with the mint-only bearer', async () => {
		const timeout = vi.spyOn(AbortSignal, 'timeout');
		const fetch = vi.fn(async () =>
			Response.json({ receiverToken: 'd'.repeat(64), agentActionToken: 'e'.repeat(64) })
		);
		const adapter = new HttpPreviewDevSyncCredentialBrokerAdapter({
			baseUrl: () => 'http://preview-control/',
			mintToken: () => 'f'.repeat(64),
			fetch
		});
		await expect(adapter.mint(request)).resolves.toEqual({
			receiverToken: 'd'.repeat(64),
			agentActionToken: 'e'.repeat(64)
		});
		expect(fetch).toHaveBeenCalledWith(
			'http://preview-control/api/internal/preview-control/dev-sync-credentials',
			expect.objectContaining({
				method: 'POST',
				headers: expect.objectContaining({
					'x-preview-dev-sync-mint-token': 'f'.repeat(64)
				}),
				body: JSON.stringify(request)
			})
		);
		expect(timeout).toHaveBeenCalledWith(45_000);
	});

	it('serializes physical authority calls across concurrent consumers', async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const fetch = vi.fn(async () => {
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 1));
			inFlight -= 1;
			return Response.json({
				receiverToken: 'd'.repeat(64),
				agentActionToken: 'e'.repeat(64)
			});
		});
		const adapter = new HttpPreviewDevSyncCredentialBrokerAdapter({
			baseUrl: () => 'http://preview-control',
			mintToken: () => 'f'.repeat(64),
			fetch
		});

		await Promise.all([
			adapter.mint({ ...request, service: 'function-router' }),
			adapter.mint({ ...request, service: 'workflow-builder' }),
			adapter.mint({ ...request, service: 'workflow-orchestrator' })
		]);

		expect(fetch).toHaveBeenCalledTimes(3);
		expect(maxInFlight).toBe(1);
	});

	it('rejects malformed broker leaves', async () => {
		const adapter = new HttpPreviewDevSyncCredentialBrokerAdapter({
			baseUrl: () => 'http://preview-control',
			mintToken: () => 'f'.repeat(64),
			fetch: async () => Response.json({ receiverToken: 'same', agentActionToken: 'same' })
		});
		await expect(adapter.mint(request)).rejects.toThrow('invalid leaves');
	});
});
