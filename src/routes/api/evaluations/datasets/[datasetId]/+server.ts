import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	getEvaluationDataset,
	updateEvaluationDataset,
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
	return json({ dataset });
};

export const PATCH: RequestHandler = async ({ request, params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Evaluation dataset not found");
	const body = asRecord(await request.json().catch(() => ({})));
	const dataset = await updateEvaluationDataset(
		locals.session.projectId,
		params.datasetId,
		body,
	);
	return json({ dataset });
};

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
