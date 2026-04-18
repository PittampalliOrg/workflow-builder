import { and, eq, or } from "drizzle-orm";
import { db } from "$lib/server/db";
import { projects, projectMembers } from "$lib/server/db/schema";

/**
 * Resolve a URL `[slug]` segment to the authoritative project id, given the
 * caller's userId. Enforces membership — returns null if the slug doesn't
 * map to any project OR the caller isn't in `project_members` for it.
 *
 * The magic slug `default` always maps to the caller's JWT `projectId` (via
 * the `currentProjectId` argument). Any other string resolves via
 * `projects.external_id`.
 *
 * Page loaders under `/workspaces/[slug]/` should call this and 404 on
 * null; API endpoints that accept an explicit `?workspace=` override
 * should do the same.
 */
export async function resolveWorkspaceProjectId(
	slug: string | undefined | null,
	userId: string,
	currentProjectId: string,
): Promise<string | null> {
	if (!slug || slug === "default") {
		// Verify the caller actually has a membership row for their JWT
		// project — defensive against stale tokens referencing a project
		// the user was removed from.
		if (!db) return currentProjectId; // graceful in dev without db
		const [row] = await db
			.select({ projectId: projectMembers.projectId })
			.from(projectMembers)
			.where(
				and(
					eq(projectMembers.projectId, currentProjectId),
					eq(projectMembers.userId, userId),
				),
			)
			.limit(1);
		return row ? row.projectId : null;
	}
	if (!db) return null;
	const [row] = await db
		.select({ projectId: projects.id })
		.from(projects)
		.innerJoin(
			projectMembers,
			and(
				eq(projectMembers.projectId, projects.id),
				eq(projectMembers.userId, userId),
			),
		)
		.where(or(eq(projects.externalId, slug), eq(projects.id, slug)))
		.limit(1);
	return row ? row.projectId : null;
}
