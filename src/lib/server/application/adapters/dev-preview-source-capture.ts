import type {
	CaptureDevPreviewSourcesInput,
	CaptureDevPreviewSourcesResult,
	DevPreviewSourceCapturePort
} from '$lib/server/application/ports/dev-preview-source-capture';
import {
	captureAllDevPreviewSources,
	type DevPreviewPersistence
} from '$lib/server/workflows/dev-preview';
import type { PreviewDevSyncCredentialBrokerPort } from '$lib/server/application/ports';
import { HttpPreviewDevSyncCredentialBrokerAdapter } from '$lib/server/application/adapters/preview-dev-sync-credentials';

/** Compatibility adapter around the existing preview export and persistence implementation. */
export class LegacyDevPreviewSourceCaptureAdapter implements DevPreviewSourceCapturePort {
	constructor(
		private readonly persistence: () => DevPreviewPersistence,
		private readonly credentialBroker: PreviewDevSyncCredentialBrokerPort = new HttpPreviewDevSyncCredentialBrokerAdapter()
	) {}

	captureAll(input: CaptureDevPreviewSourcesInput): Promise<CaptureDevPreviewSourcesResult> {
		const { executionId, ...options } = input;
		return captureAllDevPreviewSources(executionId, options, this.persistence(), {
			broker: this.credentialBroker
		});
	}
}
