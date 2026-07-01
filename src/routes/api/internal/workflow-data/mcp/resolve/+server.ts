import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { requireInternal } from "$lib/server/internal-auth";

type ResolveMcpBody = {
	workflowId?: string | null;
	projectId?: string | null;
	requestedServers?: unknown[];
	includeProjectConnections?: boolean;
};

export const POST: RequestHandler = async ({ request }) => {
	requireInternal(request);
	const body = (await request.json().catch(() => null)) as ResolveMcpBody | null;
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return error(400, "JSON object body required");
	}

	const result = await getApplicationAdapters().workflowData.resolveMcpConfig(body);

	return json(result);
};
