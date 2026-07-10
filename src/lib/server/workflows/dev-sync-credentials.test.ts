import { describe, expect, it, vi } from 'vitest';
import { resolveDevSyncCredentials } from '$lib/server/workflows/dev-sync-credentials';
import {
	deriveDevSyncAgentActionToken,
	deriveDevSyncReceiverToken
} from '$lib/server/dev-sync/capability';

const identity = Object.freeze({
	previewName: 'preview-a',
	environmentRequestId: 'request-a',
	environmentPlatformRevision: 'a'.repeat(40),
	environmentSourceRevision: 'b'.repeat(40),
	catalogDigest: `sha256:${'c'.repeat(64)}` as const
});

describe('resolveDevSyncCredentials', () => {
	it('derives exact purpose-separated leaves on the persistent host', async () => {
		const root = '1'.repeat(64);
		await expect(
			resolveDevSyncCredentials(
				{ executionId: 'exec-1', service: 'workflow-builder' },
				{ mintToken: () => '', rootToken: () => root }
			)
		).resolves.toEqual({
			receiverToken: deriveDevSyncReceiverToken(root, 'exec-1', 'workflow-builder'),
			agentActionToken: deriveDevSyncAgentActionToken(root, 'exec-1', 'workflow-builder')
		});
	});

	it('uses the immutable preview identity and mint broker without reading the root', async () => {
		const mint = vi.fn(async () => ({
			receiverToken: 'd'.repeat(64),
			agentActionToken: 'e'.repeat(64)
		}));
		const result = await resolveDevSyncCredentials(
			{ executionId: 'exec-2', service: 'workflow-orchestrator' },
			{
				mintToken: () => 'f'.repeat(64),
				rootToken: () => {
					throw new Error('preview must not read a root');
				},
				identity: () => identity,
				broker: { mint }
			}
		);
		expect(result).toEqual({
			receiverToken: 'd'.repeat(64),
			agentActionToken: 'e'.repeat(64)
		});
		expect(mint).toHaveBeenCalledWith({
			...identity,
			executionId: 'exec-2',
			service: 'workflow-orchestrator'
		});
	});

	it('fails closed for an invalid mint leaf even when a local root exists', async () => {
		await expect(
			resolveDevSyncCredentials(
				{ executionId: 'exec-1', service: 'workflow-builder' },
				{ mintToken: () => 'not-a-token', rootToken: () => '1'.repeat(64) }
			)
		).rejects.toThrow('PREVIEW_DEV_SYNC_MINT_TOKEN is invalid');
	});

	it('fails closed when neither authority is configured', async () => {
		await expect(
			resolveDevSyncCredentials(
				{ executionId: 'exec-1', service: 'workflow-builder' },
				{ mintToken: () => '', rootToken: () => '' }
			)
		).rejects.toThrow('Dev-sync credential authority is not configured');
	});
});
