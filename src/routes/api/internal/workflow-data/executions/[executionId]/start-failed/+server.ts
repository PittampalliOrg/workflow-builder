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
	const message =
		typeof body.error === "string" && body.error.trim()
			? body.error.trim()
			: "Workflow execution failed to start";
	await getApplicationAdapters().workflowData.markExecutionStartFailed({
		executionId,
		error: message,
	});
	return json({ ok: true });
};
