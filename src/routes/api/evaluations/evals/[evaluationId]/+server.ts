import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	getEvaluationDefinition,
	updateEvaluationDefinition,
} from "$lib/server/evaluations/service";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Evaluation not found");
	const evaluation = await getEvaluationDefinition(
		locals.session.projectId,
		params.evaluationId,
	);
	if (!evaluation) return error(404, "Evaluation not found");
	return json({ evaluation });
};

export const PATCH: RequestHandler = async ({ request, params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Evaluation not found");
	const body = asRecord(await request.json().catch(() => ({})));
	const evaluation = await updateEvaluationDefinition({
		projectId: locals.session.projectId,
		evaluationId: params.evaluationId,
		patch: body,
	});
	return json({ evaluation });
};

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
