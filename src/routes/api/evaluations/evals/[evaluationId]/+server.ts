import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { ApplicationEvaluationDefinitionError } from "$lib/server/application/evaluation-definitions";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Evaluation not found");
	try {
		const result = await getApplicationAdapters().evaluationDefinitions.get({
			projectId: locals.session.projectId,
			evaluationId: params.evaluationId,
		});
		if (!result.evaluation) return error(404, "Evaluation not found");
		return json(result);
	} catch (err) {
		handleEvaluationDefinitionError(err);
	}
};

export const PATCH: RequestHandler = async ({ request, params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Evaluation not found");
	try {
		return json(
			await getApplicationAdapters().evaluationDefinitions.update({
				projectId: locals.session.projectId,
				evaluationId: params.evaluationId,
				body: await request.json().catch(() => ({})),
			}),
		);
	} catch (err) {
		handleEvaluationDefinitionError(err);
	}
};

function handleEvaluationDefinitionError(err: unknown): never {
	if (err instanceof ApplicationEvaluationDefinitionError) {
		throw error(err.status, err.message);
	}
	throw err;
}
