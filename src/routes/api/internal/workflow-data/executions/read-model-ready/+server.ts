import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { requireInternal } from "$lib/server/internal-auth";

export const GET: RequestHandler = async ({ request }) => {
	requireInternal(request);
	await getApplicationAdapters().workflowData.assertExecutionReadModelReady();
	return json({ ok: true });
};
