import type {
	PreviewDatabaseProvisioner,
	PreviewEnvironmentProvisioner,
} from "$lib/server/application/ports";
import {
	provisionDevPreview,
	provisionDevPreviews,
	type DevPreviewInfo,
	type DevPreviewPersistence,
	type DevPreviewsResult,
	type ProvisionDevPreviewParams,
	type ProvisionDevPreviewsParams,
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

	provisionMany(input: ProvisionDevPreviewsParams): Promise<DevPreviewsResult> {
		return provisionDevPreviews(
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

	async provisionMany(
		_input: ProvisionDevPreviewsParams,
	): Promise<DevPreviewsResult> {
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
