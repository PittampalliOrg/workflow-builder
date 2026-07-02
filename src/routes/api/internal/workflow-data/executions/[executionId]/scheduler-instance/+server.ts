import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { requireInternal } from "$lib/server/internal-auth";

export const POST: RequestHandler = async ({ params, request }) => {
	requireInternal(request);
	const executionId = params.executionId?.trim();
	if (!executionId) return error(400, "executionId required");
	const body = await request.json().catch(() => null);
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return error(400, "JSON object body required");
	}
	const instanceId =
		typeof body.instanceId === "string" && body.instanceId.trim()
			? body.instanceId.trim()
			: null;
	if (!instanceId) return error(400, "instanceId required");
	await getApplicationAdapters().workflowData.attachExecutionSchedulerInstance({
		executionId,
		instanceId,
		workflowSessionId:
			typeof body.workflowSessionId === "string" && body.workflowSessionId.trim()
				? body.workflowSessionId.trim()
				: null,
		primaryTraceId:
			typeof body.primaryTraceId === "string" && body.primaryTraceId.trim()
				? body.primaryTraceId.trim()
				: null,
	});
	return json({ ok: true });
};
