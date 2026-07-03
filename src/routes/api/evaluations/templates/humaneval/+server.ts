import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { ApplicationEvaluationTemplateError } from "$lib/server/application/evaluation-templates";

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
	try {
		return json(
			await getApplicationAdapters().evaluationTemplates.createCodeEval({
				projectId: locals.session.projectId,
				userId: locals.session.userId,
				suiteSlug: "humaneval-plus",
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
