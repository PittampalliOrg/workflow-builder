import { env } from '$env/dynamic/private';
import type {
	PreviewControlIdentity,
	PreviewDevSyncCredentialBrokerPort,
	PreviewDevSyncCredentialPair
} from '$lib/server/application/ports';
import {
	deriveDevSyncAgentActionToken,
	deriveDevSyncReceiverToken
} from '$lib/server/dev-sync/capability';
import { localPreviewControlIdentity } from '$lib/server/preview-control-capability';

const TOKEN = /^[a-f0-9]{64}$/;

export type DevSyncCredentialResolverOptions = Readonly<{
	mintToken?: () => string | null;
	rootToken?: () => string | null;
	identity?: () => PreviewControlIdentity;
	broker?: PreviewDevSyncCredentialBrokerPort;
}>;

function configuredMintToken(): string {
	return (env.PREVIEW_DEV_SYNC_MINT_TOKEN ?? process.env.PREVIEW_DEV_SYNC_MINT_TOKEN ?? '').trim();
}

function configuredRootToken(): string {
	return (env.WFB_DEV_SYNC_TOKEN ?? process.env.WFB_DEV_SYNC_TOKEN ?? '').trim();
}

/**
 * Resolve one exact receiver/agent pair at the BFF edge.
 *
 * A mutable preview holds only its identity-bound mint leaf and delegates to the
 * physical broker. The persistent host BFF may derive the same purpose-separated
 * local pair from its dev-sync root. The root is never required inside a preview.
 */
export async function resolveDevSyncCredentials(
	input: Readonly<{ executionId: string; service: string }>,
	options: DevSyncCredentialResolverOptions = {}
): Promise<PreviewDevSyncCredentialPair> {
	const mintToken = (options.mintToken?.() ?? configuredMintToken()).trim();
	if (mintToken) {
		if (!TOKEN.test(mintToken)) {
			throw new Error('PREVIEW_DEV_SYNC_MINT_TOKEN is invalid');
		}
		const identity = (options.identity ?? localPreviewControlIdentity)();
		if (!options.broker) {
			throw new Error('Preview dev-sync credential broker is not configured');
		}
		return options.broker.mint({
			...identity,
			executionId: input.executionId,
			service: input.service
		});
	}

	const rootToken = (options.rootToken?.() ?? configuredRootToken()).trim();
	if (!rootToken) {
		throw new Error('Dev-sync credential authority is not configured');
	}
	return Object.freeze({
		receiverToken: deriveDevSyncReceiverToken(rootToken, input.executionId, input.service),
		agentActionToken: deriveDevSyncAgentActionToken(rootToken, input.executionId, input.service)
	});
}
