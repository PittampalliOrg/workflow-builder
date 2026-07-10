import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const SERVICE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const ROOT_PATTERN = /^[a-f0-9]{64}$/;
const MAX_EXECUTION_ID_LENGTH = 256;

export type DevSyncCapabilityPurpose = 'receiver' | 'agent-action';

function coordinate(executionId: string, service: string) {
	const normalizedExecutionId = executionId.trim();
	const normalizedService = service.trim();
	if (
		!normalizedExecutionId ||
		normalizedExecutionId.length > MAX_EXECUTION_ID_LENGTH ||
		normalizedExecutionId.includes('\0')
	) {
		throw new Error('Dev-sync execution id is invalid');
	}
	if (!SERVICE_PATTERN.test(normalizedService)) {
		throw new Error('Dev-sync service is invalid');
	}
	return { executionId: normalizedExecutionId, service: normalizedService };
}

function deriveDevSyncCapability(
	rootToken: string,
	purpose: DevSyncCapabilityPurpose,
	executionId: string,
	service: string
): string {
	const root = rootToken.trim();
	if (!ROOT_PATTERN.test(root)) throw new Error('WFB_DEV_SYNC_TOKEN is invalid');
	const scope = coordinate(executionId, service);
	return createHmac('sha256', Buffer.from(root, 'hex'))
		.update(
			JSON.stringify({
				schema: 'wfb.dev-sync-capability/v1',
				purpose,
				...scope
			})
		)
		.digest('hex');
}

export function deriveDevSyncReceiverToken(
	rootToken: string,
	executionId: string,
	service: string
): string {
	return deriveDevSyncCapability(rootToken, 'receiver', executionId, service);
}

export function deriveDevSyncAgentActionToken(
	rootToken: string,
	executionId: string,
	service: string
): string {
	return deriveDevSyncCapability(rootToken, 'agent-action', executionId, service);
}

export function hashDevSyncToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

function tokenEquals(left: string, right: string): boolean {
	if (!TOKEN_PATTERN.test(left) || !TOKEN_PATTERN.test(right)) return false;
	return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

/** Receiver authorization without storing the agent action bearer in the pod. */
export function acceptsDevSyncToken(
	presentedToken: string,
	receiverToken: string,
	agentTokenSha256: string
): boolean {
	const presented = presentedToken.trim();
	return (
		tokenEquals(presented, receiverToken.trim()) ||
		tokenEquals(hashDevSyncToken(presented), agentTokenSha256.trim())
	);
}
