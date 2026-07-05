// Ports for the GitOps deployment/promotion read surfaces (the pipeline graph,
// change journeys, promoter tabs, and the runtime-metadata drawer). These wrap
// the legacy aggregators (`$lib/server/gitops/deployment-metadata`,
// `$lib/server/promoter`) so routes reach cluster/GitHub state through the
// application layer instead of importing the domain modules directly.
import type {
	DeploymentMetadataResponse,
	RuntimeMetadataResponse,
} from "$lib/types/deployment-metadata";
import type {
	PromotionStrategiesResponse,
	PromotionStrategy,
} from "$lib/server/promoter/types";

/** Which in-process cache tier to clear on a GitOps activity event.
 * - `runtime`: cheap cluster-state caches (hub inventory + runtime metadata),
 *   cleared on any ArgoCD/Tekton/Promoter/inventory signal.
 * - `pins`: expensive GitHub-derived caches (release pins, pin history walk,
 *   stacks main ref), cleared only on pin-affecting signals (a promotion PR).
 * - `all`: both tiers (`deployment-metadata` full flush). */
export type GitOpsCacheScope = "runtime" | "pins" | "all";

export type DeploymentMetadataFetchOptions = {
	/** Bypass the in-process cache for a forced refresh. */
	fresh?: boolean;
};

/** Cluster + GitOps deployment state (release pins, live deployments, hub
 * inventory) plus the derived runtime-metadata projection. */
export interface DeploymentMetadataPort {
	getDeploymentMetadata(
		options?: DeploymentMetadataFetchOptions,
	): Promise<DeploymentMetadataResponse>;
	/** Decorate each live container's commitSha with its GitHub commit metadata. */
	enrichLiveCommits(
		response: DeploymentMetadataResponse,
	): Promise<DeploymentMetadataResponse>;
	getRuntimeMetadata(): Promise<RuntimeMetadataResponse>;
	invalidate(scope: GitOpsCacheScope): void;
}

/** GitOps Promoter state (promotion strategies + drill-down by name). */
export interface PromotionStatePort {
	getPromotionStrategies(): Promise<PromotionStrategiesResponse>;
	getPromotionStrategy(name: string): Promise<PromotionStrategy | null>;
}
