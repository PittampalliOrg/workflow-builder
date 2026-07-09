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
 * `sharedWorkspaceKey` for interactive-cli runtimes (same `/sandbox/work` subtree
 * the workflow's cliWorkspace nodes used).
 */

const DEFAULT_DEV_AGENT_SLUG = "cli-dev-agent";

export interface SpawnDevSessionParams {
	executionId: string;
	/** Kickoff prompt: repo path, preview syncUrl, browse URL, the `./sync.sh` hint. */
	instructions: string;
	/** claude-code-cli agent slug (persona). Default `cli-dev-agent`. */
	agentSlug?: string | null;
	title?: string | null;
	/**
	 * Keep the CLI host alive after the workflow handoff so users can send
	 * follow-up messages. Defaults true for this handoff endpoint.
	 */
	persistent?: boolean;
}

export async function spawnDevSession(
	params: SpawnDevSessionParams,
): Promise<{ sessionId: string; url: string; agentSlug: string }> {
	const agentSlug = (params.agentSlug || DEFAULT_DEV_AGENT_SLUG).trim();
	const created = await getApplicationAdapters().workflowData.createWorkflowDevSession({
		executionId: params.executionId,
		agentSlug,
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
			`dev-session agent "${agentSlug}" not found — seed it (scripts/seed-workflows.ts)`,
		);
	}

	// Start the interactive session_workflow. Dev handoffs are persistent by
	// default because the parent workflow is handing control to a human-driven
	// session; callers can opt into the old bounded host with persistent:false.
	await spawnSessionWorkflow(created.sessionId, {
		persistentHost: params.persistent !== false,
	});

	return {
		sessionId: created.sessionId,
		url: `/sessions/${created.sessionId}`,
		agentSlug: created.agentSlug,
	};
}
