/**
 * Server-side accessor for GitOps Promoter state. Consumes the hub
 * `gitops-deployment-inventory` JSON via the existing
 * `getDeploymentMetadata()` aggregator (which is already plumbed through the
 * Tailscale fallback in `deployment-metadata.ts`), and projects the
 * `promotionStrategies` payload — once Phase A on the stacks repo lands —
 * into typed objects.
 *
 * Until Phase A reaches a given env, `inventory.data.promotionStrategies` is
 * undefined. We fall back to JSON fixtures shipped alongside this module so
 * the UI is testable on kind / local dev / pre-Phase-A spokes.
 */
import { getDeploymentMetadata } from "$lib/server/gitops/deployment-metadata";
import type { DeploymentMetadataResponse } from "$lib/types/deployment-metadata";

import workflowBuilderReleaseFixture from "$lib/promoter/__fixtures__/workflow-builder-release.json" with {
	type: "json",
};
import stacksEnvironmentsFixture from "$lib/promoter/__fixtures__/stacks-environments.json" with {
	type: "json",
};

import type {
	ChangeTransferPolicy,
	CommitStatus,
	PromoterInventory,
	PromotionStrategiesResponse,
	PromotionStrategy,
	PullRequest,
} from "./types";

const RUNTIME_CACHE_TTL_MS = 15_000;

type CacheEntry = {
	value: PromotionStrategiesResponse;
	expiresAt: number;
};

let cache: CacheEntry | null = null;

const FIXTURE_STRATEGIES: PromotionStrategy[] = [
	workflowBuilderReleaseFixture as PromotionStrategy,
	stacksEnvironmentsFixture as PromotionStrategy,
];

export async function getPromotionStrategies(): Promise<PromotionStrategiesResponse> {
	const now = Date.now();
	if (cache && cache.expiresAt > now) return cache.value;

	const metadata = await getDeploymentMetadata();
	const value = projectFromMetadata(metadata);
	cache = { value, expiresAt: now + RUNTIME_CACHE_TTL_MS };
	return value;
}

export async function getPromotionStrategy(name: string): Promise<PromotionStrategy | null> {
	const all = await getPromotionStrategies();
	return all.strategies.find((s) => s.metadata.name === name) ?? null;
}

/**
 * Public for testing: takes an already-fetched DeploymentMetadataResponse and
 * produces the projection. Lets tests inject fixtures without spinning up the
 * hub-inventory fetch path.
 */
export function projectFromMetadata(
	metadata: DeploymentMetadataResponse,
): PromotionStrategiesResponse {
	const inventory = (metadata.inventory.data as { promotionStrategies?: PromoterInventory["promotionStrategies"]; changeTransferPolicies?: PromoterInventory["changeTransferPolicies"]; pullRequests?: PromoterInventory["pullRequests"]; commitStatuses?: PromoterInventory["commitStatuses"] } | null) ?? null;

	const strategiesFromInventory = Array.isArray(inventory?.promotionStrategies)
		? inventory.promotionStrategies
		: [];

	if (strategiesFromInventory.length > 0) {
		return {
			generatedAt: metadata.inventory.fetchedAt ?? metadata.generatedAt,
			source: "hub-inventory",
			strategies: strategiesFromInventory,
			changeTransferPolicies: dedupeByName<ChangeTransferPolicy>(inventory?.changeTransferPolicies ?? []),
			pullRequests: dedupeByName<PullRequest>(inventory?.pullRequests ?? []),
			commitStatuses: dedupeByName<CommitStatus>(inventory?.commitStatuses ?? []),
			error: metadata.inventory.error ?? null,
		};
	}

	const useFixture = !metadata.inventory.sourceUrl;
	if (useFixture) {
		return {
			generatedAt: new Date().toISOString(),
			source: "fixture",
			strategies: FIXTURE_STRATEGIES,
			changeTransferPolicies: [],
			pullRequests: [],
			commitStatuses: [],
			error: null,
		};
	}

	return {
		generatedAt: metadata.inventory.fetchedAt ?? metadata.generatedAt,
		source: "empty",
		strategies: [],
		changeTransferPolicies: [],
		pullRequests: [],
		commitStatuses: [],
		error:
			metadata.inventory.error ??
			"Hub inventory has no `promotionStrategies` payload yet. " +
				"Land the stacks-side `gitops-deployment-inventory` extension to populate this view.",
	};
}

function dedupeByName<T extends { metadata?: { name?: string; namespace?: string } }>(
	items: T[],
): T[] {
	const seen = new Map<string, T>();
	for (const item of items) {
		const key = `${item.metadata?.namespace ?? ""}/${item.metadata?.name ?? ""}`;
		if (key === "/") continue;
		seen.set(key, item);
	}
	return Array.from(seen.values());
}

/**
 * Internal cache reset, used only in tests.
 * @internal
 */
export function __resetCache(): void {
	cache = null;
}
