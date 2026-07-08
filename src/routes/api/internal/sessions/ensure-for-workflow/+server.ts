import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import type {
	WorkflowDataService,
	WorkflowPublishedAgent,
} from "$lib/server/application/ports";
import { validateInternalToken } from "$lib/server/internal-auth";
import { rewriteMcpForBrowserSidecar } from "$lib/server/agents/mcp-sidecar";
import {
	getRuntimeDescriptor,
	type RuntimeDescriptor,
} from "$lib/server/agents/runtime-registry";
import { evaluateSwap } from "$lib/server/agents/swap-safety";
import type { AgentConfig } from "$lib/types/agents";
import {
	agentRuntimeDedicatedAppId,
	agentRuntimeSlugFromAppId,
} from "$lib/server/agents/runtime-routing";
import {
	extractTraceContext,
	maybeProvisionAgentWorkflowHost,
} from "$lib/server/sessions/agent-workflow-host";
import { resolveWorkflowSessionSecretEnv } from "$lib/server/sessions/session-secret-env";
import {
	provisionSessionSandboxWithRetry,
	sandboxProvisionFailureMessage,
} from "$lib/server/sandboxes/provision";
import {
	decideGoalHarness,
	runtimeHasNativeGoalHarness,
} from "$lib/server/sessions/runtime-target";
import {
	ensureGoalMcpServer,
	stampGoalMcpSessionHeader,
	stampScriptGuardHeader,
} from "$lib/server/goals/mcp-wiring";

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
	const { workflowData, sessionGoals, sessionCommands, promptStackCompiler } =
		getApplicationAdapters();

	const traceContext = extractTraceContext(request);
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const sessionId =
		typeof body.sessionId === "string" && body.sessionId.trim()
			? body.sessionId.trim()
			: null;
	const workflowId = typeof body.workflowId === "string" ? body.workflowId : "";
	const nodeId = typeof body.nodeId === "string" ? body.nodeId : "";
	const nodeName =
		typeof body.nodeName === "string" && body.nodeName.trim()
			? body.nodeName.trim()
			: nodeId;
	const workflowExecutionId =
		typeof body.workflowExecutionId === "string"
			? body.workflowExecutionId
			: null;
	const parentExecutionId =
		typeof body.parentExecutionId === "string" ? body.parentExecutionId : null;
	const benchmarkRunId =
		typeof body.benchmarkRunId === "string" && body.benchmarkRunId.trim()
			? body.benchmarkRunId.trim()
			: null;
	const benchmarkInstanceId =
		typeof body.benchmarkInstanceId === "string" &&
		body.benchmarkInstanceId.trim()
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

	// If userId wasn't passed explicitly, resolve from the workflow execution
	// row. The orchestrator doesn't carry user_id on TaskContext today, so
	// this makes the Python side simpler: it only needs the execution id.
	if (!userId && workflowExecutionId) {
		const executionContext =
			await workflowData.getWorkflowExecutionSessionOwnerContext(
				workflowExecutionId,
			);
		if (executionContext) {
			userId = executionContext.userId;
			if (!projectId) {
				projectId = executionContext.projectId;
			}
		}
	}
	if (benchmarkRunId) {
		const gate = await workflowData.checkBenchmarkSessionProvisioningGate({
			runId: benchmarkRunId,
			instanceId: benchmarkInstanceId,
		});
		if (!gate.ok) return error(gate.status, gate.message);
		if (!benchmarkExecutionClass) {
			benchmarkExecutionClass = gate.benchmarkExecutionClass;
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
	// src/lib/server/application/adapters/agent-registry-sync.ts:752-754.
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
							{
								runtime: (rawAgentConfig as { runtime?: string }).runtime,
							},
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
			? await promptStackCompiler
					.compilePromptStack(agentConfigAfterMcp, { projectId })
					.catch((err) => {
						console.warn(
							"[ensure-for-workflow] compilePromptStack failed, continuing with empty stack:",
							err instanceof Error ? err.message : err,
						);
						return emptyPresetStack;
					})
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
	// Hermetic fork: source workspace subPath to seed (copy) this fork's fresh
	// workspace from at sandbox startup. Forwarded to the agent-workflow-host.
	const bridgeSeedWorkspaceFrom =
		typeof body.seedWorkspaceFrom === "string" && body.seedWorkspaceFrom.trim()
			? body.seedWorkspaceFrom.trim()
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
	if (!workflowId || !nodeId)
		return error(400, "workflowId and nodeId are required");
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
	// Server-truth lookup of the spawning workflow: dynamic-script spawns get
	// platform MCP wiring + the recursion guard below.
	const spawningWorkflow = await getApplicationAdapters()
		.workflowData.getWorkflowByRef({ workflowId, lookup: "id" })
		.catch(() => null);
	const isDynamicScriptSpawn = spawningWorkflow?.engineType === "dynamic-script";
	const isCliRuntime = swapTarget?.capabilities?.interactiveTerminal === true;
	// Auto-wire the platform goal MCP server (+ session header) only for non-CLI:
	//   - evaluator-mode goal sessions (update_goal self-completion), and
	//   - DYNAMIC-SCRIPT-spawned non-CLI sessions that rely on platform tools.
	// CLI agents should not inherit default goal tools; their callable schema
	// should contain only explicitly configured MCP servers plus runtime-internal
	// tools such as StructuredOutput. Single-shot SW-1.0 runs also stay untouched.
	const shouldAutoWireGoalMcp =
		(evaluatorGoal || isDynamicScriptSpawn) && !isCliRuntime;
	let dispatchAgentConfig: AgentConfig =
		shouldAutoWireGoalMcp
			? ({
					...baseDispatchAgentConfig,
					mcpServers: stampGoalMcpSessionHeader(
						ensureGoalMcpServer(
							(baseDispatchAgentConfig as { mcpServers?: unknown[] })
								.mcpServers ?? [],
							swapTarget?.capabilities?.supportsMcp ?? false,
							isCliRuntime,
						),
						sessionId,
					),
				} as AgentConfig)
			: baseDispatchAgentConfig;
	// Recursion guard: when the SPAWNING workflow is a dynamic-script, stamp the
	// script-depth header on any explicitly configured workflow-mcp-server entries
	// so the MCP server suppresses `run_workflow_script` — a script-spawned agent
	// can't recursively launch another script workflow.
	if (isDynamicScriptSpawn) {
		dispatchAgentConfig = {
			...dispatchAgentConfig,
			mcpServers: stampScriptGuardHeader(
				(dispatchAgentConfig as { mcpServers?: unknown[] }).mcpServers ?? [],
			),
		} as AgentConfig;
	}
	// Goal-mode sessions run multi-turn (no auto-terminate) capped by the goal's
	// maxIterations; native-`/goal` runs get the objective as a `/goal` kickoff.
	const effectiveMaxIterations = goalMode
		? (bridgeGoal?.maxIterations ?? bridgeMaxIterations)
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
	// juicefs-shared agents (e.g. dapr-agent-py-juicefs) get their workspace from
	// the per-execution JuiceFS CSI mount keyed by sharedWorkspaceKey — they run
	// file/bash tools locally (LocalWorkspaceRuntime), NOT over the OpenShell remote
	// sandbox RPC. Provisioning an OpenShell auto-sandbox here would OVERWRITE
	// bridgeWorkspaceRef with a `ws_<id>` key, so the agent would mount the
	// auto-sandbox subtree instead of the canonical instance-id JuiceFS subtree
	// where clone_repo + the other nodes wrote (symptom: "/sandbox/work empty except
	// git metadata", SPEC.md not found). Only openshell-shared agents need it.
	const needsOpenShellSandbox =
		swapTarget?.capabilities?.supportsBuiltinOpenShellTools === true &&
		swapTarget?.capabilities?.ownsSandbox === false &&
		swapTarget?.capabilities?.workspaceBackend !== "juicefs-shared" &&
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
					typeof (agentConfig as { sandboxTemplate?: unknown })
						.sandboxTemplate === "string"
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
				swapVerdict.drops
					.map((d) => `${d.capability}(${d.severity})`)
					.join(", "),
		);
		for (const d of swapVerdict.drops)
			console.warn(`[swap-safety]   ${d.detail}`);
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
		sessionId,
	});

	// Idempotent: if a session with this deterministic id already exists, return it.
	const existing = await workflowData.getWorkflowEnsureSession(sessionId);
	if (existing) {
		await sessionCommands.syncWorkflowSessionAgentRuntime({
			agentId: existing.agentId,
			bestEffort: true,
			context: `existing session ${sessionId}`,
		});
		// Also wake on replay/idempotent hits — the orchestrator's
		// `ctx.call_child_workflow` still needs the target pod live.
		const reuseRuntime = await resolveRuntimeIdentity(
			workflowData,
			existing.agentId,
		);
		const reuseAgentAppId =
			reuseRuntime?.appId ??
			bodyAgentAppId ??
			(bodyAgentSlug ? agentRuntimeDedicatedAppId(bodyAgentSlug) : null);
		const reuseWakeSlug = await resolveWakeSlug({
			workflowData,
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
			// Share one JuiceFS workspace subtree across every pod of this
			// workflow run (planner/generator/critic + deterministic cliWorkspace
			// nodes see the same files). The CANONICAL subtree key is the
			// orchestrator instance id (`sw-<name>-exec-<id>`), which the
			// durable/run `workspaceRef` (`${ .runtime.executionId }`) resolves to
			// via resolveSharedWorkspaceKey — the SAME key the cli_workspace_command
			// helper pod and the Files-tab webdav reader (workflowExecutions
			// .daprInstanceId) use. Both interactive-cli AND juicefs-shared
			// (dapr-agent-py-juicefs) key on it so agents, the deterministic
			// cliWorkspace spine, and the Files tab all land on one subtree.
			sharedWorkspaceKey:
				swapTarget?.capabilities?.interactiveTerminal ||
				swapTarget?.capabilities?.workspaceBackend === "juicefs-shared"
					? (bridgeWorkspaceRef ?? workflowExecutionId)
					: null,
			seedWorkspaceFrom: bridgeSeedWorkspaceFrom,
		});
		const reuseChildAppId = reuseHost?.agentAppId ?? reuseAgentAppId;
		const reuseRuntimeSandboxName =
			reuseHost?.sandboxName ?? existing.runtimeSandboxName ?? null;
		if (reuseChildAppId) {
			await workflowData.updateWorkflowEnsureSessionRuntime({
				sessionId: existing.id,
				runtimeAppId: reuseChildAppId,
				runtimeSandboxName: reuseRuntimeSandboxName,
			});
		}
		if (!reuseHost && reuseWakeSlug) {
			try {
				const { wakeAgentRuntime } = await import("$lib/server/kube/client");
				await wakeAgentRuntime(reuseWakeSlug, 20_000);
			} catch (err) {
				console.warn(
					`[ensure-for-workflow] reuse wake ${reuseWakeSlug} failed, continuing anyway:`,
					err instanceof Error ? err.message : err,
				);
			}
		}
		// Goal-driven run: ensure the goal row exists (idempotent across Dapr
		// activity replays — skips if an active goal is already set). Evaluator
		// mode (the default for every runtime) gets a row; native `/goal` (opt-in)
		// stays row-less and is driven by the vendor CLI.
		if (evaluatorGoal && effectiveBridgeGoal) {
			await sessionGoals.ensureWorkflowEvaluatorGoal({
				sessionId: existing.id,
				objective: effectiveBridgeGoal.objective,
				tokenBudget: effectiveBridgeGoal.tokenBudget,
				maxIterations: effectiveBridgeGoal.maxIterations,
				workflowExecutionId:
					existing.workflowExecutionId ?? workflowExecutionId,
				acceptanceCriteria: effectiveBridgeGoal.acceptanceCriteria,
				evidencePlan: effectiveBridgeGoal.evidencePlan,
			});
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
				vaultIds: Array.isArray(existing.vaultIds)
					? existing.vaultIds
					: vaultIds,
				workflowExecutionId:
					existing.workflowExecutionId ?? workflowExecutionId,
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
			}),
			reused: true,
		});
	}

	// Resolved workflow specs carry the original published agent identity.
	// Use it when present so workflow-driven sessions execute in the published
	// agent-runtime-<slug> pod. Specs without that identity are older inline
	// configs and still get a workflow-scoped ephemeral agent.
	const publishedAgent = await resolvePublishedWorkflowAgent(workflowData, {
		agentId: bodyAgentId,
		agentVersion: bodyAgentVersion,
		projectId,
	});
	const sessionAgent = await sessionCommands.resolveWorkflowSessionAgent({
		publishedAgent,
		workflowId,
		nodeId,
		agentConfig: dispatchAgentConfig,
		userId,
	});
	const { agentId, agentVersion } = sessionAgent;
	await sessionCommands.syncWorkflowSessionAgentRuntime({ agentId });
	const runtimeIdentity = await resolveRuntimeIdentity(workflowData, agentId);

	// Create the session row with the deterministic id. We bypass createSession's
	// auto-id generation by inserting directly, then reuse createSession's
	// defaults via a follow-up lookup. To keep a single code path, we do a
	// direct insert here since createSession doesn't accept a pre-computed id.
	const incomingSandboxName =
		bridgeSandboxName ?? dispatchAgentConfig.runtime ?? "dapr-agent-py";
	await workflowData.createWorkflowEnsureSession({
		id: sessionId,
		title,
		agentId,
		agentVersion,
		vaultIds,
		userId,
		projectId: projectId ?? null,
		sandboxName: incomingSandboxName,
		workflowExecutionId,
		parentExecutionId,
	});
	// Now that the session row exists, surface a degraded swap (computed above)
	// as a runtime.swap_degraded event — the durable/run half of the WARN-phase
	// audit dataset. The gate had to run before this (it may reject before the
	// row/pod side effects), so the event is emitted here. Fire-and-forget;
	// deterministic sourceEventId dedupes any idempotent re-ensure.
	if (swapTarget && swapVerdict && swapVerdict.drops.length > 0) {
		void sessionCommands
			.appendWorkflowSessionSwapDegradedEvent({
				sessionId,
				runtimeId: swapTarget.id,
				decision: swapVerdict.decision,
				drops: swapVerdict.drops,
			})
			.catch((err) =>
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
		await sessionGoals.ensureWorkflowEvaluatorGoal({
			sessionId,
			objective: effectiveBridgeGoal.objective,
			tokenBudget: effectiveBridgeGoal.tokenBudget,
			maxIterations: effectiveBridgeGoal.maxIterations,
			workflowExecutionId,
			acceptanceCriteria: effectiveBridgeGoal.acceptanceCriteria,
			evidencePlan: effectiveBridgeGoal.evidencePlan,
		});
	}
	await sessionCommands.appendWorkflowSessionInitialMessage({
		sessionId,
		text: effectiveInitialMessage,
	});

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
		// Share one JuiceFS workspace subtree across every pod of this workflow
		// run, keyed by the CANONICAL orchestrator instance id (= workflow
		// Executions.daprInstanceId, what the Files-tab webdav reader + the
		// cli_workspace_command helper use). Both interactive-cli and
		// juicefs-shared resolve their workspaceRef to it — see the spawn site
		// above for the full rationale.
		sharedWorkspaceKey:
			swapTarget?.capabilities?.interactiveTerminal ||
			swapTarget?.capabilities?.workspaceBackend === "juicefs-shared"
				? (bridgeWorkspaceRef ?? workflowExecutionId)
				: null,
		seedWorkspaceFrom: bridgeSeedWorkspaceFrom,
	});
	const childAgentAppId = sessionHost?.agentAppId ?? targetAgentAppId;
	const childRuntimeSandboxName = sessionHost?.sandboxName ?? null;
	if (childAgentAppId) {
		await workflowData.updateWorkflowEnsureSessionRuntime({
			sessionId,
			runtimeAppId: childAgentAppId,
			runtimeSandboxName: childRuntimeSandboxName,
		});
	}
	const wakeSlug = await resolveWakeSlug({
		workflowData,
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

	await sessionCommands.materializeWorkflowSessionRepositories({
		sessionId,
		repositories: dispatchAgentConfig.repositories,
		workflowExecutionId,
		workspaceRef: bridgeWorkspaceRef,
		cwd: bridgeCwd,
	});

	// Per-turn reap: a workflow run dispatches one per-session agent-host pod per
	// durable/run node, but those pods are only cleaned at run-END — so within a
	// multi-node run they accumulate one-per-node, and each mounts a
	// system-critical JuiceFS pod. On a small cluster the node's cpu REQUESTS
	// saturate and the kubelet preempts the low-priority agent pods (run errors
	// "Preempting"). As we spawn each new node, reap this run's already-terminal
	// sessions' host sandboxes (their per-node diff was captured at session end).
	// Best-effort, fully detached — never blocks or fails the spawn.
	if (workflowExecutionId) {
		void sessionCommands
			.reapTerminatedWorkflowSessionRuntimeHosts({
				workflowExecutionId,
				exceptSessionId: sessionId,
			})
			.catch(() => {});
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

/** First ACTIVE GitHub app_connection's token (raw), via the SCM resolver. Best-
 * effort — null when no GitHub connection is linked. (Single-owner dev: this is the
 * user's connection; a per-user filter is a multi-tenant follow-up.) */
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
}): Record<string, unknown> {
	return {
		sessionId: params.sessionId,
		agentId: params.agentId ?? null,
		agentVersion: params.agentVersion ?? null,
		agentConfig: params.agentConfig,
		instructionBundle: params.instructionBundle ?? null,
		agentSlug: params.agentSlug ?? null,
		agentAppId: params.agentAppId ?? null,
		runtimeConfigInspectionVersion: 1,
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
		activeModelId: params.activeModelId ?? null,
		activeModelName: params.activeModelName ?? null,
		activeModelUri: params.activeModelUri ?? null,
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
			runtimeSandboxName: params.runtimeSandboxName ?? null,
			workspaceRef: params.workspaceRef ?? null,
			cwd: params.cwd ?? null,
			activeModelId: params.activeModelId ?? null,
			activeModelName: params.activeModelName ?? null,
			activeModelUri: params.activeModelUri ?? null,
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

async function resolveRuntimeIdentity(
	workflowData: WorkflowDataService,
	agentId: string | null,
): Promise<{ slug: string; appId: string } | null> {
	if (!agentId) return null;
	const identity = await workflowData.getWorkflowAgentRuntimeIdentity(agentId);
	return identity ? { slug: identity.slug, appId: identity.appId } : null;
}

async function resolvePublishedWorkflowAgent(
	workflowData: WorkflowDataService,
	params: {
		agentId: string | null;
		agentVersion: number | null;
		projectId: string | null;
	},
): Promise<WorkflowPublishedAgent | null> {
	const result =
		await workflowData.resolvePublishedWorkflowAgentForEnsure(params);
	if (!result) return null;
	if (!result.ok) {
		throw error(result.status, result.message);
	}
	return result.agent;
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
	workflowData: WorkflowDataService;
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
	if (params.agentId) {
		const identity = await params.workflowData.getWorkflowAgentRuntimeIdentity(
			params.agentId,
		);
		if (identity?.slug) return identity.slug;
	}
	return null;
}
