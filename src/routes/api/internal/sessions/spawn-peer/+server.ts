import { error, json } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import type { RequestHandler } from "./$types";
import { validateInternalToken } from "$lib/server/internal-auth";
import { db } from "$lib/server/db";
import { agents, sessions, users } from "$lib/server/db/schema";
import { createSession } from "$lib/server/sessions/registry";
import { spawnSessionWorkflow } from "$lib/server/sessions/spawn";
import { sendUserEvent } from "$lib/server/sessions/events";

/**
 * Internal endpoint for peer-agent delegation via the `CallAgent` tool
 * on `dapr-agent-py`. The parent agent's tool hits this instead of
 * dispatching a raw Dapr workflow: that way the child gets a real
 * `sessions` row (visible in the UI), proper parent linkage via
 * `parentExecutionId`, and rides the normal spawnSessionWorkflow
 * pipeline (which itself resolves callableAgents for the peer).
 *
 * Idempotent: the caller passes a deterministic `sessionId`
 * (`ca-<uuid>-<slug>`), so on Dapr activity replay a second call with
 * the same id short-circuits to the existing row. The Dapr workflow
 * dispatch is also idempotent (same instance id).
 *
 * Body:
 *   {
 *     sessionId: string,          // deterministic, ≤64 chars
 *     peerAgentId: string,        // DB id of the peer agent
 *     prompt: string,             // initialMessage for the child
 *     parentSessionId?: string,   // for lineage (stored as parentExecutionId)
 *     parentInstanceId?: string,  // Dapr workflow instance of parent
 *     title?: string,
 *   }
 *
 * Response:
 *   { sessionId, agentId, agentVersion, daprInstanceId, natsSubject, reused }
 */
export const POST: RequestHandler = async ({ request }) => {
	if (!validateInternalToken(request))
		return error(401, "Unauthorized");
	if (!db) return error(503, "Database not configured");

	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const sessionId =
		typeof body.sessionId === "string" && body.sessionId.trim()
			? body.sessionId.trim()
			: null;
	const peerAgentId =
		typeof body.peerAgentId === "string" ? body.peerAgentId.trim() : "";
	const prompt =
		typeof body.prompt === "string" ? body.prompt : "";
	const parentSessionId =
		typeof body.parentSessionId === "string" ? body.parentSessionId : null;
	const parentInstanceId =
		typeof body.parentInstanceId === "string" ? body.parentInstanceId : null;
	const title =
		typeof body.title === "string" && body.title.trim()
			? body.title.trim()
			: null;

	if (!sessionId) return error(400, "sessionId is required");
	if (!peerAgentId) return error(400, "peerAgentId is required");
	if (sessionId.length > 64)
		return error(400, "sessionId must be ≤64 chars (Dapr workflow cap)");

	// Idempotency — return the existing row on replay.
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
			daprInstanceId: existing.daprInstanceId,
			natsSubject: existing.natsSubject,
			reused: true,
		});
	}

	// Inherit userId + projectId from the parent session (if it exists and
	// is visible in DB) or from the peer agent's owner as a fallback. For
	// CallAgent spawns the parent is always a CMA session row, so the
	// parentSessionId path is the common case.
	let userId = "";
	let projectId: string | null = null;
	if (parentSessionId) {
		const [parentRow] = await db
			.select({
				userId: sessions.userId,
				projectId: sessions.projectId,
			})
			.from(sessions)
			.where(eq(sessions.id, parentSessionId))
			.limit(1);
		if (parentRow) {
			userId = parentRow.userId;
			projectId = parentRow.projectId;
		}
	}
	if (!userId) {
		// Fall back to the peer agent's creator/owner. This matches how
		// ensure-for-workflow resolves userId when the workflow execution
		// doesn't carry one. Guarantees FK integrity on sessions.user_id.
		const [peerRow] = await db
			.select({
				createdBy: agents.createdBy,
				projectId: agents.projectId,
			})
			.from(agents)
			.where(eq(agents.id, peerAgentId))
			.limit(1);
		if (!peerRow) return error(404, `Peer agent ${peerAgentId} not found`);
		if (!peerRow.createdBy) {
			// Final fallback: any admin user. Extremely rare — would only
			// hit if a peer was inserted without createdBy.
			const [anyUser] = await db
				.select({ id: users.id })
				.from(users)
				.limit(1);
			userId = anyUser?.id ?? "";
		} else {
			userId = peerRow.createdBy;
		}
		projectId = projectId ?? peerRow.projectId;
	}
	if (!userId)
		return error(500, "could not resolve userId for peer session");

	const session = await createSession({
		id: sessionId,
		agentId: peerAgentId,
		title: title ?? `Delegated: ${prompt.slice(0, 40)}`,
		userId,
		projectId,
		parentExecutionId: parentInstanceId ?? parentSessionId ?? null,
		// Peer spawns go through the default dapr-agent-py. A future
		// enhancement could honor the peer's `runtime` column to route to
		// dapr-agent-py-testing when explicitly opted in.
	});

	if (prompt.trim()) {
		await sendUserEvent(session.id, {
			type: "user.message",
			content: [{ type: "text", text: prompt }],
		});
	}

	try {
		const { instanceId, natsSubject } = await spawnSessionWorkflow(
			session.id,
		);
		return json({
			sessionId: session.id,
			agentId: session.agentId,
			agentVersion: session.agentVersion,
			daprInstanceId: instanceId,
			natsSubject,
			reused: false,
		});
	} catch (spawnErr) {
		// Row already exists; the caller will get a sessionId they can
		// poll. They can also retry via POST /api/v1/sessions/[id]/spawn.
		return json(
			{
				sessionId: session.id,
				agentId: session.agentId,
				agentVersion: session.agentVersion,
				daprInstanceId: null,
				natsSubject: null,
				reused: false,
				error:
					spawnErr instanceof Error
						? spawnErr.message
						: "Workflow spawn failed",
			},
			{ status: 202 },
		);
	}
};
