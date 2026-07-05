import type {
	DeploymentMetadataPort,
	GitOpsCacheScope,
} from "$lib/server/application/ports";
import type {
	DeploymentMetadataResponse,
	RuntimeMetadataResponse,
} from "$lib/types/deployment-metadata";

export type GetMetadataInput = {
	/** Bypass the in-process cache (forced refresh). */
	fresh?: boolean;
	/** Decorate live containers with their GitHub commit metadata. The JSON API
	 * route enriches; the page loads read the cheaper un-enriched snapshot. */
	enrichLive?: boolean;
};

export type GitOpsDeploymentDeps = {
	metadata: DeploymentMetadataPort;
};

/**
 * Application service over the GitOps deployment-metadata aggregator: the single
 * composition point for `{fresh, enrichLive}` reads and cache invalidation, so
 * routes never import the domain module directly.
 */
export class ApplicationGitOpsDeploymentService {
	constructor(private readonly deps: GitOpsDeploymentDeps) {}

	/** Deployment metadata (release pins, live deployments, hub inventory).
	 * `enrichLive` folds in per-container GitHub commit metadata. */
	async getMetadata(input: GetMetadataInput = {}): Promise<DeploymentMetadataResponse> {
		const response = await this.deps.metadata.getDeploymentMetadata({ fresh: input.fresh });
		if (input.enrichLive) {
			return this.deps.metadata.enrichLiveCommits(response);
		}
		return response;
	}

	/** Cached runtime-metadata projection (current image + matrix). */
	getRuntimeMetadata(): Promise<RuntimeMetadataResponse> {
		return this.deps.metadata.getRuntimeMetadata();
	}

	/** Clear the requested cache tier after a GitOps activity event. */
	invalidateCaches(scope: GitOpsCacheScope): void {
		this.deps.metadata.invalidate(scope);
	}
}
