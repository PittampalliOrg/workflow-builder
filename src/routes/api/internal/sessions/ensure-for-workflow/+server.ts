import { error, json } from "@sveltejs/kit";
import { and, eq } from "drizzle-orm";
import type { RequestHandler } from "./$types";
import { validateInternalToken } from "$lib/server/internal-auth";
import { db } from "$lib/server/db";
import {
	agents,
	agentVersions,
	benchmarkRunInstances,
	benchmarkRuns,
	sessions,
	workflowExecutions,
	workflows,
} from "$lib/server/db/schema";
import { createSession } from "$lib/server/sessions/registry";
import { sendUserEvent } from "$lib/server/sessions/events";
import { findOrCreateEphemeralAgent } from "$lib/server/agents/ephemeral";
import { rewriteMcpForBrowserSidecar } from "$lib/server/agents/mcp-sidecar";
import { compilePromptStack } from "$lib/server/prompt-presets";
import type { AgentConfig } from "$lib/types/agents";
import {
	agentRuntimeDedicatedAppId,
	agentRuntimeSlugFromAppId,
} from "$lib/server/agents/runtime-routing";
import {
	extractTraceContext,
	maybeProvisionAgentWorkflowHost,
} from "$lib/server/sessions/agent-workflow-host";

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

	const traceContext = extractTraceContext(request);
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const sessionId =
		typeof body.sessionId === "string" && body.sessionId.trim()
			? body.sessionId.trim()
			: null;
	const workflowId =
		typeof body.workflowId === "string" ? body.workflowId : "";
	const nodeId = typeof body.nodeId === "string" ? body.nodeId : "";
	const nodeName =
		typeof body.nodeName === "string" && body.nodeName.trim()
			? body.nodeName.trim()
			: nodeId;
	const workflowExecutionId =
		typeof body.workflowExecutionId === "string" ? body.workflowExecutionId : null;
	const parentExecutionId =
		typeof body.parentExecutionId === "string" ? body.parentExecutionId : null;
	const benchmarkRunId =
		typeof body.benchmarkRunId === "string" && body.benchmarkRunId.trim()
			? body.benchmarkRunId.trim()
			: null;
	const benchmarkInstanceId =
		typeof body.benchmarkInstanceId === "string" && body.benchmarkInstanceId.trim()
			? body.benchmarkInstanceId.trim()
			: null;
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
	if (benchmarkRunId) {
		const [runState] = await db
			.select({
				runStatus: benchmarkRuns.status,
				instanceStatus: benchmarkRunInstances.status,
				inferenceStatus: benchmarkRunInstances.inferenceStatus,
			})
			.from(benchmarkRuns)
			.leftJoin(
				benchmarkRunInstances,
				and(
					eq(benchmarkRunInstances.runId, benchmarkRuns.id),
					benchmarkInstanceId
						? eq(benchmarkRunInstances.instanceId, benchmarkInstanceId)
						: eq(benchmarkRunInstances.runId, benchmarkRuns.id),
				),
			)
			.where(eq(benchmarkRuns.id, benchmarkRunId))
			.limit(1);
		if (!runState) {
			return error(404, "Benchmark run not found");
		}
		if (
			runState.runStatus !== "queued" &&
			runState.runStatus !== "inferencing"
		) {
			return error(
				409,
				`Benchmark run ${benchmarkRunId} is ${runState.runStatus}; refusing to provision session host`,
			);
		}
		if (
			benchmarkInstanceId &&
			runState.instanceStatus &&
			runState.instanceStatus !== "queued" &&
			runState.instanceStatus !== "inferencing"
		) {
			return error(
				409,
				`Benchmark instance ${benchmarkInstanceId} is ${runState.instanceStatus}; refusing to provision session host`,
			);
		}
		if (
			benchmarkInstanceId &&
			runState.inferenceStatus &&
			runState.inferenceStatus !== "queued" &&
			runState.inferenceStatus !== "inferencing"
		) {
			return error(
				409,
				`Benchmark instance ${benchmarkInstanceId} inference is ${runState.inferenceStatus}; refusing to provision session host`,
			);
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
	const agentConfigAfterMcp = rawAgentConfig
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
	// Resolve Prompt Workbench preset bindings against the project. Workflow
	// runs share the same projectId as the agent's workflow row (resolved
	// above). Fail open: an unresolvable preset must never block a workflow
	// turn.
	const emptyPresetStack = {
		static: [] as string[],
		dynamic: [] as string[],
		staticManifest: [] as Array<{
			promptId: string;
			version: number;
			promptVersionId: string;
			mlflowUri: string | null;
		}>,
		dynamicManifest: [] as Array<{
			promptId: string;
			version: number;
			promptVersionId: string;
			mlflowUri: string | null;
		}>,
	};
	const compiledPresetStack =
		agentConfigAfterMcp && projectId
			? await compilePromptStack(agentConfigAfterMcp, { projectId }).catch(
					(err) => {
						console.warn(
							"[ensure-for-workflow] compilePromptStack failed, continuing with empty stack:",
							err instanceof Error ? err.message : err,
						);
						return emptyPresetStack;
					},
				)
			: emptyPresetStack;
	const agentConfig = agentConfigAfterMcp
		? ({
				...agentConfigAfterMcp,
				compiledStaticPresetSections: compiledPresetStack.static,
				compiledDynamicPresetSections: compiledPresetStack.dynamic,
				// Phase 3a v2: per-ref version-id + mlflow_uri manifest for
				// trace-tag propagation in dapr-agent-py.
				promptPresetManifest: [
					...compiledPresetStack.staticManifest,
					...compiledPresetStack.dynamicManifest,
				],
			} as AgentConfig)
		: null;
	const environmentConfig =
		body.environmentConfig && typeof body.environmentConfig === "object"
			? (body.environmentConfig as Record<string, unknown>)
			: null;
	const instructionBundle =
		body.instructionBundle && typeof body.instructionBundle === "object"
			? (body.instructionBundle as Record<string, unknown>)
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
	const bridgeTimeoutMinutes =
		parsePositiveInteger(body.timeoutMinutes) ??
		parsePositiveInteger(agentConfig?.timeoutMinutes);
	const bridgeMaxIterations =
		parsePositiveInteger(body.maxIterations) ??
		parsePositiveInteger(body.maxTurns) ??
		parsePositiveInteger(agentConfig?.maxTurns);

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
	const bodyAgentId =
		typeof body.agentId === "string" && body.agentId.trim()
			? body.agentId.trim()
			: null;
	const bodyAgentVersion =
		typeof body.agentVersion === "number" && Number.isFinite(body.agentVersion)
			? Math.trunc(body.agentVersion)
			: typeof body.agentVersion === "string" && body.agentVersion.trim()
				? Number.parseInt(body.agentVersion, 10)
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
		const reuseRuntime = await resolveRuntimeIdentity(existing.agentId);
		const reuseAgentAppId =
			reuseRuntime?.appId ??
			bodyAgentAppId ??
			(bodyAgentSlug ? agentRuntimeDedicatedAppId(bodyAgentSlug) : null);
		const reuseWakeSlug = await resolveWakeSlug({
			bodyAgentSlug,
			bodyAgentAppId: reuseAgentAppId,
			agentConfig,
			agentId: existing.agentId,
		});
		const reuseHost = await maybeProvisionAgentWorkflowHost({
			sessionId: existing.id,
			agentConfig,
			workflowExecutionId,
			benchmarkRunId,
			benchmarkInstanceId,
			timeoutMinutes: bridgeTimeoutMinutes,
			traceContext,
		});
		const reuseChildAppId = reuseHost?.agentAppId ?? reuseAgentAppId;
		if (!reuseHost && reuseWakeSlug) {
			try {
				const { wakeAgentRuntime } = await import(
					"$lib/server/kube/client"
				);
				await wakeAgentRuntime(reuseWakeSlug, 20_000);
			} catch (err) {
				console.warn(
					`[ensure-for-workflow] reuse wake ${reuseWakeSlug} failed, continuing anyway:`,
					err instanceof Error ? err.message : err,
				);
			}
		}
		return json({
			sessionId: existing.id,
			agentId: existing.agentId,
			agentVersion: existing.agentVersion,
			agentSlug: reuseRuntime?.slug ?? bodyAgentSlug,
			agentAppId: reuseChildAppId,
			agentHostStatus: reuseHost?.status ?? null,
			childInput: buildChildInput({
				sessionId: existing.id,
				agentConfig,
				instructionBundle,
				environmentConfig,
				workflowId,
				nodeId,
				nodeName,
				vaultIds: Array.isArray(existing.vaultIds) ? existing.vaultIds : vaultIds,
				workflowExecutionId: existing.workflowExecutionId ?? workflowExecutionId,
				initialMessage,
				workspaceRef: bridgeWorkspaceRef,
				sandboxName: bridgeSandboxName ?? existing.sandboxName,
				cwd: bridgeCwd,
				timeoutMinutes: bridgeTimeoutMinutes,
				maxIterations: bridgeMaxIterations,
				agentSlug: reuseRuntime?.slug ?? bodyAgentSlug,
				agentAppId: reuseChildAppId,
			}),
			reused: true,
		});
	}

	// Resolved workflow specs carry the original published agent identity.
	// Use it when present so workflow-driven sessions execute in the published
	// agent-runtime-<slug> pod. Specs without that identity are older inline
	// configs and still get a workflow-scoped ephemeral agent.
	const publishedAgent = await resolvePublishedWorkflowAgent({
		agentId: bodyAgentId,
		agentVersion: bodyAgentVersion,
		projectId,
	});
	const sessionAgent =
		publishedAgent ??
		(await findOrCreateEphemeralAgent({
			workflowId,
			nodeId,
			agentConfig,
			userId,
		}));
	const { agentId, agentVersion } = sessionAgent;
	await (async () => {
		const { syncAgentRuntimeCR } = await import(
			"$lib/server/agents/registry-sync"
		);
		await syncAgentRuntimeCR(agentId);
	})();
	const runtimeIdentity = await resolveRuntimeIdentity(agentId);

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

	// Wake the target runtime before responding. The parent workflow
	// will yield `ctx.call_child_workflow("session_workflow", app_id=<agentAppId>)`
	// immediately after this activity returns. Dapr's CreateWorkflowInstance
	// RPC requires the target app to be registered with placement — if the
	// pod is scaled to 0 the call times out with
	// "the app may not be available: context deadline exceeded" and the
	// orchestrator silently stalls (see durabletask-dapr 0.17.4 behavior).
	// Mirrors the wake call in `src/lib/server/sessions/spawn.ts` for direct
	// (UI-initiated) sessions. Non-blocking: if wake fails we still respond
	// so the orchestrator can surface a proper error on the next yield.
	const targetAgentAppId =
		runtimeIdentity?.appId ??
		bodyAgentAppId ??
		(bodyAgentSlug ? agentRuntimeDedicatedAppId(bodyAgentSlug) : null);
	const sessionHost = await maybeProvisionAgentWorkflowHost({
		sessionId,
		agentConfig,
		workflowExecutionId,
		benchmarkRunId,
		benchmarkInstanceId,
		timeoutMinutes: bridgeTimeoutMinutes,
		traceContext,
	});
	const childAgentAppId = sessionHost?.agentAppId ?? targetAgentAppId;
	const wakeSlug = await resolveWakeSlug({
		bodyAgentSlug,
		bodyAgentAppId: childAgentAppId,
		agentConfig,
		agentId,
	});
	if (sessionHost) {
		console.info(
			`[ensure-for-workflow] provisioned agent workflow host ${sessionHost.agentAppId} for session ${sessionId}`,
		);
	} else if (wakeSlug) {
		try {
			const { wakeAgentRuntime } = await import(
				"$lib/server/kube/client"
			);
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
		agentSlug: runtimeIdentity?.slug ?? bodyAgentSlug,
		agentAppId: childAgentAppId,
		agentHostStatus: sessionHost?.status ?? null,
		childInput: buildChildInput({
			sessionId,
			agentConfig,
			instructionBundle,
			environmentConfig,
			workflowId,
			nodeId,
			nodeName,
			vaultIds,
			workflowExecutionId,
			initialMessage,
			workspaceRef: bridgeWorkspaceRef,
			sandboxName: incomingSandboxName,
			cwd: bridgeCwd,
			timeoutMinutes: bridgeTimeoutMinutes,
			maxIterations: bridgeMaxIterations,
			agentId,
			agentVersion,
			agentSlug: runtimeIdentity?.slug ?? bodyAgentSlug,
			agentAppId: childAgentAppId,
		}),
		reused: false,
	});
};

function buildChildInput(params: {
	sessionId: string;
	agentConfig: AgentConfig;
	instructionBundle?: Record<string, unknown> | null;
	environmentConfig: Record<string, unknown> | null;
	workflowId: string;
	nodeId: string;
	nodeName?: string | null;
	vaultIds: string[];
	workflowExecutionId: string | null;
	initialMessage: string | null;
	workspaceRef?: string | null;
	sandboxName?: string | null;
	cwd?: string | null;
	timeoutMinutes?: number | null;
	maxIterations?: number | null;
	agentId?: string | null;
	agentVersion?: number | null;
	agentSlug?: string | null;
	agentAppId?: string | null;
}): Record<string, unknown> {
	return {
		sessionId: params.sessionId,
		agentId: params.agentId ?? null,
		agentVersion: params.agentVersion ?? null,
		agentConfig: params.agentConfig,
		instructionBundle: params.instructionBundle ?? null,
		agentSlug: params.agentSlug ?? null,
		agentAppId: params.agentAppId ?? null,
		environmentConfig: params.environmentConfig,
		workflowId: params.workflowId,
		nodeId: params.nodeId,
		nodeName: params.nodeName ?? params.nodeId,
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
		timeoutMinutes: params.timeoutMinutes ?? null,
		maxIterations: params.maxIterations ?? null,
		_message_metadata: {
			executionId: params.workflowExecutionId,
			workflowExecutionId: params.workflowExecutionId,
			workflowId: params.workflowId,
			nodeId: params.nodeId,
			nodeName: params.nodeName ?? params.nodeId,
			agentId: params.agentId ?? null,
			agentVersion: params.agentVersion ?? null,
			agentSlug: params.agentSlug ?? null,
			agentAppId: params.agentAppId ?? null,
			sandboxName: params.sandboxName ?? null,
			workspaceRef: params.workspaceRef ?? null,
			cwd: params.cwd ?? null,
			source: "durable/run",
		},
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

function parsePositiveInteger(value: unknown): number | null {
	const numeric =
		typeof value === "number"
			? value
			: typeof value === "string" && value.trim()
				? Number(value)
				: Number.NaN;
	if (!Number.isFinite(numeric) || numeric <= 0) return null;
	return Math.trunc(numeric);
}

// Silence "unused import" linter — createSession is reserved for future
// expansion (e.g., when the caller stops pre-computing sessionId).
void createSession;

async function resolveRuntimeIdentity(
	agentId: string | null,
): Promise<{ slug: string; appId: string } | null> {
	if (!agentId || !db) return null;
	const [row] = await db
		.select({ slug: agents.slug, runtimeAppId: agents.runtimeAppId })
		.from(agents)
		.where(eq(agents.id, agentId))
		.limit(1);
	if (!row?.slug) return null;
	return {
		slug: row.slug,
		appId: row.runtimeAppId ?? agentRuntimeDedicatedAppId(row.slug),
	};
}

async function resolvePublishedWorkflowAgent(params: {
	agentId: string | null;
	agentVersion: number | null;
	projectId: string | null;
}): Promise<{ agentId: string; agentVersion: number } | null> {
	if (!params.agentId || !db) return null;
	const [agent] = await db
		.select({
			id: agents.id,
			projectId: agents.projectId,
			currentVersionId: agents.currentVersionId,
			isArchived: agents.isArchived,
		})
		.from(agents)
		.where(eq(agents.id, params.agentId))
		.limit(1);
	if (!agent || agent.isArchived) {
		throw error(400, `agent ${params.agentId} is not available`);
	}
	if (params.projectId && agent.projectId !== params.projectId) {
		throw error(403, `agent ${params.agentId} is not in this project`);
	}
	const requestedVersion = params.agentVersion;
	if (
		Number.isInteger(requestedVersion) &&
		requestedVersion !== null &&
		requestedVersion > 0
	) {
		const [version] = await db
			.select({ version: agentVersions.version })
			.from(agentVersions)
			.where(
				and(
					eq(agentVersions.agentId, agent.id),
					eq(agentVersions.version, requestedVersion),
				),
			)
			.limit(1);
		if (!version) {
			throw error(
				400,
				`agent ${params.agentId} version ${requestedVersion} is not available`,
			);
		}
		return { agentId: agent.id, agentVersion: version.version };
	}
	if (!agent.currentVersionId) {
		throw error(400, `agent ${params.agentId} has no current version`);
	}
	const [current] = await db
		.select({ version: agentVersions.version })
		.from(agentVersions)
		.where(eq(agentVersions.id, agent.currentVersionId))
		.limit(1);
	if (!current) {
		throw error(400, `agent ${params.agentId} current version is not available`);
	}
	return { agentId: agent.id, agentVersion: current.version };
}

/**
 * Derive the agent slug for the wake call. The slug is the last segment of
 * the per-agent runtime app-id (`agent-runtime-<slug>`) and matches the
 * AgentRuntime CR name.
 *
 * Resolution order (first non-null wins):
 *  1. `body.agentAppId` (strip `agent-runtime-` prefix) — this is the
 *     physical runtime target. For shared pools it differs from agentSlug.
 *  2. `body.agentSlug` — published agent identity, useful for dedicated
 *     runtimes whose app id was not supplied.
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
	const appSlug = agentRuntimeSlugFromAppId(params.bodyAgentAppId);
	if (appSlug) return appSlug;
	if (params.bodyAgentSlug) return params.bodyAgentSlug;
	const cfg = params.agentConfig as
		| (AgentConfig & { agentAppId?: unknown; slug?: unknown })
		| null;
	const cfgAppId =
		typeof cfg?.agentAppId === "string" && cfg.agentAppId.trim()
			? cfg.agentAppId.trim()
			: null;
	const cfgAppSlug = agentRuntimeSlugFromAppId(cfgAppId);
	if (cfgAppSlug) return cfgAppSlug;
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
