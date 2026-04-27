import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	createCodeEvalTemplate,
	parseDatasetImport,
} from "$lib/server/evaluations/service";

// HumanEval+ template route. Mirrors the SWE-bench template pattern: caller
// fetches dataset rows from datasets-server.huggingface.co (or supplies a
// JSONL/JSON/CSV import body) and POSTs them here; we normalize and create
// the dataset + eval definition in one shot. The eval points at the
// "code-eval-item" workflow seeded by scripts/upsert-code-eval-workflow.mjs
// so prompts/maxTurns are editable without redeploying.
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) {
		return error(400, "No active workspace - cannot create HumanEval+ evaluation");
	}
	const body = asRecord(await request.json().catch(() => ({})));
	const rows =
		typeof body.content === "string" && body.content.trim()
			? parseDatasetImport(
					body.content,
					body.format === "json" || body.format === "csv" ? body.format : "jsonl",
				)
			: Array.isArray(body.rows)
				? body.rows
				: undefined;
	const result = await createCodeEvalTemplate({
		projectId: locals.session.projectId,
		userId: locals.session.userId,
		suiteSlug: "humaneval-plus",
		name: typeof body.name === "string" ? body.name : null,
		description: typeof body.description === "string" ? body.description : null,
		graderAgentSlug:
			typeof body.graderAgentSlug === "string" ? body.graderAgentSlug : null,
		rows,
	});
	return json(result, { status: 201 });
};

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
