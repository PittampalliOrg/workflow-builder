import { error, json } from "@sveltejs/kit";
import { eq } from "drizzle-orm";

import { db } from "$lib/server/db";
import { users } from "$lib/server/db/schema";
import { getPromotionStrategies } from "$lib/server/promoter";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!db) return error(500, "Database not configured");

	const [user] = await db
		.select({ platformRole: users.platformRole })
		.from(users)
		.where(eq(users.id, locals.session.userId))
		.limit(1);
	if (user?.platformRole !== "ADMIN") return error(403, "Admin access required");

	const promotions = await getPromotionStrategies();
	return json(promotions);
};
