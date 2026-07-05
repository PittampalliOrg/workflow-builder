import type { PromotionStatePort } from "$lib/server/application/ports";
import type {
	PromotionStrategiesResponse,
	PromotionStrategy,
} from "$lib/server/promoter/types";

export type GitOpsPromotionsDeps = {
	promotions: PromotionStatePort;
};

/**
 * Application service over GitOps Promoter state: the promotion-strategies list
 * (env board + freight timeline) and single-strategy drill-down, so routes read
 * promoter state through the application layer.
 */
export class ApplicationGitOpsPromotionsService {
	constructor(private readonly deps: GitOpsPromotionsDeps) {}

	getStrategies(): Promise<PromotionStrategiesResponse> {
		return this.deps.promotions.getPromotionStrategies();
	}

	getStrategy(name: string): Promise<PromotionStrategy | null> {
		return this.deps.promotions.getPromotionStrategy(name);
	}
}
