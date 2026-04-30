import { error, json } from "@sveltejs/kit";
import { loadCompareData } from "$lib/server/benchmarks/comparison";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.session?.userId) error(401, "Authentication required");
	if (!locals.session.projectId) error(400, "No active workspace");

	const runsParam = url.searchParams.get("runs") ?? "";
	const runIds = runsParam
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (runIds.length === 0) error(400, "Missing ?runs= parameter");

	const data = await loadCompareData(locals.session.projectId, runIds);
	return json(data);
};
