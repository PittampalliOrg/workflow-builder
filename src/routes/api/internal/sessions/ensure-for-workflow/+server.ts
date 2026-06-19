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
	type Session,
	workflowExecutions,
	workflows,
} from "$lib/server/db/schema";
import {
	addResource,
	createSession,
	listResources,
} from "$lib/server/sessions/registry";
import { mountSessionRepositories } from "$lib/server/sessions/repositories";
import { appendEvent, sendUserEvent } from "$lib/server/sessions/events";
import { findOrCreateEphemeralAgent } from "$lib/server/agents/ephemeral";
import { rewriteMcpForBrowserSidecar } from "$lib/server/agents/mcp-sidecar";
import {
	getRuntimeDescriptor,
	type RuntimeDescriptor,
} from "$lib/server/agents/runtime-registry";
import { evaluateSwap } from "$lib/server/agents/swap-safety";
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
import {
	type MlflowRunContext,
	registerAgentVersionInMlflow,
	safeCreateWorkflowAgentMlflowRun,
} from "$lib/server/observability/mlflow-lifecycle";
import { getUserCliCredential } from "$lib/server/users/cli-credentials";
import {
	provisionSessionSandboxWithRetry,
	sandboxProvisionFailureMessage,
} from "$lib/server/sandboxes/provision";
import { createOrReplaceGoal, getCurrentGoal } from "$lib/server/goals/repo";
import {
	decideGoalHarness,
	runtimeHasNativeGoalHarness,
} from "$lib/server/sessions/runtime-target";
import {
	ensureGoalMcpServer,
	stampGoalMcpSessionHeader,
} from "$lib/server/goals/mcp-wiring";

type PublishedWorkflowAgent = {
	agentId: string;
	agentVersion: number;
	agentSlug: string | null;
	agentAppId: string | null;
	mlflowUri: string | null;
	mlflowModelName: string | null;
	mlflowModelVersion: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
	const bodyBenchmarkExecutionClass =
		typeof body.benchmarkExecutionClass === "string" &&
		body.benchmarkExecutionClass.trim()
			? body.benchmarkExecutionClass.trim()
			: null;
	let benchmarkExecutionClass = bodyBenchmarkExecutionClass;
	let userId = typeof body.userId === "string" ? body.userId : "";
	let projectId = typeof body.projectId === "string" ? body.projectId : null;
	const incomingMlflowContext = parseMlflowContext(body.mlflowContext);

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
				summary: benchmarkRuns.summary,
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
		if (!benchmarkExecutionClass) {
			const summary = isRecord(runState.summary) ? runState.summary : {};
			const execution = isRecord(summary.execution) ? summary.execution : {};
			benchmarkExecutionClass =
				typeof execution.class === "string" && execution.class.trim()
					? execution.class.trim()
					: null;
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
	// `let`, not `const`: an OpenShell-needing runtime (dapr-agent-py) with no
	// wired sandbox gets one auto-provisioned below, reassigned into these so all
	// downstream childInput/insert sites pick it up.
	let bridgeWorkspaceRef =
		typeof body.workspaceRef === "string" && body.workspaceRef.trim()
			? body.workspaceRef.trim()
			: null;
	let bridgeSandboxName =
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

	// Optional goal-driven mode: a {objective, tokenBudget?, maxIterations?} block
	// turns this into a multi-turn run that loops toward the objective until
	// session.goal_completed (custom-loop runtimes drive the BFF goal loop + goal
	// MCP; native-goal CLIs inject `/goal`). Presence of a non-empty objective ⇒
	// goal mode.
	const bridgeGoal = parseGoalSpec(body.goal);
	const goalMode = bridgeGoal !== null;

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

	// Swap-safety gate for the durable/run (workflow + SWE-bench) path — mirrors
	// the direct-spawn gate in sessions/spawn.ts. Warn/reject when the dispatched
	// runtime would drop a capability the agent config relies on (e.g. an
	// unsupported model provider, or MCP on a non-MCP runtime). WARN-first; only
	// rejects when AGENT_RUNTIME_REJECT_LOSSY_SWAP is set, returning 409 so the
	// orchestrator's spawn_session activity fails the durable/run cleanly.
	const swapTarget = getRuntimeDescriptor(
		(agentConfig as { runtime?: string }).runtime,
	);
	// Goal-harness decision (evaluator is the DEFAULT for every runtime; native
	// `/goal` is opt-in via a `/goal ` prefix on the objective, honored only on
	// runtimes that have a native harness — claude/codex). decideGoalHarness also
	// strips the prefix so the cleaned objective is reused in either mode.
	const rawGoalObjective = bridgeGoal?.objective ?? "";
	const harness =
		goalMode && bridgeGoal
			? decideGoalHarness(
					rawGoalObjective,
					runtimeHasNativeGoalHarness(swapTarget ?? null),
				)
			: { native: false, objective: rawGoalObjective };
	const nativeGoal = goalMode && harness.native;
	// Evaluator mode = the BFF custom loop (thread_goals row + continuation driver
	// + goal MCP + evaluator-gated completion). The new default for ALL runtimes.
	const evaluatorGoal = goalMode && !nativeGoal;
	// Cleaned goal used downstream (prefix stripped) for the row + the native kickoff.
	const effectiveBridgeGoal =
		bridgeGoal && goalMode
			? { ...bridgeGoal, objective: harness.objective }
			: bridgeGoal;
	const baseDispatchAgentConfig: AgentConfig = stampCliAdapterForDispatch(
		agentConfig,
		swapTarget,
	);
	// Evaluator-mode goal sessions auto-wire the goal MCP server (+ session
	// header) so the agent can call update_goal to self-complete — same helper the
	// direct-spawn path uses. (Single-shot + native-`/goal` runs are untouched.)
	const dispatchAgentConfig: AgentConfig = evaluatorGoal
		? ({
				...baseDispatchAgentConfig,
				mcpServers: stampGoalMcpSessionHeader(
					ensureGoalMcpServer(
						(baseDispatchAgentConfig as { mcpServers?: unknown[] }).mcpServers ?? [],
						swapTarget?.capabilities?.supportsMcp ?? false,
						false,
					),
					sessionId,
				),
			} as AgentConfig)
		: baseDispatchAgentConfig;
	// Goal-mode sessions run multi-turn (no auto-terminate) capped by the goal's
	// maxIterations; native-`/goal` runs get the objective as a `/goal` kickoff.
	const effectiveMaxIterations = goalMode
		? bridgeGoal?.maxIterations ?? bridgeMaxIterations
		: bridgeMaxIterations;
	const effectiveInitialMessage =
		nativeGoal && effectiveBridgeGoal
			? `/goal ${effectiveBridgeGoal.objective}`
			: initialMessage;

	// Auto-provision a per-session OpenShell sandbox for runtimes that USE the
	// external OpenShell tools but don't own a sandbox (dapr-agent-py) when the
	// workflow didn't wire one (no sandboxName, no ws_ workspaceRef). Mirrors the
	// direct-UI-session path so a bare agent node "just works" instead of failing
	// every tool with "sandbox not found". Explicit workspace/profile steps (e.g.
	// the 3Blue1Brown demo, which SHARE a sandbox across agent + browser/validate
	// + preview) still take precedence. Idempotent by executionId=sessionId, and
	// cleaned up on session-end via cleanupSessionSandbox.
	const needsOpenShellSandbox =
		swapTarget?.capabilities?.supportsBuiltinOpenShellTools === true &&
		swapTarget?.capabilities?.ownsSandbox === false &&
		swapTarget?.family === "durable-session";
	const hasWiredSandbox =
		!!bridgeSandboxName ||
		(!!bridgeWorkspaceRef && bridgeWorkspaceRef.startsWith("ws_"));
	if (needsOpenShellSandbox && !hasWiredSandbox) {
		try {
			const autoSandbox = await provisionSessionSandboxWithRetry({
				executionId: sessionId,
				name: title,
				sandboxTemplate:
					typeof (agentConfig as { sandboxTemplate?: unknown }).sandboxTemplate ===
					"string"
						? ((agentConfig as { sandboxTemplate?: string })
								.sandboxTemplate as string)
						: "base",
				keepAfterRun: true,
			});
			bridgeSandboxName = autoSandbox.sandboxName;
			bridgeWorkspaceRef = autoSandbox.workspaceRef ?? bridgeWorkspaceRef;
			console.log(
				`[ensure-for-workflow] auto-provisioned OpenShell sandbox ${autoSandbox.sandboxName} for ${swapTarget?.id} session ${sessionId}`,
			);
		} catch (err) {
			return error(503, sandboxProvisionFailureMessage(err));
		}
	}
	const swapVerdict = swapTarget
		? evaluateSwap(dispatchAgentConfig as Record<string, unknown>, swapTarget)
		: null;
	if (swapTarget && swapVerdict && swapVerdict.drops.length > 0) {
		console.warn(
			`[swap-safety] workflow session ${sessionId} -> runtime "${swapTarget.id}" ${swapVerdict.decision}: ` +
				swapVerdict.drops.map((d) => `${d.capability}(${d.severity})`).join(", "),
		);
		for (const d of swapVerdict.drops) console.warn(`[swap-safety]   ${d.detail}`);
		if (swapVerdict.decision === "reject") {
			return error(
				409,
				`Runtime "${swapTarget.id}" cannot satisfy required agent capabilities: ` +
					swapVerdict.drops
						.filter((d) => d.severity === "reject")
						.map((d) => d.detail)
						.join("; "),
			);
		}
	}
	const workflowSessionSecretEnv = await resolveWorkflowSessionSecretEnv({
		userId,
		runtimeDescriptor: swapTarget,
	});

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
			agentConfig: dispatchAgentConfig,
			agentId: existing.agentId,
		});
		const reuseHost = await maybeProvisionAgentWorkflowHost({
			sessionId: existing.id,
			agentConfig: dispatchAgentConfig,
			workflowExecutionId,
			benchmarkRunId,
			benchmarkInstanceId,
			benchmarkExecutionClass,
			timeoutMinutes: bridgeTimeoutMinutes,
			traceContext,
			sessionSecretEnv: workflowSessionSecretEnv,
			// interactive-cli: share one JuiceFS workspace subtree across every
			// CLI pod of this workflow run (planner/generator/critic see the same
			// files). Keyed on the durable/run workspaceRef, falling back to the
			// execution id so CLI workflows share automatically with no
			// workspace/profile node. No-op for classes without the shared store.
			sharedWorkspaceKey: swapTarget?.capabilities?.interactiveTerminal
				? (bridgeWorkspaceRef ?? workflowExecutionId)
				: null,
		});
		const reuseChildAppId = reuseHost?.agentAppId ?? reuseAgentAppId;
		const reuseRuntimeSandboxName =
			reuseHost?.sandboxName ?? existing.runtimeSandboxName ?? null;
		if (reuseChildAppId) {
			await db
				.update(sessions)
				.set({
					runtimeAppId: reuseChildAppId,
					runtimeSandboxName: reuseRuntimeSandboxName,
					updatedAt: new Date(),
				})
				.where(eq(sessions.id, existing.id));
		}
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
		const reuseMlflowContext =
			parseExistingSessionMlflowContext(existing, incomingMlflowContext) ??
			(await maybeCreateSessionMlflowRun({
				sessionId: existing.id,
				incomingMlflowContext,
				workflowExecutionId: existing.workflowExecutionId ?? workflowExecutionId,
				workflowId,
				nodeId,
				nodeName,
				agentId: existing.agentId,
				agentVersion: existing.agentVersion ?? null,
				agentSlug: reuseRuntime?.slug ?? bodyAgentSlug,
				agentAppId: reuseChildAppId,
				activeModelId: null,
				activeModelName: null,
				activeModelUri: null,
				projectId,
				userId,
			}));
		// Goal-driven run: ensure the goal row exists (idempotent across Dapr
		// activity replays — skips if an active goal is already set). Evaluator
		// mode (the default for every runtime) gets a row; native `/goal` (opt-in)
		// stays row-less and is driven by the vendor CLI.
		if (evaluatorGoal && effectiveBridgeGoal) {
			await ensureWorkflowGoal(
				existing.id,
				effectiveBridgeGoal,
				existing.workflowExecutionId ?? workflowExecutionId,
			);
		}
		return json({
			sessionId: existing.id,
			agentId: existing.agentId,
			agentVersion: existing.agentVersion,
			agentSlug: reuseRuntime?.slug ?? bodyAgentSlug,
			agentAppId: reuseChildAppId,
			runtimeSandboxName: reuseRuntimeSandboxName,
			agentHostStatus: reuseHost?.status ?? null,
			childInput: buildChildInput({
				sessionId: existing.id,
				agentConfig: dispatchAgentConfig,
				instructionBundle,
				environmentConfig,
				workflowId,
				nodeId,
				nodeName,
				vaultIds: Array.isArray(existing.vaultIds) ? existing.vaultIds : vaultIds,
				workflowExecutionId: existing.workflowExecutionId ?? workflowExecutionId,
				initialMessage: effectiveInitialMessage,
				workspaceRef: bridgeWorkspaceRef,
				sandboxName: bridgeSandboxName ?? existing.sandboxName,
				runtimeSandboxName: reuseRuntimeSandboxName,
				cwd: bridgeCwd,
				timeoutMinutes: bridgeTimeoutMinutes,
				maxIterations: effectiveMaxIterations,
				customGoal: evaluatorGoal,
				agentSlug: reuseRuntime?.slug ?? bodyAgentSlug,
				agentAppId: reuseChildAppId,
				mlflowContext: reuseMlflowContext,
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
			agentConfig: dispatchAgentConfig,
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
		bridgeSandboxName ?? dispatchAgentConfig.runtime ?? "dapr-agent-py";
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
		mlflowSessionId: sessionId,
		// The session_workflow is dispatched by the orchestrator under a
		// DETERMINISTIC Dapr instance id == this sessionId (child_instance_id).
		// Persist it so the BFF can raise events INTO the running session —
		// goal-loop continuations + the goal-complete terminate both go through
		// raiseSessionUserEvents/raiseSessionEvent, which require daprInstanceId
		// (without it they 409 / no-op and goal-mode runs can't advance or end).
		daprInstanceId: sessionId,
	});
	// Now that the session row exists, surface a degraded swap (computed above)
	// as a runtime.swap_degraded event — the durable/run half of the WARN-phase
	// audit dataset. The gate had to run before this (it may reject before the
	// row/pod side effects), so the event is emitted here. Fire-and-forget;
	// deterministic sourceEventId dedupes any idempotent re-ensure.
	if (swapTarget && swapVerdict && swapVerdict.drops.length > 0) {
		void appendEvent(sessionId, {
			type: "runtime.swap_degraded",
			data: {
				runtimeId: swapTarget.id,
				decision: swapVerdict.decision,
				drops: swapVerdict.drops,
			},
			sourceEventId: `swap:${sessionId}:${swapTarget.id}`,
		}).catch((err) =>
			console.warn(
				`[swap-safety] swap_degraded event emit failed: ${err instanceof Error ? err.message : err}`,
			),
		);
	}
	// Goal-driven custom-loop run: create the goal row now that the session row
	// exists. The goal loop then drives continuations off each status_idle, and
	// the agent self-completes via the auto-wired goal MCP. (Native-goal CLIs
	// instead get the `/goal` kickoff as effectiveInitialMessage below.)
	if (evaluatorGoal && effectiveBridgeGoal) {
		await ensureWorkflowGoal(sessionId, effectiveBridgeGoal, workflowExecutionId);
	}
	if (effectiveInitialMessage && effectiveInitialMessage.trim()) {
		await sendUserEvent(sessionId, {
			type: "user.message",
			content: [{ type: "text", text: effectiveInitialMessage }],
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
		agentConfig: dispatchAgentConfig,
		workflowExecutionId,
		benchmarkRunId,
		benchmarkInstanceId,
		benchmarkExecutionClass,
		timeoutMinutes: bridgeTimeoutMinutes,
		traceContext,
		sessionSecretEnv: workflowSessionSecretEnv,
		// interactive-cli: share one JuiceFS workspace subtree across every CLI
		// pod of this workflow run (keyed on workspaceRef, else execution id).
		sharedWorkspaceKey: swapTarget?.capabilities?.interactiveTerminal
			? (bridgeWorkspaceRef ?? workflowExecutionId)
			: null,
	});
	const childAgentAppId = sessionHost?.agentAppId ?? targetAgentAppId;
	const childRuntimeSandboxName = sessionHost?.sandboxName ?? null;
	if (childAgentAppId) {
		await db
			.update(sessions)
			.set({
				runtimeAppId: childAgentAppId,
				runtimeSandboxName: childRuntimeSandboxName,
				updatedAt: new Date(),
			})
			.where(eq(sessions.id, sessionId));
	}
	const sessionMlflowContext = await maybeCreateSessionMlflowRun({
		sessionId,
		incomingMlflowContext,
		workflowExecutionId,
		workflowId,
		nodeId,
		nodeName,
		agentId,
		agentVersion,
		agentSlug: runtimeIdentity?.slug ?? bodyAgentSlug,
		agentAppId: childAgentAppId,
		activeModelId: publishedAgent?.mlflowModelVersion ?? null,
		activeModelName: publishedAgent?.mlflowModelName ?? null,
		activeModelUri: publishedAgent?.mlflowUri ?? null,
		projectId,
		userId,
	});
	const wakeSlug = await resolveWakeSlug({
		bodyAgentSlug,
		bodyAgentAppId: childAgentAppId,
		agentConfig: dispatchAgentConfig,
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

	// Materialize the agent's repository defaults into session_resources for the
	// bridged session so a repo-specialized agent used by a durable/run step
	// clones its repos. Idempotent: skip if repo rows already exist (re-invoke /
	// reused session). The agentConfig is forwarded by the orchestrator bridge,
	// so no orchestrator change is needed.
	const configRepositories = Array.isArray(dispatchAgentConfig.repositories)
		? dispatchAgentConfig.repositories
		: [];
	if (configRepositories.length > 0) {
		const existing = await listResources(sessionId);
		if (!existing.some((r) => r.type === "github_repository")) {
			for (const repo of configRepositories) {
				const repoUrl =
					repo && typeof repo.repoUrl === "string" ? repo.repoUrl.trim() : "";
				if (!repoUrl) continue;
				try {
					await addResource(sessionId, {
						type: "github_repository",
						repoUrl,
						checkoutRef:
							typeof repo.checkoutRef === "string" ? repo.checkoutRef : undefined,
						mountPath:
							typeof repo.mountPath === "string" ? repo.mountPath : undefined,
						authTokenCredentialId:
							typeof repo.authTokenCredentialId === "string"
								? repo.authTokenCredentialId
								: undefined,
						appConnectionExternalId:
							typeof repo.appConnectionExternalId === "string"
								? repo.appConnectionExternalId
								: undefined,
					});
				} catch (resErr) {
					console.warn(
						"[ensure-for-workflow] failed to persist repo resource:",
						resErr,
					);
				}
			}
		}
	}

	// Clone any github_repository resources for this bridged session before the
	// parent yields call_child_workflow (the agent's first turn). Best-effort:
	// failures emit a session event, never block the workflow.
	// NOTE: workflow-driven sandboxes are addressed by (executionId, workspaceRef);
	// the exact pairing for the per-session host needs cluster validation — see
	// the plan's integration checkpoint. Harmless if it no-ops (no repo rows).
	if (bridgeWorkspaceRef) {
		try {
			await mountSessionRepositories(sessionId, {
				executionId: workflowExecutionId ?? sessionId,
				workspaceRef: bridgeWorkspaceRef,
				rootPath: bridgeCwd,
			});
		} catch (mountErr) {
			console.error(
				"[ensure-for-workflow] repository mount failed:",
				mountErr,
			);
		}
	}

	return json({
		sessionId,
		agentId,
		agentVersion,
		agentSlug: runtimeIdentity?.slug ?? bodyAgentSlug,
		agentAppId: childAgentAppId,
		runtimeSandboxName: childRuntimeSandboxName,
		agentHostStatus: sessionHost?.status ?? null,
		childInput: buildChildInput({
			sessionId,
			agentConfig: dispatchAgentConfig,
			instructionBundle,
			environmentConfig,
			workflowId,
			nodeId,
			nodeName,
			vaultIds,
			workflowExecutionId,
			initialMessage: effectiveInitialMessage,
			workspaceRef: bridgeWorkspaceRef,
			sandboxName: incomingSandboxName,
			runtimeSandboxName: childRuntimeSandboxName,
			cwd: bridgeCwd,
			timeoutMinutes: bridgeTimeoutMinutes,
			maxIterations: effectiveMaxIterations,
				customGoal: evaluatorGoal,
			agentId,
			agentVersion,
			agentSlug: runtimeIdentity?.slug ?? bodyAgentSlug,
			agentAppId: childAgentAppId,
			activeModelId: publishedAgent?.mlflowModelVersion ?? null,
			activeModelName: publishedAgent?.mlflowModelName ?? null,
			activeModelUri: publishedAgent?.mlflowUri ?? null,
			mlflowContext: sessionMlflowContext,
		}),
		reused: false,
	});
};

function stampCliAdapterForDispatch(
	agentConfig: AgentConfig,
	runtimeDescriptor: RuntimeDescriptor | undefined,
): AgentConfig {
	if (!runtimeDescriptor?.capabilities?.interactiveTerminal) {
		return agentConfig;
	}
	if (!runtimeDescriptor.cliAdapter) {
		throw error(
			500,
			`Runtime "${runtimeDescriptor.id}" supports interactive terminals but has no cliAdapter in the runtime registry`,
		);
	}
	return {
		...agentConfig,
		cliAdapter: runtimeDescriptor.cliAdapter as AgentConfig["cliAdapter"],
	};
}

async function resolveWorkflowSessionSecretEnv(params: {
	userId: string;
	runtimeDescriptor: RuntimeDescriptor | undefined | null;
}): Promise<Record<string, string> | null> {
	const descriptor = params.runtimeDescriptor;
	const cliAuth = descriptor?.capabilities?.interactiveTerminal
		? descriptor.cliAuth
		: undefined;
	if (!cliAuth) return null;
	const runtimeId = descriptor?.id ?? "unknown-runtime";
	const { provider, envVar, setupCommand, credentialKind } = cliAuth;
	if (!envVar) {
		throw error(
			500,
			`Runtime "${runtimeId}" cliAuth.credentialKind=${credentialKind} requires an envVar`,
		);
	}
	const setupHint = setupCommand
		? `run \`${setupCommand}\` locally`
		: "see the runtime docs";
	if (credentialKind === "device_login") {
		throw error(
			412,
			`Runtime "${runtimeId}" requires an interactive device-code login and cannot run as an automated workflow step. Link a reusable CLI credential first (${setupHint}).`,
		);
	}
	const credential = await getUserCliCredential(params.userId, provider);
	if (!credential) {
		throw error(
			412,
			`No ${provider} CLI credential linked for this user. Add one under Settings -> CLI tokens (${setupHint}) before using "${runtimeId}" in a workflow.`,
		);
	}
	if (
		credentialKind !== "file_bundle" &&
		credential.expiresAt &&
		credential.expiresAt.getTime() < Date.now()
	) {
		throw error(
			412,
			`The linked ${provider} CLI credential has expired. Re-enroll under Settings -> CLI tokens (${setupHint}) before using "${runtimeId}" in a workflow.`,
		);
	}
	return { [envVar]: credential.token };
}

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
	runtimeSandboxName?: string | null;
	cwd?: string | null;
	timeoutMinutes?: number | null;
	maxIterations?: number | null;
	/** Evaluator-mode goal run (the DEFAULT for every runtime — dapr/agy/codex/
	 * claude): keep the session alive across turns (no auto-terminate) so the BFF
	 * goal loop drives continuations + the evaluator gates completion until
	 * session.goal_completed, then the cooperative `session.terminate` ends it
	 * (works for native CLIs post-#187). Only native `/goal` (opt-in) and
	 * single-shot runs keep auto-terminate-on-end-turn. */
	customGoal?: boolean;
	agentId?: string | null;
	agentVersion?: number | null;
	agentSlug?: string | null;
	agentAppId?: string | null;
	activeModelId?: string | null;
	activeModelName?: string | null;
	activeModelUri?: string | null;
	mlflowContext?: MlflowRunContext | null;
}): Record<string, unknown> {
	const mlflowContext =
		params.mlflowContext || params.activeModelId || params.activeModelUri
			? {
					...(params.mlflowContext ?? {}),
					mlflowSessionId:
						params.mlflowContext?.mlflowSessionId ?? params.sessionId,
					activeModelId:
						params.mlflowContext?.activeModelId ?? params.activeModelId ?? null,
					activeModelName:
						params.mlflowContext?.activeModelName ?? params.activeModelName ?? null,
					activeModelUri:
						params.mlflowContext?.activeModelUri ?? params.activeModelUri ?? null,
					traceExperimentId:
						params.mlflowContext?.traceExperimentId ??
						params.mlflowContext?.experimentId ??
						null,
					traceExperimentName:
						params.mlflowContext?.traceExperimentName ??
						params.mlflowContext?.experimentName ??
						null,
				}
			: null;
	return {
		sessionId: params.sessionId,
		agentId: params.agentId ?? null,
		agentVersion: params.agentVersion ?? null,
		agentConfig: params.agentConfig,
		instructionBundle: params.instructionBundle ?? null,
		agentSlug: params.agentSlug ?? null,
		agentAppId: params.agentAppId ?? null,
		runtimeConfigInspectionVersion: 1,
		mlflowSessionId: mlflowContext?.mlflowSessionId ?? params.sessionId,
		mlflowContext,
		environmentConfig: params.environmentConfig,
		workflowId: params.workflowId,
		nodeId: params.nodeId,
		nodeName: params.nodeName ?? params.nodeId,
		workflowExecutionId: params.workflowExecutionId,
		vaultIds: params.vaultIds,
		dbExecutionId: params.workflowExecutionId,
		// Single-shot runs AND opt-in native `/goal` runs auto-terminate after the
		// first end-turn (native `/goal` runs to completion inside one continuous
		// turn, so end_turn == goal done). Evaluator-mode goal runs (the default
		// for every runtime) stay alive multi-turn while the BFF goal loop drives
		// continuations + the evaluator gates completion until session.goal_completed.
		autoTerminateAfterEndTurn: !params.customGoal,
		// Sandbox plumbing — consumed by dapr-agent-py's
		// _freeze_session_child_input so agent_workflow can set
		// runtime.sandbox_name / workspace_ref / cwd. Without these,
		// tools fail with "OpenShell sandboxName is required".
		workspaceRef: params.workspaceRef ?? null,
		sandboxName: params.sandboxName ?? null,
		runtimeSandboxName: params.runtimeSandboxName ?? null,
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
			mlflowRunId: mlflowContext?.runId ?? null,
			mlflowParentRunId: mlflowContext?.parentRunId ?? null,
			mlflowSessionId: mlflowContext?.mlflowSessionId ?? params.sessionId,
			mlflowExperimentId: mlflowContext?.experimentId ?? null,
			mlflowTraceExperimentId: mlflowContext?.traceExperimentId ?? null,
			mlflowPublicUrl: mlflowContext?.publicUrl ?? null,
			mlflowActiveModelId: mlflowContext?.activeModelId ?? null,
			mlflowActiveModelName: mlflowContext?.activeModelName ?? null,
			mlflowActiveModelUri: mlflowContext?.activeModelUri ?? null,
			sandboxName: params.sandboxName ?? null,
			runtimeSandboxName: params.runtimeSandboxName ?? null,
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

type GoalSpec = {
	objective: string;
	tokenBudget: number | null;
	maxIterations: number | null;
	acceptanceCriteria: string[] | null;
	evidencePlan: { commands: string[] } | null;
};

function parseStringArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	const out = value
		.map((v) => (typeof v === "string" ? v.trim() : ""))
		.filter((v) => v.length > 0);
	return out.length ? out : null;
}

/** Validate the optional goal block from the durable/run task. Returns null
 *  (single-shot run) unless a non-empty objective is present. */
function parseGoalSpec(value: unknown): GoalSpec | null {
	if (!value || typeof value !== "object") return null;
	const g = value as Record<string, unknown>;
	const objective = typeof g.objective === "string" ? g.objective.trim() : "";
	if (!objective) return null;
	const evRaw =
		g.evidence && typeof g.evidence === "object"
			? (g.evidence as Record<string, unknown>)
			: null;
	const evCommands = evRaw ? parseStringArray(evRaw.commands) : null;
	return {
		objective,
		tokenBudget: parsePositiveInteger(g.tokenBudget),
		maxIterations: parsePositiveInteger(g.maxIterations),
		acceptanceCriteria: parseStringArray(g.acceptanceCriteria),
		evidencePlan: evCommands ? { commands: evCommands } : null,
	};
}

/** Create the thread_goals row for a workflow-driven goal session, idempotent
 *  across Dapr activity replays: skip if an active (non-complete) goal already
 *  exists so a re-ensure never resets accounting mid-run. The goal loop drives
 *  continuations off status_idle (no kick needed — turn 1 runs on the node
 *  prompt; the loop takes over once the session idles). */
async function ensureWorkflowGoal(
	sessionId: string,
	goal: GoalSpec,
	workflowExecutionId: string | null,
): Promise<void> {
	try {
		const existing = await getCurrentGoal(sessionId);
		if (existing && existing.status !== "complete") return;
		await createOrReplaceGoal({
			sessionId,
			objective: goal.objective,
			tokenBudget: goal.tokenBudget,
			maxIterations: goal.maxIterations ?? undefined,
			workflowExecutionId,
			acceptanceCriteria: goal.acceptanceCriteria,
			evidencePlan: goal.evidencePlan,
		});
	} catch (err) {
		console.warn(
			`[ensure-for-workflow] ensureWorkflowGoal failed for ${sessionId}:`,
			err instanceof Error ? err.message : err,
		);
	}
}

function parseMlflowContext(value: unknown): MlflowRunContext | null {
	if (!value || typeof value !== "object") return null;
	const input = value as Record<string, unknown>;
	const experimentId =
		typeof input.experimentId === "string" && input.experimentId.trim()
			? input.experimentId.trim()
			: null;
	const runId =
		typeof input.runId === "string" && input.runId.trim()
			? input.runId.trim()
			: null;
	const parentRunId =
		typeof input.parentRunId === "string" && input.parentRunId.trim()
			? input.parentRunId.trim()
			: null;
	const mlflowSessionId =
		typeof input.mlflowSessionId === "string" && input.mlflowSessionId.trim()
			? input.mlflowSessionId.trim()
			: null;
	const publicUrl =
		typeof input.publicUrl === "string" && input.publicUrl.trim()
			? input.publicUrl.trim()
			: null;
	const activeModelId =
		typeof input.activeModelId === "string" && input.activeModelId.trim()
			? input.activeModelId.trim()
			: null;
	const activeModelName =
		typeof input.activeModelName === "string" && input.activeModelName.trim()
			? input.activeModelName.trim()
			: null;
	const activeModelUri =
		typeof input.activeModelUri === "string" && input.activeModelUri.trim()
			? input.activeModelUri.trim()
			: null;
	const experimentName =
		typeof input.experimentName === "string" && input.experimentName.trim()
			? input.experimentName.trim()
			: null;
	const traceExperimentId =
		typeof input.traceExperimentId === "string" && input.traceExperimentId.trim()
			? input.traceExperimentId.trim()
			: experimentId;
	const traceExperimentName =
		typeof input.traceExperimentName === "string" && input.traceExperimentName.trim()
			? input.traceExperimentName.trim()
			: experimentName;
	if (!experimentId || !runId) return null;
	return {
		experimentId,
		experimentName,
		traceExperimentId,
		traceExperimentName,
		runId,
		parentRunId,
		mlflowSessionId,
		publicUrl,
		activeModelId,
		activeModelName,
		activeModelUri,
	};
}

function parseExistingSessionMlflowContext(
	session: Session,
	incomingMlflowContext: MlflowRunContext | null,
): MlflowRunContext | null {
	if (!session.mlflowExperimentId || !session.mlflowRunId) return null;
	return {
		experimentId: session.mlflowExperimentId,
		experimentName: incomingMlflowContext?.experimentName ?? null,
		traceExperimentId:
			incomingMlflowContext?.traceExperimentId ??
			session.mlflowExperimentId ??
			null,
		traceExperimentName: incomingMlflowContext?.traceExperimentName ?? null,
		runId: session.mlflowRunId,
		parentRunId: session.mlflowParentRunId ?? incomingMlflowContext?.runId ?? null,
		mlflowSessionId: session.mlflowSessionId ?? session.id,
		publicUrl: null,
		activeModelId: incomingMlflowContext?.activeModelId ?? null,
		activeModelName: incomingMlflowContext?.activeModelName ?? null,
		activeModelUri: incomingMlflowContext?.activeModelUri ?? null,
	};
}

async function maybeCreateSessionMlflowRun(params: {
	sessionId: string;
	incomingMlflowContext: MlflowRunContext | null;
	workflowExecutionId: string | null;
	workflowId: string;
	nodeId: string;
	nodeName: string;
	agentId: string | null;
	agentVersion: number | null;
	agentSlug: string | null;
	agentAppId: string | null;
	activeModelId: string | null;
	activeModelName: string | null;
	activeModelUri: string | null;
	projectId: string | null;
	userId: string;
}): Promise<MlflowRunContext | null> {
	const parentRunId = params.incomingMlflowContext?.runId;
	if (!parentRunId) return null;
	return await safeCreateWorkflowAgentMlflowRun({
		sessionId: params.sessionId,
		parentRunId,
		mlflowSessionId: params.sessionId,
		experimentId: params.incomingMlflowContext?.experimentId ?? null,
		workflowExecutionId: params.workflowExecutionId,
		workflowId: params.workflowId,
		nodeId: params.nodeId,
		nodeName: params.nodeName,
		agentId: params.agentId,
		agentVersion: params.agentVersion,
		agentSlug: params.agentSlug,
		agentAppId: params.agentAppId,
		activeModelId: params.activeModelId,
		activeModelName: params.activeModelName,
		activeModelUri: params.activeModelUri,
		traceExperimentId:
			params.incomingMlflowContext?.traceExperimentId ??
			params.incomingMlflowContext?.experimentId ??
			null,
		traceExperimentName: params.incomingMlflowContext?.traceExperimentName ?? null,
		projectId: params.projectId,
		userId: params.userId,
	});
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
}): Promise<PublishedWorkflowAgent | null> {
	if (!params.agentId || !db) return null;
	const [agent] = await db
		.select()
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
			.select()
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
		const mlflowIdentity = await ensureAgentVersionMlflowIdentity(agent, version);
		return {
			agentId: agent.id,
			agentVersion: version.version,
			agentSlug: agent.slug,
			agentAppId: agent.runtimeAppId ?? agentRuntimeDedicatedAppId(agent.slug),
			mlflowUri: mlflowIdentity.mlflowUri,
			mlflowModelName: mlflowIdentity.mlflowModelName,
			mlflowModelVersion: mlflowIdentity.mlflowModelVersion,
		};
	}
	if (!agent.currentVersionId) {
		throw error(400, `agent ${params.agentId} has no current version`);
	}
	const [current] = await db
		.select()
		.from(agentVersions)
		.where(eq(agentVersions.id, agent.currentVersionId))
		.limit(1);
	if (!current) {
		throw error(400, `agent ${params.agentId} current version is not available`);
	}
	const mlflowIdentity = await ensureAgentVersionMlflowIdentity(agent, current);
	return {
		agentId: agent.id,
		agentVersion: current.version,
		agentSlug: agent.slug,
		agentAppId: agent.runtimeAppId ?? agentRuntimeDedicatedAppId(agent.slug),
		mlflowUri: mlflowIdentity.mlflowUri,
		mlflowModelName: mlflowIdentity.mlflowModelName,
		mlflowModelVersion: mlflowIdentity.mlflowModelVersion,
	};
}

async function ensureAgentVersionMlflowIdentity(
	agent: typeof agents.$inferSelect,
	version: typeof agentVersions.$inferSelect,
): Promise<{
	mlflowUri: string | null;
	mlflowModelName: string | null;
	mlflowModelVersion: string | null;
}> {
	if (version.mlflowUri?.trim()) {
		return {
			mlflowUri: version.mlflowUri,
			mlflowModelName: version.mlflowModelName ?? null,
			mlflowModelVersion: version.mlflowModelVersion ?? null,
		};
	}
	try {
		const registered = await registerAgentVersionInMlflow({ agent, version });
		if (registered) {
			return {
				mlflowUri: registered.modelUri,
				mlflowModelName: registered.modelName,
				mlflowModelVersion: registered.modelId,
			};
		}
	} catch (err) {
		console.warn(
			`[ensure-for-workflow] MLflow agent version registration failed for ${agent.id}@${version.version}:`,
			err instanceof Error ? err.message : err,
		);
	}
	return {
		mlflowUri: version.mlflowUri ?? null,
		mlflowModelName: version.mlflowModelName ?? null,
		mlflowModelVersion: version.mlflowModelVersion ?? null,
	};
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
