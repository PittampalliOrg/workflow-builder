import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

/** Single dev environment detail (project-scoped). Tolerates the provisioning gap.
 * B5 additive: `services` lists EVERY per-service preview row for the execution
 * (a multi-service session has N); `environment` stays the primary row. */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const executionId = params.executionId!;
	const workflowData = getApplicationAdapters().workflowData;
	const environment = await workflowData.getDevEnvironmentOrPending({
		executionId,
		projectId: locals.session.projectId,
	});
	if (!environment) return error(404, "Dev environment not found");
	const groups = await workflowData.listDevEnvironmentGroups({
		projectId: locals.session.projectId,
	});
	const services = groups.find((group) => group.executionId === executionId)
		?.services ?? [environment];
	return json({ environment, services });
};

/** Authenticate at the transport boundary; product teardown policy lives in the application port. */
export const DELETE: RequestHandler = async ({ params, locals, url }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const result = await getApplicationAdapters().devEnvironmentTeardown.teardown({
		executionId: params.executionId!,
		userId: locals.session.userId,
		projectId: locals.session.projectId,
		discardUncaptured:
			url.searchParams.get("discardUncaptured") === "true",
	});
	return json(result.body, { status: result.httpStatus });
};
