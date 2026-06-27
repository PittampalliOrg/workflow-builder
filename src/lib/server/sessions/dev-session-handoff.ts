import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { workflowExecutions } from "$lib/server/db/schema";
import { getAgentBySlug } from "$lib/server/agents/registry";
import { createSession } from "$lib/server/sessions/registry";
import { sendUserEvent } from "$lib/server/sessions/events";
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
}

export async function spawnDevSession(
	params: SpawnDevSessionParams,
): Promise<{ sessionId: string; url: string; agentSlug: string }> {
	if (!db) throw new Error("Database not configured");
	const [exec] = await db
		.select({
			userId: workflowExecutions.userId,
			projectId: workflowExecutions.projectId,
		})
		.from(workflowExecutions)
		.where(eq(workflowExecutions.id, params.executionId))
		.limit(1);
	if (!exec?.userId) {
		throw new Error(
			`execution ${params.executionId} not found or has no owner (cannot scope the dev session)`,
		);
	}
	const agentSlug = (params.agentSlug || DEFAULT_DEV_AGENT_SLUG).trim();
	const agent = await getAgentBySlug(agentSlug);
	if (!agent) {
		throw new Error(
			`dev-session agent "${agentSlug}" not found — seed it (scripts/seed-workflows.ts)`,
		);
	}

	// workflowExecutionId binds the session to the run AND (via spawn.ts) to the
	// execution's shared /sandbox/work, so the agent sees the cloned repo.
	const session = await createSession({
		agentId: agent.id,
		userId: exec.userId,
		projectId: exec.projectId ?? null,
		workflowExecutionId: params.executionId,
		title: params.title ?? `Dev session (${params.executionId})`,
	});

	// Seed the kickoff BEFORE spawn so spawnSessionWorkflow's listEvents picks it
	// up as the first turn.
	await sendUserEvent(session.id, {
		type: "user.message",
		content: [{ type: "text", text: params.instructions }],
	});

	// Start the interactive session_workflow (bounded wait for the pod to be
	// ready); does not block on the session's lifetime.
	await spawnSessionWorkflow(session.id);

	return { sessionId: session.id, url: `/sessions/${session.id}`, agentSlug };
}
