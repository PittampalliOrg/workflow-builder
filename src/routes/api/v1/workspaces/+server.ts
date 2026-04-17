import { error, json } from "@sveltejs/kit";
import { and, eq } from "drizzle-orm";
import type { RequestHandler } from "./$types";
import { db } from "$lib/server/db";
import { projects, projectMembers } from "$lib/server/db/schema";

/**
 * GET /api/v1/workspaces
 *
 * Returns the projects the current user is a member of, in the shape the
 * sidebar switcher expects. Mirrors CMA's workspace dropdown.
 * The slug `default` always resolves to the user's primary project.
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!db) return error(503, "Database not configured");

	const rows = await db
		.select({
			id: projects.id,
			displayName: projects.displayName,
			externalId: projects.externalId,
			role: projectMembers.role,
			createdAt: projects.createdAt,
		})
		.from(projects)
		.innerJoin(
			projectMembers,
			and(
				eq(projectMembers.projectId, projects.id),
				eq(projectMembers.userId, locals.session.userId),
			),
		)
		.orderBy(projects.createdAt);

	return json({
		currentProjectId: locals.session.projectId,
		workspaces: rows.map((r) => ({
			id: r.id,
			slug: r.id === locals.session!.projectId ? "default" : r.externalId,
			displayName: r.displayName,
			externalId: r.externalId,
			role: r.role,
			isCurrent: r.id === locals.session!.projectId,
		})),
	});
};
