/**
 * PUT /api/internal/workflows/executions/[executionId]/script-calls/[callId]
 *
 * Internal-only idempotent upsert of one dynamic-script journal row. Written by
 * the orchestrator's `record_script_call_result` activity; Dapr activity retries
 * land on the same composite-PK row → UPSERT (no double-write).
 *
 * Body: { seq, kind?, baseHash?, occurrence?, label?, phase?, promptSha256?,
 *         status, sessionId?, result?, errorCode?, retries?, tokensUsed? }
 *
 * Auth: requires INTERNAL_API_TOKEN.
 */

import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import { getApplicationAdapters } from "$lib/server/application";

export const PUT: RequestHandler = async ({ params, request }) => {
	requireInternal(request);
	const { executionId, callId } = params;
	if (!executionId) return error(400, "executionId required");
	if (!callId) return error(400, "callId required");

	let body: Record<string, unknown>;
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		return error(400, "invalid JSON body");
	}

	if (typeof body.seq !== "number") return error(400, "seq (number) is required");
	if (typeof body.status !== "string") return error(400, "status (string) is required");

	const input = {
		seq: body.seq,
		status: body.status,
		kind: typeof body.kind === "string" ? body.kind : undefined,
		baseHash: (body.baseHash as string | null | undefined) ?? undefined,
		occurrence: typeof body.occurrence === "number" ? body.occurrence : undefined,
		label: (body.label as string | null | undefined) ?? undefined,
		phase: (body.phase as string | null | undefined) ?? undefined,
		promptSha256: (body.promptSha256 as string | null | undefined) ?? undefined,
		sessionId: (body.sessionId as string | null | undefined) ?? undefined,
		result: body.result,
		errorCode: (body.errorCode as string | null | undefined) ?? undefined,
		retries: typeof body.retries === "number" ? body.retries : undefined,
		tokensUsed: typeof body.tokensUsed === "number" ? body.tokensUsed : undefined,
	};

	try {
		const call = await getApplicationAdapters().scriptCalls.upsert(executionId, callId, input);
		return json({ ok: true, call });
	} catch (err) {
		const message = err instanceof Error ? err.message : "script-call write failed";
		if (message === "Database not configured") return error(503, message);
		// FK violation (unknown execution) → 404.
		if ((err as { code?: string })?.code === "23503") {
			return error(404, `execution ${executionId} not found`);
		}
		throw err;
	}
};
