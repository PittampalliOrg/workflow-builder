import { describe, expect, it, vi } from 'vitest';
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
