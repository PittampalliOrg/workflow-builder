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
import { eq } from "drizzle-orm";
import type { RequestHandler } from "./$types";
import { db } from "$lib/server/db";
import { pieceExecution } from "$lib/server/db/schema";
import { requireInternal } from "$lib/server/internal-auth";

export const GET: RequestHandler = async ({ params, request }) => {
	requireInternal(request);
	if (!db) return error(503, "Database not configured");

	const idempotencyKey = params.idempotencyKey?.trim();
	if (!idempotencyKey) return error(400, "idempotencyKey required");

	const rows = await db
		.select()
		.from(pieceExecution)
		.where(eq(pieceExecution.idempotencyKey, idempotencyKey))
		.limit(1);
	const row = rows[0];
	if (!row) return error(404, `piece execution ${idempotencyKey} not found`);

	return json({
		status: row.status,
		result: row.result,
		error: row.error,
		pieceName: row.pieceName,
		actionName: row.actionName,
		// No dedicated completed_at column — updated_at is the terminal-write
		// timestamp once the row reaches completed/failed.
		completedAt:
			row.status === "completed" || row.status === "failed"
				? row.updatedAt
				: null,
	});
};
