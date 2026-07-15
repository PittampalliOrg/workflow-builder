import { error } from "@sveltejs/kit";
import { getApplicationAdapters } from "$lib/server/application";
import type { PageServerLoad } from "./$types";
import { requirePlatformAdmin } from "$lib/server/platform-admin";

export const load: PageServerLoad = async ({ params, locals }) => {
	await requirePlatformAdmin(locals);
	const workflowData = getApplicationAdapters().workflowData;
	const environment = await workflowData.getDevEnvironmentOrPending({
		executionId: params.executionId,
		projectId: locals.session?.projectId ?? null,
	});
	if (!environment) error(404, "Dev environment not found");
	// B5: every per-service preview row for the execution (multi-service session).
	const groups = await workflowData.listDevEnvironmentGroups({
		projectId: locals.session?.projectId ?? null,
	});
	const services =
		groups.find((g) => g.executionId === params.executionId)?.services ?? [environment];
	return { environment, services };
};
