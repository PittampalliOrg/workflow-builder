import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.session?.userId) throw redirect(303, "/auth/sign-in");
	if (!locals.session.projectId) {
		return { activeProject: null };
	}

	const activeProject =
		await getApplicationAdapters().workflowData.getWorkspaceProjectMembershipDetail({
			projectId: locals.session.projectId,
			userId: locals.session.userId,
		});

	return {
		activeProject,
	};
};
