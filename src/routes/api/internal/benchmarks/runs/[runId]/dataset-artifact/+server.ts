import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import { getApplicationAdapters } from "$lib/server/application";

export const POST: RequestHandler = async ({ request, params }) => {
	requireInternal(request);
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const path = typeof body.path === "string" ? body.path.trim() : "";
	if (!path) return error(400, "path is required");
	await getApplicationAdapters().benchmarkRouteOperations.upsertDatasetArtifact(
		params.runId,
		path,
	);
	return json({ success: true });
};
