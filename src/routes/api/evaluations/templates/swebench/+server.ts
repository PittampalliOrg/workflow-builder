import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { ApplicationEvaluationTemplateError } from "$lib/server/application/evaluation-templates";

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	return json(getApplicationAdapters().evaluationTemplates.listSwebenchSuites());
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) {
		return error(400, "No active workspace - cannot create SWE-bench evaluation");
	}
	try {
		return json(
			await getApplicationAdapters().evaluationTemplates.createSwebench({
				projectId: locals.session.projectId,
				userId: locals.session.userId,
				body: await request.json().catch(() => ({})),
			}),
			{ status: 201 },
		);
	} catch (err) {
		handleEvaluationTemplateError(err);
	}
};

function handleEvaluationTemplateError(err: unknown): never {
	if (err instanceof ApplicationEvaluationTemplateError) {
		throw error(err.status, err.message);
	}
	throw err;
}
