import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	requireMint: vi.fn(),
	mint: vi.fn(async () => ({ receiverToken: 'd'.repeat(64), agentActionToken: 'e'.repeat(64) }))
}));

vi.mock('$env/dynamic/private', () => ({ env: { PREVIEW_CONTROL_BROKER_MODE: 'true' } }));
vi.mock('$lib/server/internal-auth', () => ({
	requirePreviewDevSyncMintCapability: mocks.requireMint
}));
vi.mock('$lib/server/application', () => ({
	getApplicationAdapters: () => ({ previewDevSyncCredentialMint: { mint: mocks.mint } })
}));

import { POST } from './+server';

const body = {
	previewName: 'preview-one',
	environmentRequestId: 'request-1',
	environmentPlatformRevision: 'a'.repeat(40),
	environmentSourceRevision: 'b'.repeat(40),
	catalogDigest: `sha256:${'c'.repeat(64)}`,
	executionId: 'execution-1',
	service: 'workflow-builder'
};

function event(value: unknown) {
	return {
		request: new Request('http://broker/api/internal/preview-control/dev-sync-credentials', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(value)
		})
	};
}

describe('physical preview dev-sync credential route', () => {
	beforeEach(() => vi.clearAllMocks());

	it('authenticates only the mint bearer and delegates the exact tuple', async () => {
		const response = (await POST(event(body) as never)) as Response;
		expect(response.status).toBe(200);
		expect(mocks.requireMint).toHaveBeenCalledWith(expect.any(Request), {
			previewName: body.previewName,
			environmentRequestId: body.environmentRequestId,
			environmentPlatformRevision: body.environmentPlatformRevision,
			environmentSourceRevision: body.environmentSourceRevision,
			catalogDigest: body.catalogDigest
		});
		expect(mocks.mint).toHaveBeenCalledWith(body);
		await expect(response.json()).resolves.toEqual({
			receiverToken: 'd'.repeat(64),
			agentActionToken: 'e'.repeat(64)
		});
	});

	it('rejects extra authority fields before minting', async () => {
		const response = (await POST(event({ ...body, rootToken: 'attacker' }) as never)) as Response;
		expect(response.status).toBe(400);
		expect(mocks.requireMint).not.toHaveBeenCalled();
		expect(mocks.mint).not.toHaveBeenCalled();
	});
});
