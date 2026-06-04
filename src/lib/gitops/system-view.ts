/**
 * Promotion-evidence helpers shared by the GitOps pipeline view model
 * (`pipeline-model.ts`). The previous hard-coded single-image pipeline view
 * (`buildGitopsSystemViewModel` + `GitopsPipeline*` types) was superseded by the
 * Kargo-style multi-pipeline model and has been retired.
 */
import { buildPipelineView } from "$lib/promoter/pipeline-view";
import type { PromotionStrategiesResponse } from "$lib/server/promoter/types";

export type SystemTone = "healthy" | "pending" | "failure" | "unknown";

export type SystemPromotionEvidence = {
	name: string;
	tone: SystemTone;
	activeBranch: string | null;
	activeDrySha: string | null;
	activeHydratedSha: string | null;
	pendingChecks: string[];
	failingChecks: string[];
	updatedAt: string | null;
	envBranches: string[];
};

export type SystemCheckEvidence = {
	name: string;
	phase: string | null;
	description: string | null;
	url: string | null;
	branch: string | null;
};

export function summarizePromotion(
	promotions: PromotionStrategiesResponse,
	name: string,
): SystemPromotionEvidence | null {
	const strategy = promotions.strategies.find((candidate) => candidate.metadata.name === name);
	if (!strategy) return null;

	const view = buildPipelineView(strategy, {
		changeTransferPolicies: promotions.changeTransferPolicies,
		pullRequests: promotions.pullRequests,
	});
	const active = view.envs[0]?.active ?? null;
	const allStatuses = view.envs.flatMap((env) => [
		...env.active.commitStatuses,
		...(env.proposed?.commitStatuses ?? []),
	]);

	return {
		name,
		tone: view.overallPhase,
		activeBranch: view.envs[0]?.branch ?? null,
		activeDrySha: active?.dry?.sha ?? null,
		activeHydratedSha: active?.hydrated?.sha ?? null,
		pendingChecks: allStatuses.filter((status) => status.phase === "pending").map((status) => status.key),
		failingChecks: allStatuses.filter((status) => status.phase === "failure").map((status) => status.key),
		updatedAt:
			active?.dry?.commitTime ??
			active?.hydrated?.commitTime ??
			view.envs[0]?.history?.[0]?.endedAt ??
			null,
		envBranches: view.envs.map((env) => env.branch),
	};
}

export function findWorkflowBuilderSoak(
	promotions: PromotionStrategiesResponse,
): SystemCheckEvidence | null {
	for (const status of promotions.commitStatuses) {
		const name = status.metadata.name;
		const specName = status.spec?.name;
		if (name.includes("workflow-builder-soak") || specName === "workflow-builder-soak") {
			return {
				name: "workflow-builder-soak",
				phase: status.status?.phase ?? status.spec?.phase ?? null,
				description: null,
				url: status.spec?.url ?? null,
				branch: status.metadata.labels?.["promoter.argoproj.io/environment"] ?? null,
			};
		}
	}

	const strategy = promotions.strategies.find(
		(candidate) => candidate.metadata.name === "workflow-builder-release",
	);
	for (const environment of strategy?.status?.environments ?? []) {
		const timer =
			environment.proposed?.commitStatuses?.find((status) => status.key === "timer") ??
			environment.active?.commitStatuses?.find((status) => status.key === "timer");
		if (!timer) continue;
		return {
			name: "workflow-builder-soak",
			phase: timer.phase,
			description: timer.description ?? null,
			url: timer.url ?? null,
			branch: environment.branch,
		};
	}

	return null;
}
