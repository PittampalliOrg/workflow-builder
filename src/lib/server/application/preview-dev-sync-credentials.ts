import type {
	PreviewControlSourceAuthorityPort,
	PreviewDevSyncCredentialMintPort,
	PreviewDevSyncCredentialRequest,
	PreviewDevSyncLeafIssuerPort,
	PreviewEnvironmentVersionedServiceCatalogPort
} from '$lib/server/application/ports';

const EXECUTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SERVICE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export class PreviewDevSyncCredentialInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PreviewDevSyncCredentialInputError';
	}
}

/** Authorizes one exact preview/service tuple before issuing child leaves. */
export class ApplicationPreviewDevSyncCredentialMintService implements PreviewDevSyncCredentialMintPort {
	constructor(
		private readonly deps: Readonly<{
			authority: Pick<PreviewControlSourceAuthorityPort, 'authorizeRuntime'>;
			catalog: PreviewEnvironmentVersionedServiceCatalogPort;
			issuer: PreviewDevSyncLeafIssuerPort;
		}>
	) {}

	async mint(input: PreviewDevSyncCredentialRequest) {
		const executionId = input.executionId.trim();
		const service = input.service.trim();
		if (!EXECUTION_ID.test(executionId)) {
			throw new PreviewDevSyncCredentialInputError('invalid dev-sync execution id');
		}
		if (!SERVICE.test(service)) {
			throw new PreviewDevSyncCredentialInputError('invalid dev-sync service');
		}
		const [catalogService] = this.deps.catalog.assertPreviewNativeServices([service]);
		if (catalogService !== service) {
			throw new PreviewDevSyncCredentialInputError('dev-sync service is not cataloged');
		}
		await this.deps.authority.authorizeRuntime({
			previewName: input.previewName,
			environmentRequestId: input.environmentRequestId,
			environmentPlatformRevision: input.environmentPlatformRevision,
			environmentSourceRevision: input.environmentSourceRevision,
			catalogDigest: input.catalogDigest,
			requiredServices: [service]
		});
		return Object.freeze(
			this.deps.issuer.issue({
				...input,
				executionId,
				service
			})
		);
	}
}
