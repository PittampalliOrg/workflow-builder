import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { ApplicationEvaluationDatasetError } from "$lib/server/application/evaluation-datasets";

export const GET: RequestHandler = async ({ params, locals, url }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Evaluation dataset not found");
	try {
		return json(
			await getApplicationAdapters().evaluationDatasets.listRows({
				projectId: locals.session.projectId,
				datasetId: params.datasetId,
				limitParam: url.searchParams.get("limit"),
			}),
		);
	} catch (err) {
		handleEvaluationDatasetError(err);
	}
};

export const POST: RequestHandler = async ({ request, params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Evaluation dataset not found");
	try {
		return json(
			await getApplicationAdapters().evaluationDatasets.createRows({
				projectId: locals.session.projectId,
				datasetId: params.datasetId,
				body: await request.json().catch(() => ({})),
			}),
			{ status: 201 },
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
