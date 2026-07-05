import type {
	DeploymentMetadataFetchOptions,
	DeploymentMetadataPort,
	GitOpsCacheScope,
} from "$lib/server/application/ports";
import {
	enrichLiveCommits,
	getDeploymentMetadata,
	getRuntimeMetadata,
	invalidateGitOpsDeploymentMetadataCaches,
	invalidateGitOpsPinCaches,
	invalidateGitOpsRuntimeCaches,
} from "$lib/server/gitops/deployment-metadata";
import type {
	DeploymentMetadataResponse,
	RuntimeMetadataResponse,
} from "$lib/types/deployment-metadata";

/** Adapter over the legacy `deployment-metadata` aggregator (no rewrite — the
 * in-process caches, Tailscale fallback, and GitHub fan-out stay in the domain
 * module). */
export class LegacyDeploymentMetadataGateway implements DeploymentMetadataPort {
	getDeploymentMetadata(
		options?: DeploymentMetadataFetchOptions,
	): Promise<DeploymentMetadataResponse> {
		return getDeploymentMetadata(options ?? {});
	}

	enrichLiveCommits(
		response: DeploymentMetadataResponse,
	): Promise<DeploymentMetadataResponse> {
		return enrichLiveCommits(response);
	}

	getRuntimeMetadata(): Promise<RuntimeMetadataResponse> {
		return getRuntimeMetadata();
	}

	invalidate(scope: GitOpsCacheScope): void {
		switch (scope) {
			case "pins":
				invalidateGitOpsPinCaches();
				return;
			case "runtime":
				invalidateGitOpsRuntimeCaches();
				return;
			case "all":
				invalidateGitOpsDeploymentMetadataCaches();
				return;
		}
	}
}
