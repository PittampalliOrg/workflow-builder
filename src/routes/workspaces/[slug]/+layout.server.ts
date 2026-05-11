import { eq } from "drizzle-orm";
import { error, redirect } from "@sveltejs/kit";
import { db } from "$lib/server/db";
import { projects } from "$lib/server/db/schema";
import type { LayoutServerLoad } from "./$types";
import { resolveWorkspaceProjectId } from "$lib/server/workspaces/resolve";

/**
 * Validates that the URL `[slug]` maps to a project the caller is a member
 * of. Without this, a crafted URL like `/workspaces/someone-elses-slug/agents`
 * would render the page and then any API calls would still return the
 * caller's own data (scoped from JWT's projectId), which is confusing and
 * masks authorization failures. 404 is the defensive response.
 *
 * If the slug doesn't resolve but the caller's `locals.session.projectId`
 * (which the auth hook may have healed against project_members) DOES, we
 * redirect to the canonical workspace path instead of erroring. This
 * recovers users who hold a stale URL after a DB reseed / project move
 * (e.g. coming back from an OAuth callback that bookmarked the old slug).
 *
 * Descendants can read `workspaceProjectId` from the load `data` prop —
 * used by page-load functions and API calls that should scope by the URL
 * slug rather than the JWT default.
 */
export const load: LayoutServerLoad = async ({ params, locals, url }) => {
	if (!locals.session?.userId) throw error(401, "Authentication required");
	const projectId = await resolveWorkspaceProjectId(
		params.slug,
		locals.session.userId,
		locals.session.projectId,
	);
	if (!projectId) {
		// Stale-URL recovery: look up the session's (already-healed) project
		// external_id and redirect the rest of the path onto it.
		if (db && locals.session.projectId) {
			const [project] = await db
				.select({ externalId: projects.externalId })
				.from(projects)
				.where(eq(projects.id, locals.session.projectId))
				.limit(1);
			const fallbackSlug = project?.externalId || locals.session.projectId;
			if (fallbackSlug && fallbackSlug !== params.slug) {
				const suffix = url.pathname.replace(/^\/workspaces\/[^/]+/, "");
				const search = url.search ?? "";
				throw redirect(
					302,
					`/workspaces/${encodeURIComponent(fallbackSlug)}${suffix}${search}`,
				);
			}
		}
		throw error(404, "Workspace not found");
	}
	return {
		slug: params.slug,
		workspaceProjectId: projectId,
	};
};
