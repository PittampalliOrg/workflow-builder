import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	createEvaluationRun,
	listEvaluationRuns,
	markEvaluationRunStatus,
	startEvaluationCoordinator,
	type EvaluationSubjectTypeInput,
} from "$lib/server/evaluations/service";

const SUBJECT_TYPES = new Set(["agent", "workflow", "imported_outputs", "model"]);

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return json({ runs: [] });
	const limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
	const runs = await listEvaluationRuns(locals.session.projectId, limit);
	return json({ runs });
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) {
		return error(400, "No active workspace - cannot create evaluation run");
	}
	const body = asRecord(await request.json().catch(() => ({})));
	const subjectType = SUBJECT_TYPES.has(String(body.subjectType))
		? (String(body.subjectType) as EvaluationSubjectTypeInput)
		: "imported_outputs";
	const run = await createEvaluationRun({
		projectId: locals.session.projectId,
		userId: locals.session.userId,
		evaluationId: String(body.evaluationId ?? ""),
		datasetId: typeof body.datasetId === "string" ? body.datasetId : null,
		rowIds: Array.isArray(body.rowIds)
			? body.rowIds.map((row) => String(row)).filter(Boolean)
			: undefined,
		subjectType,
		subjectId: typeof body.subjectId === "string" ? body.subjectId : null,
		subjectVersion:
			typeof body.subjectVersion === "string" ? body.subjectVersion : null,
		executionConfig: asOptionalRecord(body.executionConfig),
		importedOutputs: body.importedOutputs,
		autoGrade: body.autoGrade !== false,
	});
	let coordinatorStartError: string | null = null;
	if (run && subjectType !== "imported_outputs") {
		try {
			const coordinator = await startEvaluationCoordinator(run.id);
			if (typeof coordinator.executionId === "string") {
				await markEvaluationRunStatus(run.id, "running", {
					coordinatorExecutionId: coordinator.executionId,
				});
				run.coordinatorExecutionId = coordinator.executionId;
				run.status = "running";
			}
		} catch (err) {
			coordinatorStartError = err instanceof Error ? err.message : String(err);
			await markEvaluationRunStatus(run.id, "failed", {
				error: coordinatorStartError,
			});
			run.status = "failed";
			run.error = coordinatorStartError;
		}
	}
	return json({ run, coordinatorStartError }, { status: 201 });
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
