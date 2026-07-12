import { createHmac } from 'node:crypto';
import { env } from '$env/dynamic/private';
import type {
	PreviewDevSyncCredentialBrokerPort,
	PreviewDevSyncCredentialRequest,
	PreviewDevSyncLeafIssuerPort
} from '$lib/server/application/ports';

const ROOT = /^[a-f0-9]{64}$/;
const TOKEN = /^[a-f0-9]{64}$/;
// The broker's authoritative environment inspection can use a 30 second
// downstream budget. Leave headroom for that proof and response transport.
const DEFAULT_TIMEOUT_MS = 45_000;

function issue(
	root: string,
	input: PreviewDevSyncCredentialRequest,
	purpose: 'receiver' | 'agent-action'
): string {
	if (!ROOT.test(root)) throw new Error('preview dev-sync credential root is invalid');
	return createHmac('sha256', Buffer.from(root, 'hex'))
		.update(
			JSON.stringify({
				schema: 'wfb.preview-dev-sync-leaf/v1',
				purpose,
				previewName: input.previewName,
				environmentRequestId: input.environmentRequestId,
				environmentPlatformRevision: input.environmentPlatformRevision,
				environmentSourceRevision: input.environmentSourceRevision,
				catalogDigest: input.catalogDigest,
				executionId: input.executionId,
				service: input.service
			})
		)
		.digest('hex');
}

export class HmacPreviewDevSyncLeafIssuerAdapter implements PreviewDevSyncLeafIssuerPort {
	constructor(
		private readonly root: () => string = () =>
			(
				env.PREVIEW_CONTROL_CAPABILITY_ROOT_TOKEN ??
				process.env.PREVIEW_CONTROL_CAPABILITY_ROOT_TOKEN ??
				''
			).trim()
	) {}

	issue(input: PreviewDevSyncCredentialRequest) {
		const root = this.root();
		return Object.freeze({
			receiverToken: issue(root, input, 'receiver'),
			agentActionToken: issue(root, input, 'agent-action')
		});
	}
}

export type HttpPreviewDevSyncCredentialBrokerOptions = Readonly<{
	baseUrl?: () => string | null;
	mintToken?: () => string | null;
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
}>;

export class HttpPreviewDevSyncCredentialBrokerAdapter implements PreviewDevSyncCredentialBrokerPort {
	constructor(private readonly options: HttpPreviewDevSyncCredentialBrokerOptions = {}) {}

	async mint(input: PreviewDevSyncCredentialRequest) {
		const baseUrl = (
			this.options.baseUrl?.() ??
			env.PREVIEW_CONTROL_BROKER_URL ??
			process.env.PREVIEW_CONTROL_BROKER_URL ??
			''
		)
			.trim()
			.replace(/\/+$/, '');
		const mintToken = (
			this.options.mintToken?.() ??
			env.PREVIEW_DEV_SYNC_MINT_TOKEN ??
			process.env.PREVIEW_DEV_SYNC_MINT_TOKEN ??
			''
		).trim();
		if (!baseUrl || !TOKEN.test(mintToken)) {
			throw new Error('preview dev-sync credential broker is not configured');
		}
		const response = await (this.options.fetch ?? globalThis.fetch)(
			`${baseUrl}/api/internal/preview-control/dev-sync-credentials`,
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-preview-dev-sync-mint-token': mintToken
				},
				body: JSON.stringify(input),
				signal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
			}
		);
		const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
		if (!response.ok) {
			throw new Error(
				typeof body?.error === 'string'
					? body.error
					: `preview dev-sync credential broker failed (HTTP ${response.status})`
			);
		}
		const receiverToken = typeof body?.receiverToken === 'string' ? body.receiverToken : '';
		const agentActionToken =
			typeof body?.agentActionToken === 'string' ? body.agentActionToken : '';
		if (
			!TOKEN.test(receiverToken) ||
			!TOKEN.test(agentActionToken) ||
			receiverToken === agentActionToken
		) {
			throw new Error('preview dev-sync credential broker returned invalid leaves');
		}
		return Object.freeze({ receiverToken, agentActionToken });
	}
}
