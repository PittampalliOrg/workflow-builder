import { and, eq, like, or } from "drizzle-orm";
import { db } from "$lib/server/db";
import { workflows } from "$lib/server/db/schema";
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
	if (db && projectId) {
		const [row] = await db
			.select({ id: workflows.id })
			.from(workflows)
			.where(
				and(
					eq(workflows.projectId, projectId),
					or(
						eq(workflows.id, DEV_SESSION_WORKFLOW_ID),
						like(workflows.name, "Microservice dev-session%"),
					),
				),
			)
			.limit(1);
		devWorkflowId = row?.id ?? null;
	}
	return { services, devWorkflowId, devWorkflowName: DEV_SESSION_WORKFLOW_ID };
};
