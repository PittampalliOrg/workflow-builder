import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { ApplicationEvaluationTemplateError } from "$lib/server/application/evaluation-templates";

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) {
		return error(400, "No active workspace - cannot create BigCodeBench evaluation");
	}
	try {
		return json(
			await getApplicationAdapters().evaluationTemplates.createCodeEval({
				projectId: locals.session.projectId,
				userId: locals.session.userId,
				suiteSlug: "bigcodebench",
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
