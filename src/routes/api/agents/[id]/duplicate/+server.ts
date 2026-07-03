import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const { agentCatalog } = getApplicationAdapters();
	const result = await agentCatalog.duplicateAgent({
		agentId: params.id,
		userId: locals.session.userId,
		currentProjectId: locals.session.projectId,
		body,
	});
	if (result.status === "not_found") return error(404, result.message);
	return json({ agent: result.agent }, { status: 201 });
};
