import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	createEvaluationDataset,
	listEvaluationDatasets,
} from "$lib/server/evaluations/service";

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return json({ datasets: [] });
	const datasets = await listEvaluationDatasets(locals.session.projectId);
	return json({ datasets });
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) {
		return error(400, "No active workspace - cannot create evaluation dataset");
	}
	const body = asRecord(await request.json().catch(() => ({})));
	const dataset = await createEvaluationDataset({
		projectId: locals.session.projectId,
		userId: locals.session.userId,
		name: String(body.name ?? ""),
		description: typeof body.description === "string" ? body.description : null,
		sourceType: typeof body.sourceType === "string" ? body.sourceType : null,
		sourceUrl: typeof body.sourceUrl === "string" ? body.sourceUrl : null,
		schema: asOptionalRecord(body.schema),
		metadata: asOptionalRecord(body.metadata),
		rows: Array.isArray(body.rows) ? body.rows : [],
	});
	return json({ dataset }, { status: 201 });
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
