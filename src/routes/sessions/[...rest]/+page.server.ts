import { redirect } from "@sveltejs/kit";
import { and, eq } from "drizzle-orm";

import { DEFAULT_WORKSPACE_SLUG } from "$lib/utils/workspace-path";
import { db } from "$lib/server/db";
import { projects, sessions } from "$lib/server/db/schema";

/**
 * Legacy `/sessions/...` paths (still linked from the workflow run detail
 * page, which isn't workspace-scoped) redirect into the workspace-scoped
 * CMA surface at `/workspaces/<slug>/sessions/...`.
 *
 * Resolution order for the target slug:
 *   1. If the path is `/sessions/<id>` and that session belongs to a
 *      known project, use *that* project's slug — so following a link
 *      from a workflow run takes you to the right workspace regardless
 *      of which one the user is currently "in".
 *   2. Fall back to `DEFAULT_WORKSPACE_SLUG` for paths that aren't a
 *      session-id lookup (e.g., `/sessions/` list) or when the session
 *      can't be resolved.
 */
export const load = async ({ params, url }) => {
	const rest = params.rest ?? "";
	let slug = DEFAULT_WORKSPACE_SLUG;
	const sessionId = rest.split("/")[0];
	if (sessionId && db) {
		try {
			const rows = await db
				.select({ externalId: projects.externalId })
				.from(sessions)
				.innerJoin(projects, eq(projects.id, sessions.projectId))
				.where(and(eq(sessions.id, sessionId)))
				.limit(1);
			if (rows[0]?.externalId) slug = rows[0].externalId;
		} catch {
			// Fall through to the default slug — the workspace guard on
			// the target page will handle the rest.
		}
	}
	throw redirect(308, `/workspaces/${slug}/sessions/${rest}${url.search}`);
};
