import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { ApplicationEvaluationDatasetError } from "$lib/server/application/evaluation-datasets";

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	try {
		return json(
			await getApplicationAdapters().evaluationDatasets.list({
				projectId: locals.session.projectId,
			}),
		);
	} catch (err) {
		handleEvaluationDatasetError(err);
	}
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) {
		return error(400, "No active workspace - cannot create evaluation dataset");
	}
	try {
		return json(
			await getApplicationAdapters().evaluationDatasets.create({
				projectId: locals.session.projectId,
				userId: locals.session.userId,
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
