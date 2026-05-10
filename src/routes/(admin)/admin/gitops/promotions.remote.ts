/**
 * Remote functions for ad-hoc per-strategy drill-down. The bundled 15-second
 * page poll uses the `/api/v1/gitops/deployment-metadata` and
 * `/api/v1/gitops/promotions` endpoints (admin-gated by Drizzle role lookup);
 * we expose this remote function for future single-strategy reads triggered
 * by user interaction (e.g., open-on-click flows).
 */
import { error } from "@sveltejs/kit";
import { eq } from "drizzle-orm";

import { getRequestEvent, query } from "$app/server";
import { db } from "$lib/server/db";
import { users } from "$lib/server/db/schema";
import { getPromotionStrategy } from "$lib/server/promoter";

async function requireAdmin(): Promise<void> {
	const event = getRequestEvent();
	const userId = event.locals?.session?.userId;
	if (!userId) error(401, "Authentication required");
	if (!db) error(500, "Database not configured");
	const [user] = await db
		.select({ platformRole: users.platformRole })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	if (user?.platformRole !== "ADMIN") error(403, "Admin access required");
}

export const getStrategyDetail = query("unchecked", async (name: string) => {
	await requireAdmin();
	return await getPromotionStrategy(name);
});
