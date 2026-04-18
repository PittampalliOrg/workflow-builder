import type { PageServerLoad } from "./$types";
import { listSessions } from "$lib/server/sessions/registry";
import { db } from "$lib/server/db";
import { users } from "$lib/server/db/schema";
import { eq } from "drizzle-orm";

/**
 * Dashboard home. Greets the user by name + surfaces their five most
 * recent sessions. Unauthenticated callers still land here — they see
 * the CTA cards but an empty recents strip.
 */
export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.session?.userId) {
		return { user: null, recentSessions: [] };
	}

	const [userRow] = db
		? await db
				.select({
					name: users.name,
					email: users.email,
				})
				.from(users)
				.where(eq(users.id, locals.session.userId))
				.limit(1)
		: [];

	const sessions = await listSessions({
		userId: locals.session.userId,
		projectId: locals.session.projectId,
		limit: 5,
	}).catch(() => []);

	return {
		user: userRow
			? {
					name: userRow.name ?? null,
					email: userRow.email ?? null,
				}
			: null,
		recentSessions: sessions.map((s) => ({
			id: s.id,
			title: s.title ?? null,
			status: s.status,
			agentId: s.agentId,
			updatedAt: s.updatedAt,
		})),
	};
};
