import { error, json } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import type { RequestHandler } from "./$types";
import { validateInternalToken } from "$lib/server/internal-auth";
import { db } from "$lib/server/db";
import { agents, sessions, workflowExecutions, workflows } from "$lib/server/db/schema";
import { createSession } from "$lib/server/sessions/registry";
import { sendUserEvent } from "$lib/server/sessions/events";
import { findOrCreateEphemeralAgent } from "$lib/server/agents/ephemeral";
import { rewriteMcpForBrowserSidecar } from "$lib/server/agents/mcp-sidecar";
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
	const rawAgentConfig =
		body.agentConfig && typeof body.agentConfig === "object"
			? (body.agentConfig as unknown as AgentConfig)
			: null;
	// Apply the per-agent browser sidecar MCP rewrite (same helper that
	// src/lib/server/sessions/spawn.ts uses for direct sessions). Without
	// this, workflow-driven sessions keep the stdio Playwright preset and
	// `npx @playwright/mcp@latest` runs inside the dapr-agent-py container
	// — there's no Chromium binary there. The rewrite routes tools through
	// the in-pod playwright-mcp sidecar at http://localhost:3100/mcp,
	// which talks to the pod's chromium container via CDP.
	//
	// Skip for runtime=browser-use-agent: browser-use manages its own
	// browser via Browserstation and doesn't use an in-pod playwright-mcp
	// sidecar, so the rewrite would mis-route any Playwright preset to a
	// non-existent localhost:3100 endpoint. Mirrors the skip in
	// src/lib/server/agents/registry-sync.ts:752-754.
	const isBrowserUseRuntime =
		rawAgentConfig != null &&
		(rawAgentConfig as { runtime?: unknown }).runtime === "browser-use-agent";
	const agentConfig = rawAgentConfig
		? ({
				...rawAgentConfig,
				mcpServers: isBrowserUseRuntime
					? (rawAgentConfig as { mcpServers?: unknown[] }).mcpServers
					: rewriteMcpForBrowserSidecar(
							(rawAgentConfig as { mcpServers?: unknown[] })
								.mcpServers as never,
						).mcpServers,
			} as AgentConfig)
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
	// Sandbox plumbing — the orchestrator resolves these from the durable/run
	// task spec (workspace_profile output) and forwards them here so
	// session_workflow → agent_workflow can set up runtime.sandbox_name /
	// workspace_ref / cwd. Without this, dapr-agent-py's runtime check fails
	// with "OpenShell sandboxName is required" the first time a tool runs.
	const bridgeWorkspaceRef =
		typeof body.workspaceRef === "string" && body.workspaceRef.trim()
			? body.workspaceRef.trim()
			: null;
	const bridgeSandboxName =
		typeof body.sandboxName === "string" && body.sandboxName.trim()
			? body.sandboxName.trim()
			: null;
	const bridgeCwd =
		typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : null;

	// Per-agent runtime target identity — used to wake the target pod
	// before responding. The orchestrator's resolver stamps these at
	// workflow execute time (see src/lib/server/agents/resolver.ts);
	// the spawn_session activity forwards them here.
	const bodyAgentAppId =
		typeof body.agentAppId === "string" && body.agentAppId.trim()
			? body.agentAppId.trim()
			: null;
	const bodyAgentSlug =
		typeof body.agentSlug === "string" && body.agentSlug.trim()
			? body.agentSlug.trim()
			: null;

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
		try {
			const { syncAgentRuntimeCR } = await import(
				"$lib/server/agents/registry-sync"
			);
			await syncAgentRuntimeCR(existing.agentId);
		} catch (err) {
			console.warn(
				`[ensure-for-workflow] sync runtime for existing session ${sessionId} failed:`,
				err instanceof Error ? err.message : err,
			);
		}
		// Also wake on replay/idempotent hits — the orchestrator's
		// `ctx.call_child_workflow` still needs the target pod live.
		const reuseSlug = await resolveWakeSlug({
			bodyAgentSlug,
			bodyAgentAppId,
			agentConfig,
			agentId: existing.agentId,
		});
		if (reuseSlug) {
			try {
				const { wakeAgentRuntime } = await import("$lib/server/kube/client");
				await wakeAgentRuntime(reuseSlug, 20_000);
			} catch (err) {
				console.warn(
					`[ensure-for-workflow] reuse wake ${reuseSlug} failed, continuing anyway:`,
					err instanceof Error ? err.message : err,
				);
			}
		}
		return json({
			sessionId: existing.id,
			agentId: existing.agentId,
			agentVersion: existing.agentVersion,
			childInput: buildChildInput({
				sessionId: existing.id,
				agentConfig,
				environmentConfig,
				workflowId,
				nodeId,
				vaultIds: Array.isArray(existing.vaultIds) ? existing.vaultIds : vaultIds,
				workflowExecutionId: existing.workflowExecutionId ?? workflowExecutionId,
				initialMessage,
				workspaceRef: bridgeWorkspaceRef,
				sandboxName: bridgeSandboxName ?? existing.sandboxName,
				cwd: bridgeCwd,
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
	await (async () => {
		const { syncAgentRuntimeCR } = await import(
			"$lib/server/agents/registry-sync"
		);
		await syncAgentRuntimeCR(agentId);
	})();

	// Create the session row with the deterministic id. We bypass createSession's
	// auto-id generation by inserting directly, then reuse createSession's
	// defaults via a follow-up lookup. To keep a single code path, we do a
	// direct insert here since createSession doesn't accept a pre-computed id.
	const incomingSandboxName =
		bridgeSandboxName ?? agentConfig.runtime ?? "dapr-agent-py";
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
		sandboxName: incomingSandboxName,
		workflowExecutionId,
		parentExecutionId,
	});

	if (initialMessage && initialMessage.trim()) {
		await sendUserEvent(sessionId, {
			type: "user.message",
			content: [{ type: "text", text: initialMessage }],
		});
	}

	// Wake the target per-agent runtime before responding. The parent workflow
	// will yield `ctx.call_child_workflow("session_workflow", app_id="agent-runtime-<slug>")`
	// immediately after this activity returns. Dapr's CreateWorkflowInstance
	// RPC requires the target app to be registered with placement — if the
	// pod is scaled to 0 the call times out with
	// "the app may not be available: context deadline exceeded" and the
	// orchestrator silently stalls (see durabletask-dapr 0.17.4 behavior).
	// Mirrors the wake call in `src/lib/server/sessions/spawn.ts` for direct
	// (UI-initiated) sessions. Non-blocking: if wake fails we still respond
	// so the orchestrator can surface a proper error on the next yield.
	const wakeSlug = await resolveWakeSlug({
		bodyAgentSlug,
		bodyAgentAppId,
		agentConfig,
		agentId,
	});
	if (wakeSlug) {
		try {
			const { wakeAgentRuntime } = await import("$lib/server/kube/client");
			// Keep the wake budget well below the Python activity's 30s read
			// timeout (spawn_session.py) so we return 200 before the caller
			// abandons the request. A cold 4-container browser-sidecar pod
			// won't always reach phase=Active in 20s — in that case the wake
			// throws ("timeout") but the session row + childInput are still
			// returned so the parent can yield call_child_workflow; Dapr
			// will retry the child-workflow schedule until placement catches
			// up with the pod that keeps warming in the background.
			await wakeAgentRuntime(wakeSlug, 20_000);
		} catch (err) {
			console.warn(
				`[ensure-for-workflow] wake ${wakeSlug} failed, continuing anyway:`,
				err instanceof Error ? err.message : err,
			);
		}
	} else {
		console.warn(
			`[ensure-for-workflow] no agent slug resolved for session ${sessionId}; skipping wake`,
		);
	}

	return json({
		sessionId,
		agentId,
		agentVersion,
		childInput: buildChildInput({
			sessionId,
			agentConfig,
			environmentConfig,
			workflowId,
			nodeId,
			vaultIds,
			workflowExecutionId,
			initialMessage,
			workspaceRef: bridgeWorkspaceRef,
			sandboxName: incomingSandboxName,
			cwd: bridgeCwd,
		}),
		reused: false,
	});
};

function buildChildInput(params: {
	sessionId: string;
	agentConfig: AgentConfig;
	environmentConfig: Record<string, unknown> | null;
	workflowId: string;
	nodeId: string;
	vaultIds: string[];
	workflowExecutionId: string | null;
	initialMessage: string | null;
	workspaceRef?: string | null;
	sandboxName?: string | null;
	cwd?: string | null;
}): Record<string, unknown> {
	return {
		sessionId: params.sessionId,
		agentConfig: params.agentConfig,
		environmentConfig: params.environmentConfig,
		workflowId: params.workflowId,
		nodeId: params.nodeId,
		workflowExecutionId: params.workflowExecutionId,
		vaultIds: params.vaultIds,
		dbExecutionId: params.workflowExecutionId,
		autoTerminateAfterEndTurn: true,
		// Sandbox plumbing — consumed by dapr-agent-py's
		// _freeze_session_child_input so agent_workflow can set
		// runtime.sandbox_name / workspace_ref / cwd. Without these,
		// tools fail with "OpenShell sandboxName is required".
		workspaceRef: params.workspaceRef ?? null,
		sandboxName: params.sandboxName ?? null,
		cwd: params.cwd ?? null,
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

/**
 * Derive the agent slug for the wake call. The slug is the last segment of
 * the per-agent runtime app-id (`agent-runtime-<slug>`) and matches the
 * AgentRuntime CR name.
 *
 * Resolution order (first non-null wins):
 *  1. `body.agentSlug` — stamped by the orchestrator's resolver at workflow
 *     execute time (resolver.ts → inlinedBody.agentSlug) and forwarded here
 *     by spawn_session.py. This is the authoritative source for workflow-
 *     driven sessions.
 *  2. `body.agentAppId` (strip `agent-runtime-` prefix) — same source,
 *     different key.
 *  3. `agentConfig.agentAppId` / `agentConfig.slug` — legacy fields, some
 *     older orchestrator paths embed them in the config.
 *  4. `agents.slug` lookup by `agentId` — covers ephemeral workflow agents
 *     where nothing upstream stamped a slug.
 *
 * Returns null when no slug can be derived; the caller skips wake + logs.
 */
async function resolveWakeSlug(params: {
	bodyAgentSlug: string | null;
	bodyAgentAppId: string | null;
	agentConfig: AgentConfig | null;
	agentId: string | null;
}): Promise<string | null> {
	if (params.bodyAgentSlug) return params.bodyAgentSlug;
	if (
		params.bodyAgentAppId &&
		params.bodyAgentAppId.startsWith("agent-runtime-")
	) {
		return params.bodyAgentAppId.slice("agent-runtime-".length);
	}
	const cfg = params.agentConfig as
		| (AgentConfig & { agentAppId?: unknown; slug?: unknown })
		| null;
	const cfgAppId =
		typeof cfg?.agentAppId === "string" && cfg.agentAppId.trim()
			? cfg.agentAppId.trim()
			: null;
	if (cfgAppId && cfgAppId.startsWith("agent-runtime-")) {
		return cfgAppId.slice("agent-runtime-".length);
	}
	const inlineSlug =
		typeof cfg?.slug === "string" && cfg.slug.trim() ? cfg.slug.trim() : null;
	if (inlineSlug) return inlineSlug;
	if (params.agentId && db) {
		const [row] = await db
			.select({ slug: agents.slug })
			.from(agents)
			.where(eq(agents.id, params.agentId))
			.limit(1);
		if (row?.slug) return row.slug;
	}
	return null;
}
