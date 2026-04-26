import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import { recordEvaluationArtifact } from "$lib/server/evaluations/service";
import type { EvaluationArtifactKind } from "$lib/server/db/schema";

const ARTIFACT_KINDS = new Set([
	"dataset_import",
	"generated_output",
	"grader_result",
	"external_harness",
	"logs",
	"report",
	"predictions_jsonl",
]);

export const POST: RequestHandler = async ({ request, params }) => {
	requireInternal(request);
	const body = asRecord(await request.json().catch(() => ({})));
	const kind = String(body.kind ?? "");
	if (!ARTIFACT_KINDS.has(kind)) return error(400, "Invalid artifact kind");
	const artifact = await recordEvaluationArtifact({
		runId: params.runId,
		runItemId: typeof body.runItemId === "string" ? body.runItemId : null,
		kind: kind as EvaluationArtifactKind,
		path: typeof body.path === "string" ? body.path : null,
		content: body.content,
		contentType: typeof body.contentType === "string" ? body.contentType : null,
		metadata: asOptionalRecord(body.metadata),
	});
	return json({ success: true, artifact });
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
