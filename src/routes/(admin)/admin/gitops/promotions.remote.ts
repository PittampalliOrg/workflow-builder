/**
 * Remote functions for ad-hoc per-strategy drill-down. The bundled 15-second
 * page poll uses the `/api/v1/gitops/deployment-metadata` and
 * `/api/v1/gitops/promotions` endpoints (admin-gated by workflow-data);
 * we expose this remote function for future single-strategy reads triggered
 * by user interaction (e.g., open-on-click flows).
 */
import { error } from "@sveltejs/kit";

import { getRequestEvent, query } from "$app/server";
import { getApplicationAdapters } from "$lib/server/application";

async function requireAdmin(): Promise<void> {
	const event = getRequestEvent();
	const userId = event.locals?.session?.userId;
	if (!userId) error(401, "Authentication required");
	const isAdmin = await getApplicationAdapters().workflowData.isPlatformAdmin(userId);
	if (!isAdmin) error(403, "Admin access required");
}

export const getStrategyDetail = query("unchecked", async (name: string) => {
	await requireAdmin();
	return await getApplicationAdapters().gitOpsPromotions.getStrategy(name);
});
