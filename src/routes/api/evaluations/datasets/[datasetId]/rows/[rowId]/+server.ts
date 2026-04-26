import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	deleteEvaluationDatasetRow,
	updateEvaluationDatasetRow,
} from "$lib/server/evaluations/service";

export const PATCH: RequestHandler = async ({ request, params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Evaluation dataset row not found");
	const body = asRecord(await request.json().catch(() => ({})));
	const row = await updateEvaluationDatasetRow({
		projectId: locals.session.projectId,
		datasetId: params.datasetId,
		rowId: params.rowId,
		patch: body,
	});
	return json({ row });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Evaluation dataset row not found");
	const result = await deleteEvaluationDatasetRow({
		projectId: locals.session.projectId,
		datasetId: params.datasetId,
		rowId: params.rowId,
	});
	return json(result);
};

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
