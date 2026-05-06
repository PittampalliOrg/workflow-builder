import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { eq } from "drizzle-orm";
import { validateInternalToken } from "$lib/server/internal-auth";
import { appendEvent } from "$lib/server/sessions/events";
import {
	updateSessionStatus,
	updateSessionStatusUnlessTerminated,
} from "$lib/server/sessions/registry";
import { db } from "$lib/server/db";
import { evaluationRunItems, sessions } from "$lib/server/db/schema";
import { persistCodeCheckpointFromAgentEvent } from "$lib/server/workflows/code-checkpoints";
import { recordEvaluationArtifact } from "$lib/server/evaluations/service";
import { cleanupSessionSandbox } from "$lib/server/sandboxes/provision";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function checkpointRemoteWarning(value: unknown): Record<string, unknown> | null {
	if (!isRecord(value)) return null;
	const remoteStatus = stringOrNull(value.remoteStatus);
	const remoteError = stringOrNull(value.remoteError);
	if (!remoteError) return null;
	if (remoteStatus !== "error" && remoteStatus !== "skipped") return null;
	return {
		remoteStatus,
		remoteError,
		remoteRef: stringOrNull(value.remoteRef),
		toolCallId: stringOrNull(value.toolCallId),
		toolName: stringOrNull(value.toolName),
	};
}

/**
 * Internal endpoint called by `dapr-agent-py`'s session_workflow to persist a
 * CMA-shape session event. Body:
 *   { type: string, data: object, sourceEventId?: string }
 *
 * Server-side assigns the monotonic sequence via `appendEvent`. Concurrent
 * writers serialize via the unique constraint on (session_id, sequence).
 *
 * This is the durability + replay backing for the SSE stream — NATS pub/sub
 * is the real-time transport; this endpoint persists for reconnect replay
 * and for clients that never subscribed.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	if (!validateInternalToken(request)) return error(401, "Unauthorized");
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const type = typeof body.type === "string" ? body.type : "";
	if (!type) return error(400, "type is required");
	const data =
		body.data && typeof body.data === "object"
			? (body.data as Record<string, unknown>)
			: {};
	const sourceEventId =
		typeof body.sourceEventId === "string" ? body.sourceEventId : null;
	// Producer-Id triple stamped by dapr-agent-py event_publisher on every
	// envelope (Tier 3). Persisted for provenance + joined with agents.slug
	// for "events by agent X" aggregation.
	const producerId =
		typeof body.producerId === "string" && body.producerId ? body.producerId : null;
	const producerEpoch =
		typeof body.producerEpoch === "string" && body.producerEpoch
			? body.producerEpoch
			: null;
	const envelope = await appendEvent(params.id, {
		type,
		data,
		sourceEventId,
		producerId,
		producerEpoch,
	});

	// Mirror status events onto the sessions row so list-page filters and
	// the "terminated" UI state work without having to scan event history.
	if (type === "session.status_running") {
		await updateSessionStatusUnlessTerminated(params.id, "running");
	} else if (type === "session.status_idle") {
		const stopReasonData =
			data && typeof data.stop_reason === "object"
				? (data.stop_reason as { type?: string; event_ids?: unknown })
				: null;
		const t = String(stopReasonData?.type ?? "end_turn");
		const normalizedType =
			t === "end_turn" || t === "requires_action" || t === "retries_exhausted"
				? (t as "end_turn" | "requires_action" | "retries_exhausted")
				: "end_turn";
		await updateSessionStatusUnlessTerminated(params.id, "idle", {
			stopReason: stopReasonData
				? {
						type: normalizedType,
						event_ids: Array.isArray(stopReasonData.event_ids)
							? (stopReasonData.event_ids as unknown[]).filter(
									(v): v is string => typeof v === "string",
								)
							: undefined,
					}
				: null,
		});
	} else if (type === "session.status_terminated") {
		await updateSessionStatus(params.id, "terminated", {
			markCompleted: true,
		});
		// Release the per-session OpenShell sandbox. Fire-and-forget — the
		// workspace runtime's TTL pass will reap leaks if this doesn't land.
		// Fires for both UI-provisioned and workflow-provisioned sessions;
		// the cleanup endpoint is idempotent on already-removed sandboxes.
		void cleanupSessionSandbox(params.id);
	} else if (type === "session.status_rescheduled") {
		await updateSessionStatusUnlessTerminated(params.id, "rescheduling");
	}

	// Phase 4 Step 2b: tool_result events may carry a `codeCheckpoint` payload
	// (from dapr-agent-py's run_tool activity). Persist it so the workflow run
	// UI's "checkpoints" tab keeps working. Previously this lived in the
	// deleted agent-stream handler; now it rides on the ingest path.
	if (db && isRecord(data) && isRecord(data.codeCheckpoint)) {
		try {
			const [sessionRow] = await db
				.select({
					workflowExecutionId: sessions.workflowExecutionId,
					parentExecutionId: sessions.parentExecutionId,
					daprInstanceId: sessions.daprInstanceId,
				})
				.from(sessions)
				.where(eq(sessions.id, params.id))
				.limit(1);
			if (sessionRow?.workflowExecutionId) {
				await persistCodeCheckpointFromAgentEvent({
					workflowExecutionId: sessionRow.workflowExecutionId,
					workflowAgentRunId: null,
					parentExecutionId: sessionRow.parentExecutionId ?? null,
					daprInstanceId: sessionRow.daprInstanceId ?? params.id,
					sourceEventId: sourceEventId ?? envelope.id,
					toolName: stringOrNull(data.tool_name) ?? stringOrNull(data.toolName) ?? type,
					nodeId: null,
					payload: data.codeCheckpoint,
				});
				const checkpointWarning = checkpointRemoteWarning(data.codeCheckpoint);
				if (checkpointWarning) {
					const [evalItem] = await db
						.select({
							id: evaluationRunItems.id,
							runId: evaluationRunItems.runId,
						})
						.from(evaluationRunItems)
						.where(eq(evaluationRunItems.workflowExecutionId, sessionRow.workflowExecutionId))
						.limit(1);
					if (evalItem) {
						await recordEvaluationArtifact({
							runId: evalItem.runId,
							runItemId: evalItem.id,
							kind: "logs",
							path: `warnings/code-checkpoint/${sourceEventId ?? envelope.id}.json`,
							content: {
								warning: "Code checkpoint remote push failed",
								checkpoint: checkpointWarning,
							},
							contentType: "application/json",
							metadata: {
								artifactWarning: true,
								source: "code_checkpoint",
							},
						});
					}
				}
			}
		} catch (err) {
			console.warn("[session-ingest] code checkpoint persist failed:", err);
		}
	}

	return json({ event: envelope });
};
