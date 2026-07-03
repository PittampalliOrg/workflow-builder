import {
	devPreviewServiceCatalog,
	getDevEnvironmentOrPending,
	listDevEnvironments,
} from "$lib/server/workflows/dev-environments";
import type {
	DevEnvironmentReadRepository,
	DevEnvironmentSummaryReadModel,
	DevPreviewServiceReadModel,
} from "$lib/server/application/ports";

export class LegacyDevEnvironmentReadRepository
	implements DevEnvironmentReadRepository
{
	listServices(): DevPreviewServiceReadModel[] {
		return devPreviewServiceCatalog();
	}

	listDevEnvironments(
		projectId: string | null | undefined,
	): Promise<DevEnvironmentSummaryReadModel[]> {
		return listDevEnvironments(projectId);
	}

	getDevEnvironmentOrPending(input: {
		executionId: string;
		projectId: string | null | undefined;
	}): Promise<DevEnvironmentSummaryReadModel | null> {
		return getDevEnvironmentOrPending(input.executionId, input.projectId);
	}
}
