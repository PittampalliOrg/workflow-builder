import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApplicationGitOpsPromotionsService } from "$lib/server/application/gitops-promotions";
import type { PromotionStatePort } from "$lib/server/application/ports";
import type {
	PromotionStrategiesResponse,
	PromotionStrategy,
} from "$lib/server/promoter/types";

const strategiesResponse = {
	generatedAt: "2026-07-05T00:00:00.000Z",
	source: "fixture",
	strategies: [],
	changeTransferPolicies: [],
	pullRequests: [],
	commitStatuses: [],
	error: null,
} as unknown as PromotionStrategiesResponse;

const strategy = { metadata: { name: "workflow-builder-release" } } as unknown as PromotionStrategy;

describe("ApplicationGitOpsPromotionsService", () => {
	let promotions: PromotionStatePort;
	let service: ApplicationGitOpsPromotionsService;

	beforeEach(() => {
		promotions = {
			getPromotionStrategies: vi.fn(async () => strategiesResponse),
			getPromotionStrategy: vi.fn(async () => strategy),
		};
		service = new ApplicationGitOpsPromotionsService({ promotions });
	});

	it("delegates the strategies list to the port", async () => {
		const result = await service.getStrategies();

		expect(promotions.getPromotionStrategies).toHaveBeenCalledOnce();
		expect(result).toBe(strategiesResponse);
	});

	it("delegates a single-strategy drill-down by name", async () => {
		const result = await service.getStrategy("workflow-builder-release");

		expect(promotions.getPromotionStrategy).toHaveBeenCalledWith("workflow-builder-release");
		expect(result).toBe(strategy);
	});
});
