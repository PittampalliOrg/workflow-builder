import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { requireInternal } from "$lib/server/internal-auth";

export const GET: RequestHandler = async ({ params, request, url }) => {
	requireInternal(request);
	const workflowRef = params.workflowRef?.trim();
	if (!workflowRef) return error(400, "workflowRef required");

	const lookup = url.searchParams.get("by")?.trim().toLowerCase();
	const workflow = await getApplicationAdapters().workflowData.getWorkflowByRef({
		workflowId: workflowRef,
		workflowName: workflowRef,
		lookup: lookup === "name" || lookup === "id" ? lookup : "auto",
	});

	if (!workflow) return error(404, "Workflow not found");
	return json({ workflow });
};
