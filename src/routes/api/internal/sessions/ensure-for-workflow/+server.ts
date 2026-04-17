import { error, json } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import type { RequestHandler } from "./$types";
import { validateInternalToken } from "$lib/server/internal-auth";
import { db } from "$lib/server/db";
import { sessions, workflowExecutions, workflows } from "$lib/server/db/schema";
import { createSession } from "$lib/server/sessions/registry";
import { sendUserEvent } from "$lib/server/sessions/events";
import { findOrCreateEphemeralAgent } from "$lib/server/agents/ephemeral";
import type { AgentConfig } from "$lib/types/agents";

/**
 * Internal endpoint called by the workflow-orchestrator `spawn_session_for_workflow`
 * activity. Creates (or returns the existing) session row for a workflow
 * `durable/run` node, including the ephemeral agent row that pins the
 * node's inline `agentConfig`.
 *
 * Idempotent: on Dapr activity replay the same `sessionId` is provided,
 * so repeat calls short-circuit to the existing row.
 *
 * Response shape (consumed by the Python activity):
 *   {
 *     sessionId,          // use as Dapr child workflow instance_id
 *     agentId,
 *     agentVersion,
 *     childInput: {...},  // payload for session_workflow
 *   }
 */
export const POST: RequestHandler = async ({ request }) => {
	if (!validateInternalToken(request)) return error(401, "Unauthorized");
	if (!db) return error(503, "Database not configured");

	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const sessionId =
		typeof body.sessionId === "string" && body.sessionId.trim()
			? body.sessionId.trim()
			: null;
	const workflowId =
		typeof body.workflowId === "string" ? body.workflowId : "";
	const nodeId = typeof body.nodeId === "string" ? body.nodeId : "";
	const workflowExecutionId =
		typeof body.workflowExecutionId === "string" ? body.workflowExecutionId : null;
	const parentExecutionId =
		typeof body.parentExecutionId === "string" ? body.parentExecutionId : null;
	let userId = typeof body.userId === "string" ? body.userId : "";
	let projectId = typeof body.projectId === "string" ? body.projectId : null;

	// If userId wasn't passed explicitly, resolve from the workflow execution
	// row. The orchestrator doesn't carry user_id on TaskContext today, so
	// this makes the Python side simpler: it only needs the execution id.
	if (!userId && workflowExecutionId) {
		const [execRow] = await db
			.select({ userId: workflowExecutions.userId, workflowId: workflowExecutions.workflowId })
			.from(workflowExecutions)
			.where(eq(workflowExecutions.id, workflowExecutionId))
			.limit(1);
		if (execRow) {
			userId = execRow.userId;
			if (!projectId) {
				const [wfRow] = await db
					.select({ projectId: workflows.projectId })
					.from(workflows)
					.where(eq(workflows.id, execRow.workflowId))
					.limit(1);
				projectId = wfRow?.projectId ?? null;
			}
		}
	}
	const agentConfig =
		body.agentConfig && typeof body.agentConfig === "object"
			? (body.agentConfig as unknown as AgentConfig)
			: null;
	const environmentConfig =
		body.environmentConfig && typeof body.environmentConfig === "object"
			? (body.environmentConfig as Record<string, unknown>)
			: null;
	const vaultIds = Array.isArray(body.vaultIds)
		? (body.vaultIds as unknown[]).filter(
				(v): v is string => typeof v === "string",
			)
		: [];
	const initialMessage =
		typeof body.initialMessage === "string" ? body.initialMessage : null;
	const title =
		typeof body.title === "string" && body.title.trim()
			? body.title.trim()
			: `Workflow run: ${nodeId || workflowId}`;

	if (!sessionId) return error(400, "sessionId is required");
	if (!workflowId || !nodeId) return error(400, "workflowId and nodeId are required");
	if (!userId) {
		return error(
			400,
			"userId could not be resolved — pass explicit userId or a workflowExecutionId that exists",
		);
	}
	if (!agentConfig) return error(400, "agentConfig is required");

	// Idempotent: if a session with this deterministic id already exists, return it.
	const [existing] = await db
		.select()
		.from(sessions)
		.where(eq(sessions.id, sessionId))
		.limit(1);
	if (existing) {
		return json({
			sessionId: existing.id,
			agentId: existing.agentId,
			agentVersion: existing.agentVersion,
			childInput: buildChildInput({
				sessionId: existing.id,
				agentConfig,
				environmentConfig,
				vaultIds: Array.isArray(existing.vaultIds) ? existing.vaultIds : vaultIds,
				workflowExecutionId: existing.workflowExecutionId ?? workflowExecutionId,
				initialMessage,
			}),
			reused: true,
		});
	}

	// Resolve or create the ephemeral agent + version pinned to this node.
	const { agentId, agentVersion } = await findOrCreateEphemeralAgent({
		workflowId,
		nodeId,
		agentConfig,
		userId,
	});

	// Create the session row with the deterministic id. We bypass createSession's
	// auto-id generation by inserting directly, then reuse createSession's
	// defaults via a follow-up lookup. To keep a single code path, we do a
	// direct insert here since createSession doesn't accept a pre-computed id.
	await db.insert(sessions).values({
		id: sessionId,
		title,
		status: "rescheduling",
		agentId,
		agentVersion,
		environmentId: null,
		environmentVersion: null,
		vaultIds,
		userId,
		projectId: projectId ?? null,
		workflowExecutionId,
		parentExecutionId,
	});

	if (initialMessage && initialMessage.trim()) {
		await sendUserEvent(sessionId, {
			type: "user.message",
			content: [{ type: "text", text: initialMessage }],
		});
	}

	return json({
		sessionId,
		agentId,
		agentVersion,
		childInput: buildChildInput({
			sessionId,
			agentConfig,
			environmentConfig,
			vaultIds,
			workflowExecutionId,
			initialMessage,
		}),
		reused: false,
	});
};

function buildChildInput(params: {
	sessionId: string;
	agentConfig: AgentConfig;
	environmentConfig: Record<string, unknown> | null;
	vaultIds: string[];
	workflowExecutionId: string | null;
	initialMessage: string | null;
}): Record<string, unknown> {
	return {
		sessionId: params.sessionId,
		agentConfig: params.agentConfig,
		environmentConfig: params.environmentConfig,
		vaultIds: params.vaultIds,
		dbExecutionId: params.workflowExecutionId,
		autoTerminateAfterEndTurn: true,
		initialEvents: params.initialMessage
			? [
					{
						type: "user.message",
						content: [{ type: "text", text: params.initialMessage }],
					},
				]
			: [],
	};
}

// Silence "unused import" linter — createSession is reserved for future
// expansion (e.g., when the caller stops pre-computing sessionId).
void createSession;
