import { error, json } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import type { RequestHandler } from "./$types";
import { db } from "$lib/server/db";
import { users } from "$lib/server/db/schema";
import { getAggregateMetrics } from "$lib/server/metrics/aggregate";

/**
 * Aggregate workflow metrics for the admin dashboard.
 *
 * Polled every 5 s by /admin/metrics. Admin-gated because it surfaces
 * cross-workspace counts; the (admin)/+layout.server.ts gate handles
 * the same role check for the page, but we double-check here so the
 * route can't be hit directly by a MEMBER user. platformRole lives on
 * the users row, not on locals.session — see +layout.server.ts.
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!db) return error(503, "Database not configured");
	const [row] = await db
		.select({ platformRole: users.platformRole })
		.from(users)
		.where(eq(users.id, locals.session.userId))
		.limit(1);
	if (row?.platformRole !== "ADMIN") return error(403, "Admin access required");
	const snapshot = await getAggregateMetrics();
	return json(snapshot);
};
