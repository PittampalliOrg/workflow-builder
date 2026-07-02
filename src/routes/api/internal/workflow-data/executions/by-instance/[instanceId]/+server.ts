import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { requireInternal } from "$lib/server/internal-auth";

export const GET: RequestHandler = async ({ params, request }) => {
	requireInternal(request);
	const instanceId = params.instanceId?.trim();
	if (!instanceId) return error(400, "instanceId required");
	const execution = await getApplicationAdapters().workflowData.getExecutionByDaprInstanceId(instanceId);
	return json({ execution });
};
