import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { ApplicationEvaluationDefinitionError } from "$lib/server/application/evaluation-definitions";

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	try {
		return json(
			await getApplicationAdapters().evaluationDefinitions.list({
				projectId: locals.session.projectId,
			}),
		);
	} catch (err) {
		handleEvaluationDefinitionError(err);
	}
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) {
		return error(400, "No active workspace - cannot create evaluation");
	}
	try {
		return json(
			await getApplicationAdapters().evaluationDefinitions.create({
				projectId: locals.session.projectId,
				userId: locals.session.userId,
				body: await request.json().catch(() => ({})),
			}),
			{ status: 201 },
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
