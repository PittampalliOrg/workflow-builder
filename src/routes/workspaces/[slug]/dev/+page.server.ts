import { getApplicationAdapters } from "$lib/server/application";
import { devPreviewServiceCatalog } from "$lib/server/workflows/dev-environments";
import type { PageServerLoad } from "./$types";

// The seeded fixture's stable id (its `name` is a long display string, so resolve
// by id first; fall back to a name match for hand-authored copies).
const DEV_SESSION_WORKFLOW_ID = "microservice-dev-session";

/**
 * Resolve the launchable service catalog + the seeded `microservice-dev-session`
 * workflow id (the launch engine) for the Dev hub. The grid itself is fetched
 * client-side (polled) from /api/dev-environments.
 */
export const load: PageServerLoad = async ({ locals }) => {
	const services = devPreviewServiceCatalog();
	let devWorkflowId: string | null = null;
	const projectId = locals.session?.projectId;
	if (projectId) {
		devWorkflowId =
			await getApplicationAdapters().workflowData.findProjectWorkflowIdByIdOrNamePrefix({
				projectId,
				workflowId: DEV_SESSION_WORKFLOW_ID,
				namePrefix: "Microservice dev-session%",
			});
	}
	return { services, devWorkflowId, devWorkflowName: DEV_SESSION_WORKFLOW_ID };
};
