import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { ApplicationEvaluationDatasetError } from "$lib/server/application/evaluation-datasets";

export const PATCH: RequestHandler = async ({ request, params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Evaluation dataset row not found");
	try {
		return json(
			await getApplicationAdapters().evaluationDatasets.updateRow({
				projectId: locals.session.projectId,
				datasetId: params.datasetId,
				rowId: params.rowId,
				body: await request.json().catch(() => ({})),
			}),
		);
	} catch (err) {
		handleEvaluationDatasetError(err);
	}
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Evaluation dataset row not found");
	try {
		return json(
			await getApplicationAdapters().evaluationDatasets.deleteRow({
				projectId: locals.session.projectId,
				datasetId: params.datasetId,
				rowId: params.rowId,
			}),
		);
	} catch (err) {
		handleEvaluationDatasetError(err);
	}
};

function handleEvaluationDatasetError(err: unknown): never {
	if (err instanceof ApplicationEvaluationDatasetError) {
		throw error(err.status, err.message);
	}
	throw err;
}
