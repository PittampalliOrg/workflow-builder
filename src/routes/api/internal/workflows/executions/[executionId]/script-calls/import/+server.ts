/**
 * POST /api/internal/workflows/executions/[executionId]/script-calls/import
 *
 * Internal-only: copy the `done` journal rows of a SOURCE execution into THIS
 * execution for resume-after-edit. Only `done` rows are imported (failed/skipped/
 * null are dropped so an edited script re-runs them); the source session_id is
 * kept (informational). Idempotent (upsert), so orchestrator retries are safe.
 *
 * Body: { fromExecutionId }
 *
 * Auth: requires INTERNAL_API_TOKEN.
 */

import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import { getApplicationAdapters } from "$lib/server/application";

export const POST: RequestHandler = async ({ params, request }) => {
	requireInternal(request);
	const { executionId } = params;
	if (!executionId) return error(400, "executionId required");

	let body: Record<string, unknown>;
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		return error(400, "invalid JSON body");
	}
	const fromExecutionId = body.fromExecutionId;
	if (typeof fromExecutionId !== "string" || !fromExecutionId) {
		return error(400, "fromExecutionId (string) is required");
	}

	try {
		const { imported } = await getApplicationAdapters().scriptCalls.import({
			toExecutionId: executionId,
			fromExecutionId,
		});
		return json({ ok: true, imported });
	} catch (err) {
		const message = err instanceof Error ? err.message : "script-calls import failed";
		if (message === "Database not configured") return error(503, message);
		if ((err as { code?: string })?.code === "23503") {
			return error(404, `execution ${executionId} not found`);
		}
		throw err;
	}
};
