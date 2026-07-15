import { describe, expect, it, vi } from 'vitest';
import { ApplicationPreviewDevSyncCredentialMintService } from '$lib/server/application/preview-dev-sync-credentials';

const identity = {
	previewName: 'preview-one',
	environmentRequestId: 'request-1',
	environmentPlatformRevision: 'a'.repeat(40),
	environmentSourceRevision: 'b'.repeat(40),
	catalogDigest: `sha256:${'c'.repeat(64)}` as const,
	executionId: 'execution-1',
	service: 'workflow-builder'
};

function harness() {
	const authority = { authorizeRuntime: vi.fn(async () => ({ ok: true })) };
	const catalog = {
		currentDigest: () => identity.catalogDigest,
		listPreviewNativeServices: () => ['workflow-builder'],
		assertPreviewNativeServices: vi.fn((services: readonly string[]) => [...services])
	};
	const issuer = {
		issue: vi.fn(() => ({
			receiverToken: 'd'.repeat(64),
			agentActionToken: 'e'.repeat(64)
		}))
	};
	return {
		authority,
		issuer,
		service: new ApplicationPreviewDevSyncCredentialMintService({
			authority: authority as never,
			catalog,
			issuer
		})
	};
}

describe('physical preview dev-sync credential mint', () => {
	it('authorizes the exact service and immutable preview tuple before issuing', async () => {
		const h = harness();
		await expect(h.service.mint(identity)).resolves.toEqual({
			receiverToken: 'd'.repeat(64),
			agentActionToken: 'e'.repeat(64)
		});
		expect(h.authority.authorizeRuntime).toHaveBeenCalledWith({
			previewName: identity.previewName,
			environmentRequestId: identity.environmentRequestId,
			environmentPlatformRevision: identity.environmentPlatformRevision,
			environmentSourceRevision: identity.environmentSourceRevision,
			catalogDigest: identity.catalogDigest,
			requiredServices: ['workflow-builder']
		});
		expect(h.issuer.issue).toHaveBeenCalledWith(identity);
	});

	it('accepts the URL-safe Nanoid generated for the live workflow execution', async () => {
		const h = harness();
		const executionId = '_O-r4CT3dAp9CRUi7ImCA';
		await expect(h.service.mint({ ...identity, executionId })).resolves.toEqual({
			receiverToken: 'd'.repeat(64),
			agentActionToken: 'e'.repeat(64)
		});
		expect(h.issuer.issue).toHaveBeenCalledWith({ ...identity, executionId });
	});

	it('never issues for malformed execution or service coordinates', async () => {
		const h = harness();
		await expect(h.service.mint({ ...identity, executionId: '../other' })).rejects.toThrow(
			'execution id'
		);
		await expect(h.service.mint({ ...identity, service: '../other' })).rejects.toThrow('service');
		expect(h.authority.authorizeRuntime).not.toHaveBeenCalled();
		expect(h.issuer.issue).not.toHaveBeenCalled();
	});

	it('does not issue when physical authority rejects the tuple', async () => {
		const h = harness();
		h.authority.authorizeRuntime.mockRejectedValueOnce(new Error('wrong preview generation'));
		await expect(h.service.mint(identity)).rejects.toThrow('wrong preview generation');
		expect(h.issuer.issue).not.toHaveBeenCalled();
	});
});
