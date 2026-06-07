import { error } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { sessions } from "$lib/server/db/schema";
import { isResourceInScope } from "$lib/server/workflows/project-scope";

/**
 * Throw 404 unless `sessionId` exists AND belongs to the caller's workspace
 * (CMA scope contract). The lightweight per-route guard for session sub-routes
 * (config reads/mutations) that don't already go through the lifecycle
 * controller's `inspectDurableRun`. Mirrors the 404-not-403 leak-avoidance of
 * the `/stop` and session DELETE/PATCH routes — a single indexed lookup, no
 * Dapr round-trip.
 */
export async function assertSessionInScope(
	sessionId: string,
	caller: { userId: string; projectId?: string | null } | null | undefined,
): Promise<void> {
	if (!db) throw error(503, "Database not configured");
	const [row] = await db
		.select({ projectId: sessions.projectId, userId: sessions.userId })
		.from(sessions)
		.where(eq(sessions.id, sessionId))
		.limit(1);
	if (!row || !isResourceInScope(row, caller)) {
		throw error(404, "Session not found");
	}
}
