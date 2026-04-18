import { error } from "@sveltejs/kit";
import type { LayoutServerLoad } from "./$types";
import { resolveWorkspaceProjectId } from "$lib/server/workspaces/resolve";

/**
 * Validates that the URL `[slug]` maps to a project the caller is a member
 * of. Without this, a crafted URL like `/workspaces/someone-elses-slug/agents`
 * would render the page and then any API calls would still return the
 * caller's own data (scoped from JWT's projectId), which is confusing and
 * masks authorization failures. 404 is the defensive response.
 *
 * Descendants can read `workspaceProjectId` from the load `data` prop —
 * used by page-load functions and API calls that should scope by the URL
 * slug rather than the JWT default.
 */
export const load: LayoutServerLoad = async ({ params, locals }) => {
	if (!locals.session?.userId) throw error(401, "Authentication required");
	const projectId = await resolveWorkspaceProjectId(
		params.slug,
		locals.session.userId,
		locals.session.projectId,
	);
	if (!projectId) throw error(404, "Workspace not found");
	return {
		slug: params.slug,
		workspaceProjectId: projectId,
	};
};
