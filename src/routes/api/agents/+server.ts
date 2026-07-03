import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const { agentCatalog } = getApplicationAdapters();
	const agents = await agentCatalog.listAgents({
		currentProjectId: locals.session.projectId,
		query: {
			q: url.searchParams.get("q"),
			tag: url.searchParams.get("tag"),
			includeArchived: url.searchParams.get("includeArchived"),
			includeEphemeral: url.searchParams.get("includeEphemeral"),
			projectId: url.searchParams.get("projectId"),
		},
	});
	return json({ agents });
};

export const POST: RequestHandler = async ({ request, url, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const templateSlug = url.searchParams.get("fromTemplate") ?? null;
	const { agentCatalog } = getApplicationAdapters();
	const result = await agentCatalog.createAgent({
		userId: locals.session.userId,
		currentProjectId: locals.session.projectId,
		templateSlug,
		body,
	});
	if (result.status === "invalid") return error(400, result.message);
	return json({ agent: result.agent }, { status: 201 });
};
