/**
 * Remote read functions for the consolidated GitOps page. Ad-hoc, admin-gated
 * reads triggered by user interaction (drill-downs, manual refresh). The live
 * activity stream stays on the SSE API route (`/api/v1/gitops/events/stream`);
 * these are snapshot reads only — the PR-preview read is resume-safe
 * (`listStatuses()`, never `.status()`), so a browser call cannot kick a
 * pipeline.
 */
import { error } from "@sveltejs/kit";

import { getRequestEvent, query } from "$app/server";
import { mapPrPreviewStatuses } from "$lib/gitops/pr-preview-summary";
import { getApplicationAdapters } from "$lib/server/application";
import { getApplicationAdapterConfig } from "$lib/server/application/config";
import { loadFleetDriftExtras } from "$lib/server/gitops/fleet-drift";
import type { FleetDriftExtras } from "$lib/types/deployment-metadata";

async function requireAdmin(): Promise<void> {
	const event = getRequestEvent();
	const userId = event.locals?.session?.userId;
	if (!userId) error(401, "Authentication required");
	const isAdmin = await getApplicationAdapters().workflowData.isPlatformAdmin(userId);
	if (!isAdmin) error(403, "Admin access required");
}

/** Deployment metadata + promotion strategies in one round-trip. */
export const getGitopsSnapshot = query(async () => {
	await requireAdmin();
	const { gitOpsDeployment, gitOpsPromotions } = getApplicationAdapters();
	const [metadata, promotions] = await Promise.all([
		gitOpsDeployment.getMetadata(),
		gitOpsPromotions.getStrategies(),
	]);
	return { metadata, promotions };
});

/** A page of durable activity events (afterSequence handled by the store). */
export const getActivityEventsPage = query(
	"unchecked",
	async (input: { limit?: number; afterSequence?: number } = {}) => {
		await requireAdmin();
		return await getApplicationAdapters().gitOpsActivityEvents.list({
			limit: input.limit ?? 200,
			afterSequence: input.afterSequence,
		});
	},
);

/** Resume-safe per-PR preview snapshots (flag off → empty). */
export const getPrPreviewStatuses = query(async () => {
	await requireAdmin();
	const config = getApplicationAdapterConfig();
	if (!config.prPreviewsEnabled) return [];
	const statuses = await getApplicationAdapters().prPreviews.listStatuses();
	return mapPrPreviewStatuses(statuses, config.prPreviewRepo);
});

export const getStrategyDetail = query("unchecked", async (name: string) => {
	await requireAdmin();
	return await getApplicationAdapters().gitOpsPromotions.getStrategy(name);
});

/**
 * Fleet-drift extras (additive to the snapshot): repo main HEADs, per-service
 * pin ages, newest built artifacts (+ in-flight PipelineRuns), the
 * preview-platform broker-skew datum, and live Deployment observedGeneration
 * convergence. Cached 15s server-side; degrades to nulls, never throws.
 */
export const getFleetDriftExtras = query(async (): Promise<FleetDriftExtras> => {
	await requireAdmin();
	return loadFleetDriftExtras();
});
