import type { PreviewEnvironmentProvisioner } from "$lib/server/application/ports";
import {
	provisionDevPreview,
	type DevPreviewInfo,
	type DevPreviewPersistence,
	type ProvisionDevPreviewParams,
} from "$lib/server/workflows/dev-preview";

export class SandboxExecutionPreviewEnvironmentProvisioner
	implements PreviewEnvironmentProvisioner
{
	constructor(private readonly persistence?: () => DevPreviewPersistence) {}

	provision(input: ProvisionDevPreviewParams): Promise<DevPreviewInfo> {
		return provisionDevPreview(input, this.persistence?.());
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
}
