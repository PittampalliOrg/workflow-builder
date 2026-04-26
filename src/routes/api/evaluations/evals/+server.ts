import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	createEvaluationDefinition,
	listEvaluations,
} from "$lib/server/evaluations/service";

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return json({ evaluations: [] });
	const evaluations = await listEvaluations(locals.session.projectId);
	return json({ evaluations });
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) {
		return error(400, "No active workspace - cannot create evaluation");
	}
	const body = asRecord(await request.json().catch(() => ({})));
	const evaluation = await createEvaluationDefinition({
		projectId: locals.session.projectId,
		userId: locals.session.userId,
		name: String(body.name ?? ""),
		description: typeof body.description === "string" ? body.description : null,
		datasetId: typeof body.datasetId === "string" ? body.datasetId : null,
		taskConfig: asOptionalRecord(body.taskConfig),
		dataSourceConfig: asOptionalRecord(body.dataSourceConfig),
		testingCriteria: asOptionalRecord(body.testingCriteria),
		metadata: asOptionalRecord(body.metadata),
		graders: Array.isArray(body.graders) ? body.graders : undefined,
	});
	return json({ evaluation }, { status: 201 });
};

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
