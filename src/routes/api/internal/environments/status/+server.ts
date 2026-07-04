import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { requireInternal } from "$lib/server/internal-auth";

export const POST: RequestHandler = async ({ request }) => {
	requireInternal(request);
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body) return error(400, "JSON body required");
	const result = await getApplicationAdapters()
		.benchmarkEnvironmentValidation.getEnvironmentStatus({
		buildId: typeof body.buildId === "string" ? body.buildId : null,
		envSpecHash: typeof body.envSpecHash === "string" ? body.envSpecHash : null,
		environmentKey: typeof body.environmentKey === "string" ? body.environmentKey : null,
	});
	return json(result);
};
