/**
 * GET /api/internal/piece-executions/[idempotencyKey]
 *
 * Internal-only read of a `piece_execution` row — the idempotency gate /
 * audit trail / result-offload store written by the piece-runtime's
 * /execute path. Consumers: UI drill-down for offloaded results
 * (`data.artifactRef.kind === "piece_execution"`) and operators inspecting
 * a deduped/retried piece action.
 *
 * Auth: requires INTERNAL_API_TOKEN.
 */

import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { requireInternal } from "$lib/server/internal-auth";

function isDatabaseNotConfigured(err: unknown): boolean {
	return err instanceof Error && err.message.includes("Database not configured");
}

export const GET: RequestHandler = async ({ params, request }) => {
	requireInternal(request);

	const idempotencyKey = params.idempotencyKey?.trim();
	if (!idempotencyKey) return error(400, "idempotencyKey required");

	let row;
	try {
		const { workflowData } = getApplicationAdapters();
		row = await workflowData.getPieceExecutionByIdempotencyKey(idempotencyKey);
	} catch (err) {
		if (isDatabaseNotConfigured(err)) return error(503, "Database not configured");
		throw err;
	}
	if (!row) return error(404, `piece execution ${idempotencyKey} not found`);

	return json({
		status: row.status,
		result: row.result,
		error: row.error,
		pieceName: row.pieceName,
		actionName: row.actionName,
		completedAt: row.completedAt,
	});
};
