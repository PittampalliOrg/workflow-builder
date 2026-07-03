import type {
	PreviewDatabaseProvisioner,
	PreviewEnvironmentProvisioner,
} from "$lib/server/application/ports";
import {
	provisionDevPreview,
	type DevPreviewInfo,
	type DevPreviewPersistence,
	type ProvisionDevPreviewParams,
	teardownDevPreview,
	type TeardownDevPreviewParams,
	type TeardownDevPreviewResult,
} from "$lib/server/workflows/dev-preview";

export class SandboxExecutionPreviewEnvironmentProvisioner
	implements PreviewEnvironmentProvisioner
{
	constructor(
		private readonly persistence?: () => DevPreviewPersistence,
		private readonly previewDatabases?: PreviewDatabaseProvisioner,
	) {}

	provision(input: ProvisionDevPreviewParams): Promise<DevPreviewInfo> {
		return provisionDevPreview(
			input,
			this.persistence?.(),
			this.previewDatabases,
		);
	}

	teardown(input: TeardownDevPreviewParams): Promise<TeardownDevPreviewResult> {
		return teardownDevPreview(
			input,
			this.persistence?.(),
			this.previewDatabases,
		);
	}
}

export class KroPreviewEnvironmentProvisioner
	implements PreviewEnvironmentProvisioner
{
	async provision(_input: ProvisionDevPreviewParams): Promise<DevPreviewInfo> {
		throw new Error(
			"PREVIEW_PROVISIONER_ADAPTER=kro is available for packaging pilots, but runtime WorkflowBuilderPreviewEnvironment instance creation is not wired in the BFF yet",
		);
	}

	async teardown(
		_input: TeardownDevPreviewParams,
	): Promise<TeardownDevPreviewResult> {
		throw new Error(
			"PREVIEW_PROVISIONER_ADAPTER=kro is available for packaging pilots, but runtime WorkflowBuilderPreviewEnvironment teardown is not wired in the BFF yet",
		);
	}
}
