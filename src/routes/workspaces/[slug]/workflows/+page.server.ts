import { error } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import type {
	WorkspaceWorkflowListItem,
	WorkspaceWorkflowRunSummary,
} from "$lib/server/application/ports";

export type WorkspaceWorkflowRun = WorkspaceWorkflowRunSummary;
export type WorkspaceWorkflowRow = WorkspaceWorkflowListItem;

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.session?.userId) throw error(401, "Authentication required");

	const workflows = await getApplicationAdapters().workflowData.listWorkspaceWorkflowSummaries({
		limit: 100,
		userId: locals.session.userId,
		projectId: locals.session.projectId ?? null,
	});

	return { slug: params.slug, workflows };
};
