import { error, json } from "@sveltejs/kit";

import { getApplicationAdapters } from "$lib/server/application";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	try {
		const isAdmin = await getApplicationAdapters().workflowData.isPlatformAdmin(
			locals.session.userId,
		);
		if (!isAdmin) return error(403, "Admin access required");
	} catch (err) {
		if (err instanceof Error && err.message.includes("Database not configured")) {
			return error(500, "Database not configured");
		}
		throw err;
	}

	const promotions = await getApplicationAdapters().gitOpsPromotions.getStrategies();
	return json(promotions);
};
