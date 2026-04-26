import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	createEvaluationDatasetRows,
	getEvaluationDataset,
} from "$lib/server/evaluations/service";

export const GET: RequestHandler = async ({ params, locals, url }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Evaluation dataset not found");
	const limit = Number.parseInt(url.searchParams.get("limit") ?? "500", 10);
	const dataset = await getEvaluationDataset(
		locals.session.projectId,
		params.datasetId,
		limit,
	);
	return json({ rows: dataset.rows ?? [] });
};

export const POST: RequestHandler = async ({ request, params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Evaluation dataset not found");
	const body = await request.json().catch(() => ({}));
	const rows = await createEvaluationDatasetRows(
		locals.session.projectId,
		params.datasetId,
		Array.isArray(body) ? body : [body],
	);
	return json({ rows }, { status: 201 });
};
