/**
 * Semantic status filters for pipeline stages — one shared predicate so the
 * graph dim, the list filter, and the filter-chip count badges can never
 * disagree.
 */
import type { PipelineStage } from "./pipeline-types";

export type StageStatusFilter = "failing" | "building" | "drifting" | "promoting";

export const STAGE_STATUS_FILTERS: readonly StageStatusFilter[] = [
	"failing",
	"building",
	"drifting",
	"promoting",
] as const;

export function stageMatchesStatus(stage: PipelineStage, filter: StageStatusFilter): boolean {
	switch (filter) {
		case "failing":
			return (
				stage.health === "Degraded" ||
				stage.build?.phase === "failed" ||
				stage.activity?.failed === true
			);
		case "building":
			return stage.build?.phase === "building";
		case "drifting":
			// Mirrors StageNodeBody's drift derivation + OutOfSync.
			return (
				stage.drift === "pending_rollout" ||
				stage.syncStatus === "OutOfSync" ||
				Boolean(stage.liveTag && stage.desiredTag && stage.liveTag !== stage.desiredTag)
			);
		case "promoting":
			return stage.promotion?.inFlight === true;
	}
}

/** True when the stage matches ANY of the active filters (empty = match all). */
export function stageMatchesAnyStatus(
	stage: PipelineStage,
	filters: readonly StageStatusFilter[],
): boolean {
	if (filters.length === 0) return true;
	return filters.some((f) => stageMatchesStatus(stage, f));
}

export function statusCounts(stages: readonly PipelineStage[]): Record<StageStatusFilter, number> {
	const counts: Record<StageStatusFilter, number> = {
		failing: 0,
		building: 0,
		drifting: 0,
		promoting: 0,
	};
	for (const stage of stages) {
		for (const filter of STAGE_STATUS_FILTERS) {
			if (stageMatchesStatus(stage, filter)) counts[filter] += 1;
		}
	}
	return counts;
}
