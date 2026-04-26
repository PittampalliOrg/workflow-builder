import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { importEvaluationDatasetRows } from "$lib/server/evaluations/service";

export const POST: RequestHandler = async ({ request, params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Evaluation dataset not found");
	const contentType = request.headers.get("content-type") ?? "";
	let format: "jsonl" | "json" | "csv" = "jsonl";
	let content = "";
	if (contentType.includes("application/json")) {
		const body = asRecord(await request.json().catch(() => ({})));
		const rawFormat = String(body.format ?? "jsonl");
		format = rawFormat === "csv" || rawFormat === "json" ? rawFormat : "jsonl";
		content = typeof body.content === "string" ? body.content : "";
	} else {
		content = await request.text();
		const rawFormat = new URL(request.url).searchParams.get("format");
		format = rawFormat === "csv" || rawFormat === "json" ? rawFormat : "jsonl";
	}
	if (!content.trim()) return error(400, "Import content is required");
	const rows = await importEvaluationDatasetRows({
		projectId: locals.session.projectId,
		datasetId: params.datasetId,
		format,
		content,
	});
	return json({ rows, imported: rows.length });
};

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
