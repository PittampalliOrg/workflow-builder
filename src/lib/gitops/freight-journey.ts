/**
 * Freight journey derivation — "where is this image version?" Per-env rows for
 * a selected freight's warehouse, mirroring Kargo's freight-centric UX (the
 * freightline highlights the stages holding a freight) plus the promoter
 * "heading to" state our model uniquely knows.
 *
 * Pure derivation over the existing PipelineModel — no new API.
 */
import type { PipelineFreight, PipelineModel, PipelineStage } from "./pipeline-types";
import { ENVIRONMENTS, type EnvName } from "./service-matrix";
import { healthVisual } from "./kargo-status";
import { shortSha, shortTag } from "$lib/utils/gitops-display";

export type FreightJourneyState =
	| "deployed" // stage currently holds this freight
	| "promoting" // promoter stage with this (current) freight proposed but not yet active
	| "superseded" // stage runs a NEWER freight of the same warehouse
	| "queued" // stage runs an OLDER freight (this freight hasn't reached it)
	| "dormant"
	| "unknown";

export type FreightJourneyRow = {
	stage: PipelineStage;
	env: EnvName;
	state: FreightJourneyState;
	/** Human detail, e.g. "Healthy", "soak 4m of 10m", "running git-abc1234". */
	detail: string | null;
	/** Timestamp backing the row (deployed rows: stage.updatedAt); render with relativeTime. */
	at: string | null;
};

/** First displayable artifact identity of a freight (image tag, else git sha). */
export function freightArtifactLabel(freight: PipelineFreight): string | null {
	for (const artifact of freight.artifacts) {
		if (artifact.kind === "image" && artifact.tag) return shortTag(artifact.tag);
		if (artifact.kind === "git" && artifact.sha) return shortSha(artifact.sha);
	}
	return null;
}

/**
 * Per-env journey rows for the freight's warehouse, in ENVIRONMENTS order.
 *
 * Newer/older comparisons use the freight's position in the warehouse's freight
 * stream (`model.freights` is built newest→oldest from imageHistory) — index
 * comparison, no date math.
 */
export function buildFreightJourney(
	freight: PipelineFreight,
	model: PipelineModel,
): FreightJourneyRow[] {
	const warehouseFreights = model.freights.filter((f) => f.warehouse === freight.warehouse);
	const freightIdx = warehouseFreights.findIndex((f) => f.id === freight.id);
	const stages = model.stages.filter((s) => s.warehouse === freight.warehouse);

	const rows: FreightJourneyRow[] = [];
	for (const env of ENVIRONMENTS) {
		const stage = stages.find((s) => s.env === env);
		if (!stage) continue;
		rows.push(journeyRow(freight, stage, warehouseFreights, freightIdx));
	}
	return rows;
}

function journeyRow(
	freight: PipelineFreight,
	stage: PipelineStage,
	warehouseFreights: PipelineFreight[],
	freightIdx: number,
): FreightJourneyRow {
	const base = { stage, env: stage.env, at: null as string | null };

	if (freight.inStages.includes(stage.name)) {
		return {
			...base,
			state: "deployed",
			detail: healthVisual(stage.health).label,
			at: stage.updatedAt,
		};
	}

	if (stage.dormant) {
		return { ...base, state: "dormant", detail: null };
	}

	// Heading here: an in-flight promotion on a promoter stage, for the CURRENT
	// freight only. The proposed hydrated sha is the bundle promotion, matched to
	// this freight only via `current` — don't fabricate per-image certainty.
	if (stage.deliveryMode === "promoter" && stage.promotion?.inFlight && freight.current) {
		const promotion = stage.promotion;
		const parts: string[] = [];
		if (promotion.proposedTag) parts.push(`→ ${shortSha(promotion.proposedTag)}`);
		if (promotion.soak) parts.push(`soak ${promotion.soak.label}`);
		else if (promotion.stalledOn) parts.push(`waiting: ${promotion.stalledOn}`);
		return { ...base, state: "promoting", detail: parts.join(" · ") || "promotion in flight" };
	}

	// What freight does this stage hold instead? Lower index = newer.
	const heldIdx = warehouseFreights.findIndex((f) => f.inStages.includes(stage.name));
	if (heldIdx >= 0 && freightIdx >= 0 && heldIdx !== freightIdx) {
		const held = warehouseFreights[heldIdx];
		const heldLabel = freightArtifactLabel(held);
		const detail = heldLabel ? `running ${heldLabel}` : null;
		return heldIdx < freightIdx
			? { ...base, state: "superseded", detail }
			: { ...base, state: "queued", detail };
	}

	return { ...base, state: "unknown", detail: null };
}
