import { error, json } from "@sveltejs/kit";
import { and, eq, sql } from "drizzle-orm";
import type { RequestHandler } from "./$types";
import { db } from "$lib/server/db";
import { agents, sessions } from "$lib/server/db/schema";

/**
 * GET /api/v1/vaults/[id]/usages
 *
 * Returns agents that reference this vault in `defaultVaultIds` + the
 * count of active sessions that attached it. Mirrors the "Used by" card
 * pattern on the agent and environment detail pages.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!db) return error(503, "Database not configured");

	const vaultId = params.id;

	const referencingAgents = await db
		.select({
			id: agents.id,
			slug: agents.slug,
			name: agents.name,
			avatar: agents.avatar,
			isArchived: agents.isArchived,
		})
		.from(agents)
		.where(
			and(
				sql`${agents.defaultVaultIds} @> ${JSON.stringify([vaultId])}::jsonb`,
				eq(agents.isArchived, false),
			),
		);

	const [sessionCount] = await db
		.select({ count: sql<number>`count(*)` })
		.from(sessions)
		.where(sql`${sessions.vaultIds} @> ${JSON.stringify([vaultId])}::jsonb`);

	return json({
		agents: referencingAgents.map((a) => ({
			id: a.id,
			slug: a.slug,
			name: a.name,
			avatar: a.avatar ?? null,
			isArchived: a.isArchived,
		})),
		sessionCount: Number(sessionCount?.count ?? 0),
	});
};
