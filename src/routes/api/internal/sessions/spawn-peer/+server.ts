import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { validateInternalToken } from "$lib/server/internal-auth";
import { spawnSessionWorkflow } from "$lib/server/sessions/spawn";

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

	const skipSpawnOnReplay = body.skipSpawn === true;
	const skipSpawn = body.skipSpawn === true;
	const { workflowData } = getApplicationAdapters();

	const ensureResult = await workflowData.ensurePeerSession({
		sessionId,
		peerAgentId,
		prompt,
		parentSessionId,
		parentInstanceId,
		title,
	});
	if (!ensureResult.ok) {
		return error(ensureResult.status, ensureResult.message);
	}
	const session = ensureResult.session;
	const base = {
		sessionId: session.id,
		agentId: session.agentId,
		agentVersion: session.agentVersion,
		daprInstanceId: session.daprInstanceId,
		natsSubject: session.natsSubject,
		reused: ensureResult.reused,
	};

	if (ensureResult.reused && !skipSpawnOnReplay) {
		return json(base);
	}

	if (skipSpawn) {
		const dispatch = await workflowData.resolvePeerAgentDispatchContext({
			agentId: session.agentId,
			agentVersion: session.agentVersion,
			environmentId: session.environmentId,
			environmentVersion: session.environmentVersion,
		});
		if (!dispatch)
			return error(500, `could not re-resolve peer ${session.agentId}`);
		return json({
			...base,
			agentConfig: dispatch.agentConfig,
			environmentConfig: dispatch.environmentConfig,
			vaultIds: session.vaultIds,
			callableAgents: dispatch.callableAgents,
			registryTeam: dispatch.registryTeam,
			skipSpawn: true,
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
