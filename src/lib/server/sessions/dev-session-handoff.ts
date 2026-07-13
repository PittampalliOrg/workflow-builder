import { getApplicationAdapters } from "$lib/server/application";
import { spawnSessionWorkflow } from "$lib/server/sessions/spawn";

/**
 * Workflow → interactive dev-session handoff (P3).
 *
 * A microservice-dev-session workflow provisions a per-run dev preview + clones
 * the repo into the execution's shared `/sandbox/work`, then calls this to END
 * INTO a persistent interactive coding-agent session bound to that SAME
 * workspace. The user keeps prompting the agent (web terminal / messages API):
 * it edits `repo/`, runs `./sync.sh` to live-sync the preview, inspects, repeats.
 *
 * This is FIRE-AND-FORGET relative to the session's lifetime: it creates the
 * session row, seeds the kickoff prompt, and STARTS the `session_workflow` (which
 * spawnSessionWorkflow does via StartInstance, returning once the pod is ready) —
 * it does NOT `call_child_workflow`, so the parent workflow completes while the
 * session lives on. Direct sessions default to interactive (autoTerminate=false).
 *
 * The session shares the workspace because its row carries
 * `workflowExecutionId = executionId`; spawn.ts maps that to the host's
 * `sharedWorkspaceKey` for controller-owned workspace runtimes (the same
 * `/sandbox/work` subtree the workflow's cliWorkspace nodes used).
 */

const DEV_AGENT_POLICY = Object.freeze({
	slug: "glm-juicefs-builder-agent",
	runtime: "dapr-agent-py-juicefs",
	modelSpec: "zai/glm-5.2",
});

export interface SpawnDevSessionParams {
	executionId: string;
	/** Kickoff prompt: repo path, preview syncUrl, browse URL, the `./sync.sh` hint. */
	instructions: string;
	title?: string | null;
	/**
	 * Keep the agent host alive after the workflow handoff so users can send
	 * follow-up messages. Defaults true for this handoff endpoint.
	 */
	persistent?: boolean;
}

export async function spawnDevSession(
	params: SpawnDevSessionParams,
): Promise<{ sessionId: string; url: string; agentSlug: string }> {
	const created = await getApplicationAdapters().workflowData.createWorkflowDevSession({
		executionId: params.executionId,
		agentPolicy: DEV_AGENT_POLICY,
		instructions: params.instructions,
		title: params.title,
	});
	if (created.status === "execution_not_found") {
		throw new Error(
			`execution ${params.executionId} not found or has no owner (cannot scope the dev session)`,
		);
	}
	if (created.status === "agent_not_found") {
		throw new Error(
			`dev-session agent "${DEV_AGENT_POLICY.slug}" not found — seed it (scripts/seed-workflows.ts)`,
		);
	}
	if (created.status === "agent_policy_mismatch") {
		throw new Error(
			`dev-session agent "${DEV_AGENT_POLICY.slug}" does not match the required preview runtime policy`,
		);
	}

	// Start the interactive session_workflow. Dev handoffs are persistent by
	// default because the parent workflow is handing control to a human-driven
	// session; callers can opt into the old bounded host with persistent:false.
	await spawnSessionWorkflow(created.sessionId, {
		persistentHost: params.persistent !== false,
		requireWorkflowHost: true,
	});

	return {
		sessionId: created.sessionId,
		url: `/sessions/${created.sessionId}`,
		agentSlug: created.agentSlug,
	};
}
