import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import type {
  SessionCommandAgent,
	WorkflowDataService,
	WorkflowPublishedAgent,
} from "$lib/server/application/ports";
import {
	runtimeSupportsStructuredOutput,
	validateDraft202012ObjectSchema,
} from "$lib/server/application/structured-output";
import {
	resolvePublishedSessionRuntimeSandboxName,
} from "$lib/server/application/session-runtime-host-recovery";
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
	resolveAgentRuntimeRoute,
} from "$lib/server/agents/runtime-routing";
import {
	extractTraceContext,
	maybeProvisionAgentWorkflowHost,
} from "$lib/server/sessions/agent-workflow-host";
import { resolveWorkflowSessionSecretEnv } from "$lib/server/sessions/session-secret-env";
import {
	decideGoalHarness,
	runtimeHasNativeGoalHarness,
	runtimeUsesSharedWorkspace,
} from "$lib/server/sessions/runtime-target";
import {
	stampScriptGuardHeader,
	stampWorkflowMcpSessionAuth,
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

/**
 * Stamp the owning run's identity onto the agent-browser MCP entry (matched by
 * URL) so the agent-browser-mcp service can persist the artifacts it produces
 * (screenshot / video / pdf / HAR) to THIS run's browser-artifacts store. Those
 * artifacts live on the agent-browser-mcp pod, so the run identity has to travel
 * with the MCP connection; scoping by URL keeps the headers off every other
 * server. Same URL-scoped header pattern as stampScriptGuardHeader.
 */
function isTrustedAgentBrowserMcpUrl(value: unknown): boolean {
	if (typeof value !== "string") return false;
	try {
		const url = new URL(value);
		return (
			url.protocol === "http:" &&
			url.hostname.toLowerCase() ===
				"agent-browser-mcp.workflow-builder.svc.cluster.local" &&
			url.port === "8000" &&
			url.pathname === "/mcp" &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash
		);
	} catch {
		return false;
	}
}

function stampAgentBrowserRunHeaders(
	servers: unknown[],
	ctx: {
		executionId: string | null;
		workflowId: string | null;
		nodeId: string | null;
	},
	targetAuthAssertion: string | null,
): unknown[] {
	if (!Array.isArray(servers)) return servers;
	return servers.map((entry) => {
		if (!entry || typeof entry !== "object") return entry;
		const e = entry as Record<string, unknown>;
		const sourceHeaders =
			e.headers && typeof e.headers === "object" && !Array.isArray(e.headers)
				? (e.headers as Record<string, unknown>)
				: {};
			const blockedHeaders = new Set([
				"x-wfb-target-auth",
				"x-wfb-target-auth-host",
				"x-wfb-browser-target-assertion",
				"x-wfb-execution-id",
				"x-wfb-workflow-id",
				"x-wfb-node-id",
			]);
		const sanitizedHeaders = Object.fromEntries(
			Object.entries(sourceHeaders).filter(
				([name]) => !blockedHeaders.has(name.toLowerCase()),
			),
		);
		if (!isTrustedAgentBrowserMcpUrl(e.url)) {
      return Object.keys(sanitizedHeaders).length ===
        Object.keys(sourceHeaders).length
				? entry
				: { ...e, headers: sanitizedHeaders };
		}
		const headers = {
			...sanitizedHeaders,
			...(ctx.executionId ? { "X-Wfb-Execution-Id": ctx.executionId } : {}),
			...(ctx.workflowId ? { "X-Wfb-Workflow-Id": ctx.workflowId } : {}),
			...(ctx.nodeId ? { "X-Wfb-Node-Id": ctx.nodeId } : {}),
			...(targetAuthAssertion
				? {
						"X-Wfb-Browser-Target-Assertion": targetAuthAssertion,
					}
				: {}),
		};
		return { ...e, headers };
	});
}

function hasAgentBrowserServer(servers: unknown[]): boolean {
	return servers.some((entry) => {
		if (!entry || typeof entry !== "object") return false;
		const server = entry as Record<string, unknown>;
		return isTrustedAgentBrowserMcpUrl(server.url);
	});
}
export const POST: RequestHandler = async ({ request }) => {
	if (!validateInternalToken(request)) return error(401, "Unauthorized");
	const {
		workflowData,
		sessionGoals,
		sessionCommands,
    sessionRuntimeHostRecovery,
		promptStackCompiler,
		workflowTargetAuth,
    workflowMcpSessionTokenSigner,
		runtimeRegistry,
	} = getApplicationAdapters();

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
	const requestedWorkflowExecutionId =
		typeof body.workflowExecutionId === "string"
			? body.workflowExecutionId
			: null;
	let workflowExecutionId = requestedWorkflowExecutionId;
	const requestedParentExecutionId =
		typeof body.parentExecutionId === "string" ? body.parentExecutionId : null;
	let parentExecutionId = requestedParentExecutionId;
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
	const requestedUserId =
		typeof body.userId === "string" && body.userId.trim()
			? body.userId.trim()
			: null;
	const requestedProjectId =
		typeof body.projectId === "string" && body.projectId.trim()
			? body.projectId.trim()
			: null;
	let userId = requestedUserId ?? "";
	let projectId = requestedProjectId;

	if (!sessionId) return error(400, "sessionId is required");
	if (!workflowId || !nodeId)
		return error(400, "workflowId and nodeId are required");

	const existing = await workflowData.getWorkflowEnsureSession(sessionId);
	if (existing) {
		const lineageMismatch =
			(requestedUserId != null && requestedUserId !== existing.userId) ||
			(requestedProjectId != null &&
				requestedProjectId !== existing.projectId) ||
			(requestedWorkflowExecutionId != null &&
				requestedWorkflowExecutionId !== existing.workflowExecutionId) ||
			(requestedParentExecutionId != null &&
				requestedParentExecutionId !== existing.parentExecutionId);
		if (lineageMismatch) {
			return error(
				409,
				`Existing session ${existing.id} ownership or execution lineage does not match the request`,
			);
		}
		userId = existing.userId;
		projectId = existing.projectId;
		workflowExecutionId = existing.workflowExecutionId;
		parentExecutionId = existing.parentExecutionId;
	}

	// Resolve the parent even when userId is already present: stop intent on the
  // parent is the provisioning fence that prevents a late activity retry from
  // recreating a child host after the user stopped the workflow.
	const executionContext = workflowExecutionId
    ? await workflowData.getWorkflowExecutionSessionOwnerContext(
				workflowExecutionId,
      )
		: null;
	if (
		executionContext &&
		(executionContext.workflowId !== workflowId ||
			(requestedUserId != null &&
				requestedUserId !== executionContext.userId) ||
			(requestedProjectId != null &&
				requestedProjectId !== executionContext.projectId) ||
			(existing != null &&
				(existing.userId !== executionContext.userId ||
					existing.projectId !== executionContext.projectId)))
	) {
		return error(
			409,
			"workflow execution ownership or workflow identity does not match the request",
			);
	}
  if (
    executionContext &&
    (executionContext.stopRequestedAt != null ||
      (executionContext.status != null &&
        !new Set(["pending", "running"]).has(executionContext.status)))
  ) {
    return error(409, "workflow execution is stopping or terminal");
  }
	// The orchestrator does not carry user_id on TaskContext, so fill ownership
	// from the authoritative execution when it was omitted.
	if (executionContext && !existing) {
			userId = executionContext.userId;
				projectId = executionContext.projectId;
			}
	if (!userId) {
		return error(
			400,
			"userId could not be resolved — pass explicit userId or a workflowExecutionId that exists",
		);
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
	// Prepare a raw agent config for dispatch: apply the per-agent browser
	// sidecar MCP rewrite, then compile the Prompt Workbench preset stack.
	//
	// The MCP rewrite (same helper that src/lib/server/sessions/spawn.ts uses
	// for direct sessions) routes a stdio Playwright preset through the in-pod
	// playwright-mcp sidecar at http://localhost:3100/mcp — without it,
	// `npx @playwright/mcp@latest` would run inside the dapr-agent-py container
	// where there's no Chromium binary. Skipped for runtime=browser-use-agent
	// (it manages its own browser via Browserstation; the rewrite would
	// mis-route to a non-existent localhost:3100). Mirrors the skip in
	// src/lib/server/application/adapters/agent-registry-sync.ts:752-754.
	//
	// Reused for BOTH the inline body.agentConfig and — on the named-agent
	// (dynamic-script agent({agent})) path below — the resolved DB agent's
	// full config.
	const prepareAgentConfig = async (
		raw: AgentConfig | null,
	): Promise<AgentConfig | null> => {
		if (!raw) return null;
		const isBrowserUseRuntime =
			(raw as { runtime?: unknown }).runtime === "browser-use-agent";
		const afterMcp = {
			...raw,
			mcpServers: isBrowserUseRuntime
				? (raw as { mcpServers?: unknown[] }).mcpServers
				: rewriteMcpForBrowserSidecar(
						(raw as { mcpServers?: unknown[] }).mcpServers as never,
						{ runtime: (raw as { runtime?: string }).runtime },
					).mcpServers,
		} as AgentConfig;
		const compiled = projectId
			? await promptStackCompiler
					.compilePromptStack(afterMcp, { projectId })
					.catch((err) => {
						console.warn(
							"[ensure-for-workflow] compilePromptStack failed, continuing with empty stack:",
							err instanceof Error ? err.message : err,
						);
						return emptyPresetStack;
					})
			: emptyPresetStack;
		return {
			...afterMcp,
			compiledStaticPresetSections: compiled.static,
			compiledDynamicPresetSections: compiled.dynamic,
			// Phase 3a v2: per-ref version-id + mlflow_uri manifest for
			// trace-tag propagation in dapr-agent-py.
			promptPresetManifest: [
				...compiled.staticManifest,
				...compiled.dynamicManifest,
			],
		} as AgentConfig;
	};
	const rawAgentConfig =
		body.agentConfig && typeof body.agentConfig === "object"
			? (body.agentConfig as unknown as AgentConfig)
			: null;
	let agentConfig: AgentConfig | null = null;
	const buildExactSavedAgentConfig = async (
		savedAgent: SessionCommandAgent,
	): Promise<
		| { ok: true; config: AgentConfig }
		| { ok: false; message: string }
	> => {
		const flattened =
			await getApplicationAdapters().capabilityBundles.flattenBundles(
				savedAgent.config,
				savedAgent.projectId ?? projectId,
			);
		const flattenedRecord = flattened as AgentConfig & {
			agentAppId?: unknown;
		};
		const merged = { ...flattenedRecord } as Record<string, unknown>;
		for (const key of [
			"model",
			"modelSpec",
			"reasoningEffort",
			"responseJsonSchema",
			"structuredOutputMode",
		] as const) {
			const override = (rawAgentConfig as Record<string, unknown> | null)?.[
				key
			];
			if (override !== undefined && override !== null) merged[key] = override;
		}

		const savedRuntime =
			typeof flattenedRecord.runtime === "string" &&
			flattenedRecord.runtime.trim()
				? flattenedRecord.runtime.trim()
				: typeof savedAgent.runtime === "string" && savedAgent.runtime.trim()
					? savedAgent.runtime.trim()
					: null;
		if (!savedRuntime) {
			return { ok: false, message: "saved agent has no runtime" };
		}
		merged.runtime = savedRuntime;
		const savedAppId =
			typeof savedAgent.runtimeAppId === "string" &&
			savedAgent.runtimeAppId.trim()
				? savedAgent.runtimeAppId.trim()
				: typeof flattenedRecord.agentAppId === "string" &&
						flattenedRecord.agentAppId.trim()
					? flattenedRecord.agentAppId.trim()
					: null;
		if (savedAppId) merged.agentAppId = savedAppId;

		if (merged.structuredOutputMode === "tool") {
			const capability =
				await runtimeRegistry.getStructuredOutputCapability(savedRuntime);
			if (!runtimeSupportsStructuredOutput(capability)) {
				return {
					ok: false,
					message: `runtime '${savedRuntime}' does not support StructuredOutput with Draft 2020-12`,
				};
			}
			const schema = validateDraft202012ObjectSchema(
				merged.responseJsonSchema,
			);
			if (!schema.ok) return { ok: false, message: schema.error };
			merged.responseJsonSchema = schema.schema;
		}

		const prepared = await prepareAgentConfig(merged as AgentConfig);
		return prepared
			? { ok: true, config: prepared }
			: { ok: false, message: "saved-agent configuration is unavailable" };
	};
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
	let bridgeTimeoutMinutes =
		parsePositiveInteger(body.timeoutMinutes) ??
		parsePositiveInteger(rawAgentConfig?.timeoutMinutes);
	let bridgeMaxIterations =
		parsePositiveInteger(body.maxIterations) ??
		parsePositiveInteger(body.maxTurns) ??
		parsePositiveInteger(rawAgentConfig?.maxTurns);

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
	const resolveAgentVersionRaw =
		typeof body.resolveAgentVersion === "number" &&
		Number.isFinite(body.resolveAgentVersion) &&
		body.resolveAgentVersion > 0
			? Math.trunc(body.resolveAgentVersion)
			: null;

	// Named-agent resolution (cutover P1e): dynamic-script agent(..., {agent})
	// resolves the slug HERE, at dispatch-prepare time — scripts compute slugs
	// in JS, so start-time resolution (resolveSpecAgentRefs) cannot apply.
	// FAIL-CLOSED: an unknown slug is a 422 the orchestrator converts to a
	// journaled null; NEVER a silent fall-through to the metered default
	// runtime. Every response echoes resolvedAgentSlug so a NEW orchestrator
	// detects old-BFF skew (missing echo -> refuse dispatch).
	const resolveAgentSlugRaw =
		typeof body.resolveAgentSlug === "string" && body.resolveAgentSlug.trim()
			? body.resolveAgentSlug.trim()
			: null;
	let resolvedAgentSlug: string | null = null;
	let effectiveAgentId = bodyAgentId;
	let effectiveAgentVersion = bodyAgentVersion;
	let resolvedSavedAgent: SessionCommandAgent | null = null;
  // A prior request may have committed the deterministic session row and then
  // lost its HTTP response. That row is the replay authority: never re-resolve
  // an unpinned/latest agent from the repeated request, because its current
  // version may have advanced between attempts.
	if (existing) {
    if (
      !existing.agentId?.trim() ||
      !Number.isInteger(existing.agentVersion) ||
      (existing.agentVersion ?? 0) <= 0
    ) {
      return error(
        409,
        `Existing session ${existing.id} does not have an exact saved-agent version pin`,
      );
    }
    const pinnedAgentVersion = existing.agentVersion as number;
		const savedAgent = await workflowData.resolveSessionAgentByRef({
			id: existing.agentId,
			version: pinnedAgentVersion,
		});
		if (
			!savedAgent?.config ||
			savedAgent.id !== existing.agentId ||
			savedAgent.version !== pinnedAgentVersion
		) {
      return error(
        409,
        `Existing session ${existing.id} saved-agent version pin could not be resolved exactly`,
			);
		}
		const requestedRefMismatch =
			(bodyAgentId != null && bodyAgentId !== savedAgent.id) ||
			(bodyAgentVersion != null && bodyAgentVersion !== savedAgent.version) ||
			(bodyAgentSlug != null && bodyAgentSlug !== savedAgent.slug) ||
			(resolveAgentVersionRaw != null &&
				resolveAgentVersionRaw !== savedAgent.version) ||
			(resolveAgentSlugRaw != null &&
				resolveAgentSlugRaw !== savedAgent.id &&
				resolveAgentSlugRaw !== savedAgent.slug);
		if (requestedRefMismatch) {
			return error(
				409,
				`Existing session ${existing.id} saved-agent identity does not match the request`,
			);
		}
    if (
      projectId &&
      savedAgent.projectId &&
      savedAgent.projectId !== projectId
    ) {
      return error(
        403,
        `Existing session ${existing.id} saved agent is not in this project`,
      );
    }
		const built = await buildExactSavedAgentConfig(savedAgent);
		if (!built.ok) {
			return error(
				409,
				`Existing session ${existing.id} ${built.message}`,
			);
		}
		agentConfig = built.config;
		resolvedSavedAgent = savedAgent;
		effectiveAgentId = existing.agentId;
		effectiveAgentVersion = pinnedAgentVersion;
		resolvedAgentSlug = resolveAgentSlugRaw;
	} else if (resolveAgentSlugRaw) {
		if (!projectId) {
			return json(
				{
					code: "agent_ref_unresolved",
					error: "named-agent resolution requires a projectId on the run",
				},
				{ status: 422 },
			);
		}
		// opts.agent accepts a project agent SLUG or an agent ID (evals pin ids;
		// authors write slugs). Slug first, then id — both fail closed.
    const resolvedBySlug =
      await getApplicationAdapters().teamStore.resolveAgentIdBySlug(
			projectId,
			resolveAgentSlugRaw,
		);
		let resolvedId = resolvedBySlug?.id ?? null;
		if (!resolvedId) {
			const byId = await workflowData.resolvePublishedWorkflowAgentForEnsure({
				agentId: resolveAgentSlugRaw,
				agentVersion: null,
				projectId,
			});
			if (byId?.ok) resolvedId = resolveAgentSlugRaw;
		}
		if (!resolvedId) {
			return json(
				{
					code: "agent_ref_unresolved",
					error: `agent '${resolveAgentSlugRaw}' not found in project ${projectId} (tried slug, then id)`,
				},
				{ status: 422 },
			);
		}
		effectiveAgentId = resolvedId;
		// Version pin (evals): honored when the caller sends one; otherwise the
		// latest registered version.
		effectiveAgentVersion = resolveAgentVersionRaw;

		// Dynamic-script agent({agent:'slug'}) resolves the slug at RUNTIME, so it
		// bypasses resolveSpecAgentRefs (which inlines a STATIC durable/run node's
		// DB agent config at workflow-start). Load the resolved agent's stored
		// config here and use it as the dispatch base, overlaying ONLY the
    // orchestrator's per-call fields (model/effort/schema/mode) on top —
		// otherwise the session loses the agent's mcpServers / systemPrompt /
		// builtinTools / tools and runs with just the minimal per-call config plus
		// the auto-wired wfb_goal MCP server. (Skills still need registry
		// hydration; tracked separately.)
		try {
			const dbAgent = await workflowData.resolveSessionAgentByRef({
				id: effectiveAgentId ?? undefined,
				version: effectiveAgentVersion ?? undefined,
			});
			if (!dbAgent?.config) {
				return json(
					{
						code: "agent_ref_unresolved",
						error: `agent '${resolveAgentSlugRaw}' has no resolvable published configuration`,
					},
					{ status: 422 },
				);
			}
				if (
				dbAgent.id !== effectiveAgentId ||
				(resolveAgentVersionRaw != null &&
					dbAgent.version !== resolveAgentVersionRaw) ||
				(bodyAgentId != null && bodyAgentId !== dbAgent.id) ||
				(bodyAgentVersion != null && bodyAgentVersion !== dbAgent.version) ||
				(bodyAgentSlug != null && bodyAgentSlug !== dbAgent.slug)
				) {
				return error(409, "resolved saved-agent identity does not match request");
				}
			const built = await buildExactSavedAgentConfig(dbAgent);
			if (!built.ok) {
						return json(
					{ code: "agent_ref_unresolved", error: built.message },
							{ status: 422 },
						);
					}
			agentConfig = built.config;
			resolvedSavedAgent = dbAgent;
			effectiveAgentId = dbAgent.id;
			effectiveAgentVersion = dbAgent.version;
			resolvedAgentSlug = resolveAgentSlugRaw;
		} catch (err) {
			if (
				err &&
				typeof err === "object" &&
				"status" in err &&
				(err as { status?: unknown }).status === 409
			) {
				throw err;
			}
			console.warn(
				"[ensure-for-workflow] failed to load resolved agent config for slug",
				resolvedAgentSlug,
				err,
			);
			return json(
				{
					code: "agent_ref_unresolved",
					error: `agent '${resolveAgentSlugRaw}' configuration could not be resolved`,
				},
				{ status: 422 },
			);
		}
	}
	if (!existing && !resolveAgentSlugRaw && bodyAgentId) {
		const savedAgent = await workflowData.resolveSessionAgentByRef({
			id: bodyAgentId,
			version: bodyAgentVersion ?? undefined,
		});
		if (
			!savedAgent?.config ||
			savedAgent.id !== bodyAgentId ||
			(bodyAgentVersion != null && savedAgent.version !== bodyAgentVersion) ||
			(bodyAgentSlug != null && savedAgent.slug !== bodyAgentSlug)
		) {
			return error(409, "saved-agent identity does not match the request");
		}
		if (
			projectId &&
			savedAgent.projectId &&
			savedAgent.projectId !== projectId
		) {
			return error(403, "saved agent is not in this project");
		}
		const built = await buildExactSavedAgentConfig(savedAgent);
		if (!built.ok) return error(422, built.message);
		agentConfig = built.config;
		resolvedSavedAgent = savedAgent;
		effectiveAgentId = savedAgent.id;
		effectiveAgentVersion = savedAgent.version;
	}
	if (!agentConfig) agentConfig = await prepareAgentConfig(rawAgentConfig);

	// The named-agent branch above may have replaced agentConfig with the
	// resolved DB agent's full config; re-narrow to non-null for the rest of the
	// handler (a null here means both the inline config and the resolved agent
	// were absent).
	if (!agentConfig) return error(400, "agentConfig is required");
	bridgeTimeoutMinutes =
		parsePositiveInteger(body.timeoutMinutes) ??
		parsePositiveInteger(agentConfig.timeoutMinutes);
	bridgeMaxIterations =
		parsePositiveInteger(body.maxIterations) ??
		parsePositiveInteger(body.maxTurns) ??
		parsePositiveInteger(agentConfig.maxTurns);

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
  const isDynamicScriptSpawn =
    spawningWorkflow?.engineType === "dynamic-script";
	const isCliRuntime = swapTarget?.capabilities?.interactiveTerminal === true;
  const workflowMcpSessionToken = (() => {
    if (!projectId) return null;
    try {
      return workflowMcpSessionTokenSigner.sign({
        userId,
        projectId,
        sessionId,
        capabilities: {
          scriptDepth: isDynamicScriptSpawn ? 1 : 0,
          teamId: null,
          teamRole: "none",
        },
      });
    } catch (err) {
      console.warn(
        `[ensure-for-workflow] workflow MCP session token unavailable for ${sessionId}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  })();
  if (!workflowMcpSessionToken) {
    return error(
      500,
      `Session ${sessionId} cannot start without signed lifecycle authority`,
    );
  }
  // Goals are authored in code (dynamic-script) and completed by the BFF
  // evidence backstop; the goal MCP server is no longer auto-wired. Only
  // explicitly-configured MCP servers reach the dispatched session.
  const configuredMcpServers =
    (baseDispatchAgentConfig as { mcpServers?: unknown[] }).mcpServers ?? [];
  let dispatchAgentConfig: AgentConfig = {
    ...baseDispatchAgentConfig,
    mcpServers: configuredMcpServers,
  } as AgentConfig;
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
	// Give agent-browser this run's artifact identity, while always deleting
	// legacy target hosts, raw credentials, and prior assertions before
	// config/version persistence. Only a purpose-limited assertion is added to
	// the execution config below; the browser bridge exchanges it just in time.
	dispatchAgentConfig = {
		...dispatchAgentConfig,
		mcpServers: stampAgentBrowserRunHeaders(
			(dispatchAgentConfig as { mcpServers?: unknown[] }).mcpServers ?? [],
			{ executionId: workflowExecutionId, workflowId, nodeId },
			null,
		),
	} as AgentConfig;
	const dispatchMcpServers =
		(dispatchAgentConfig as { mcpServers?: unknown[] }).mcpServers ?? [];
	const authenticatedMcpServers = stampWorkflowMcpSessionAuth(
		dispatchMcpServers,
		sessionId,
		workflowMcpSessionToken,
	);
	let executionDispatchAgentConfig = {
		...dispatchAgentConfig,
		mcpServers: authenticatedMcpServers,
	} as AgentConfig;
	if (workflowExecutionId && hasAgentBrowserServer(dispatchMcpServers)) {
		const targetAuthAssertion = await workflowTargetAuth.mintAssertion({
			executionId: workflowExecutionId,
			expectedUserId: userId,
			expectedProjectId: projectId,
		});
		if (targetAuthAssertion) {
			executionDispatchAgentConfig = {
				...executionDispatchAgentConfig,
				mcpServers: stampAgentBrowserRunHeaders(
					authenticatedMcpServers,
					{ executionId: workflowExecutionId, workflowId, nodeId },
					targetAuthAssertion,
				),
			} as AgentConfig;
		}
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
  // cleaned up by the lifecycle controller. The external create happens only
  // after the session/parent stop fence is committed below.
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
  const shouldAutoProvisionOpenShellSandbox =
    needsOpenShellSandbox && !hasWiredSandbox;
  const autoSandboxTemplate =
    typeof (agentConfig as { sandboxTemplate?: unknown }).sandboxTemplate ===
    "string"
						? ((agentConfig as { sandboxTemplate?: string })
								.sandboxTemplate as string)
      : "base";
  const provisionAutoWorkspace = async (): Promise<boolean> => {
    try {
      const provisioned =
        await sessionCommands.provisionWorkflowSessionWorkspace({
          sessionId,
          title,
          sandboxTemplate: autoSandboxTemplate,
			});
      if (provisioned.status === "stopping") return false;
      bridgeSandboxName = provisioned.sandboxName;
      bridgeWorkspaceRef = provisioned.workspaceRef ?? bridgeWorkspaceRef;
			console.log(
        `[ensure-for-workflow] auto-provisioned OpenShell sandbox ${provisioned.sandboxName} for ${swapTarget?.id} session ${sessionId}`,
			);
      return true;
		} catch (err) {
      throw error(
        503,
        err instanceof Error
          ? err.message
          : "OpenShell sandbox provisioning failed",
      );
	}
  };
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
	if (existing) {
		if (!resolvedSavedAgent) {
			return error(
        409,
        `Existing session ${existing.id} saved-agent version pin is unavailable`,
      );
    }
		await sessionCommands.syncWorkflowSessionAgentRuntime({
			agentId: existing.agentId,
			bestEffort: true,
			context: `existing session ${sessionId}`,
		});
    const [existingDetail, existingOwner] = existing.runtimeAppId?.trim()
      ? await Promise.all([
          workflowData.getSessionDetail({ sessionId: existing.id }),
          workflowData.getSessionFileOwner(existing.id),
        ])
      : [null, null];
    const persistedRuntimeAppId =
      existing.runtimeAppId?.trim() &&
      existingDetail?.daprInstanceId?.trim() &&
      existingOwner != null &&
      existingOwner.stopRequestedAt == null &&
      existingOwner.completedAt == null &&
      existingOwner.status !== "terminated"
        ? existing.runtimeAppId.trim()
        : null;
		// Also wake on replay/idempotent hits — the orchestrator's
		// `ctx.call_child_workflow` still needs the target pod live.
    const configuredAgentAppId = (
      dispatchAgentConfig as AgentConfig & { agentAppId?: unknown }
    ).agentAppId;
		const pinnedConfigAppId =
			typeof configuredAgentAppId === "string" && configuredAgentAppId.trim()
				? configuredAgentAppId.trim()
				: resolvedSavedAgent.runtimeAppId;
		const reuseRoute = resolveAgentRuntimeRoute({
			agentSlug: resolvedSavedAgent.slug,
      runtimeAppId: pinnedConfigAppId,
      config: dispatchAgentConfig,
    });
		const reuseRuntime = {
			slug: resolvedSavedAgent.slug,
      appId: reuseRoute.appId,
    };
    const reuseAgentAppId = persistedRuntimeAppId ?? reuseRuntime.appId;
		const reuseWakeSlug = await resolveWakeSlug({
			workflowData,
			bodyAgentSlug: resolvedSavedAgent.slug,
			bodyAgentAppId: reuseAgentAppId,
			agentConfig: dispatchAgentConfig,
			agentId: existing.agentId,
		});
    let reuseHost: Awaited<ReturnType<typeof maybeProvisionAgentWorkflowHost>> =
      null;
    let reuseChildAppId: string | null = persistedRuntimeAppId;
    let reuseRuntimeSandboxName: string | null =
      resolvePublishedSessionRuntimeSandboxName({
        runtimeAppId: persistedRuntimeAppId,
        runtimeSandboxName: existing.runtimeSandboxName,
      });
    let reusePublishedHostReadiness: "ready" | "not_ready" | null = null;
    if (persistedRuntimeAppId && reuseRuntimeSandboxName) {
      const publishedHost = await sessionRuntimeHostRecovery.ensurePublished({
        sessionId: existing.id,
        runtimeAppId: persistedRuntimeAppId,
        runtimeSandboxName: reuseRuntimeSandboxName,
        sessionSecretEnv: workflowSessionSecretEnv,
        traceContext,
      });
      reusePublishedHostReadiness = publishedHost.readiness;
    }
    if (!persistedRuntimeAppId) {
      const provisioningLease =
        await workflowData.reserveSessionRuntimeProvisioning({
          sessionId: existing.id,
        });
      if (!provisioningLease) {
        const owner =
          existingOwner ??
          (await workflowData.getSessionFileOwner(existing.id));
        const stopping =
          owner?.stopRequestedAt != null ||
          owner?.completedAt != null ||
          owner?.status === "terminated";
        return json(
          stopping
            ? {
                error: "session_stopping",
                message: `Session ${existing.id} is stopping or terminal`,
              }
            : {
                error: "session_provisioning",
                message: `Session ${existing.id} runtime provisioning is already in progress`,
                retryable: true,
              },
          {
            status: stopping ? 409 : 503,
            headers: stopping ? undefined : { "Retry-After": "1" },
          },
        );
      }
      let reuseLeaseClosed = false;
      const cleanupReuseProvisioning = async (): Promise<void> => {
        if (reuseLeaseClosed) return;
        reuseLeaseClosed = true;
        await sessionCommands.cleanupUnpublishedRuntimeProvisioning({
          sessionId: existing.id,
          sandboxName: reuseHost?.sandboxName ?? null,
          leaseStartedAt: provisioningLease.startedAt,
        });
      };
      try {
        if (
          shouldAutoProvisionOpenShellSandbox &&
          !(await provisionAutoWorkspace())
        ) {
          await cleanupReuseProvisioning();
          return json(
            {
              error: "session_stopping",
              message: `Session ${existing.id} stopped while its workspace was provisioning`,
            },
            { status: 409 },
          );
        }
        reuseHost = await maybeProvisionAgentWorkflowHost({
			sessionId: existing.id,
			agentConfig: executionDispatchAgentConfig,
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
          sharedWorkspaceKey: runtimeUsesSharedWorkspace(
            swapTarget?.capabilities,
          )
					? (bridgeWorkspaceRef ?? workflowExecutionId)
					: null,
			seedWorkspaceFrom: bridgeSeedWorkspaceFrom,
          provisioningStartedAt: provisioningLease.startedAt,
		});
        reuseChildAppId = reuseHost?.agentAppId ?? reuseAgentAppId;
        reuseRuntimeSandboxName =
			reuseHost?.sandboxName ?? existing.runtimeSandboxName ?? null;
        if (!reuseChildAppId) {
          await cleanupReuseProvisioning();
          return error(500, "could not resolve peer runtime target");
        }
        const attached = await workflowData.updateWorkflowEnsureSessionRuntime({
				sessionId: existing.id,
          expectedStartedAt: provisioningLease.startedAt,
				runtimeAppId: reuseChildAppId,
				runtimeSandboxName: reuseRuntimeSandboxName,
          runtimeHostOwned: reuseHost?.sandboxName != null,
          runtimeHostLaunchSpec: reuseHost?.launchSpec ?? null,
			});
        if (!attached) {
          await cleanupReuseProvisioning();
          return json(
            {
              error: "session_stopping",
              message: `Session ${existing.id} stopped while its runtime host was provisioning`,
            },
            { status: 409 },
          );
        }
        reuseLeaseClosed = true;
        if (reuseHost?.sandboxName) {
          const publishedHost = await sessionRuntimeHostRecovery.ensurePublished({
            sessionId: existing.id,
            runtimeAppId: reuseChildAppId,
            runtimeSandboxName: reuseHost.sandboxName,
            sessionSecretEnv: workflowSessionSecretEnv,
            traceContext,
          });
          reusePublishedHostReadiness = publishedHost.readiness;
        }
      } catch (caught) {
        await cleanupReuseProvisioning();
        throw caught;
      }
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
    await sessionCommands.materializeWorkflowSessionRepositories({
      sessionId: existing.id,
      repositories: dispatchAgentConfig.repositories,
      workflowExecutionId: existing.workflowExecutionId ?? workflowExecutionId,
      workspaceRef: bridgeWorkspaceRef,
      cwd: bridgeCwd,
    });
		return json({
			sessionId: existing.id,
			agentId: existing.agentId,
			agentVersion: existing.agentVersion,
			...(resolvedAgentSlug ? { resolvedAgentSlug } : {}),
      agentSlug: reuseRuntime.slug,
			agentAppId: reuseChildAppId,
			runtimeSandboxName: reuseRuntimeSandboxName,
			agentHostStatus:
				reusePublishedHostReadiness === "ready"
					? "ready"
					: reusePublishedHostReadiness === "not_ready"
						? "queued"
						: (reuseHost?.status ?? null),
			childInput: buildChildInput({
				sessionId: existing.id,
        workflowMcpSessionToken,
				agentConfig: executionDispatchAgentConfig,
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
        agentId: existing.agentId,
        agentVersion: existing.agentVersion,
        agentSlug: reuseRuntime.slug,
				agentAppId: reuseChildAppId,
				activeModelId: resolvedSavedAgent.mlflowModelVersion ?? null,
				activeModelName: resolvedSavedAgent.mlflowModelName ?? null,
				activeModelUri: resolvedSavedAgent.mlflowUri ?? null,
			}),
			reused: true,
		});
	}

	// Resolved workflow specs carry the original published agent identity.
	// Use it when present so workflow-driven sessions execute in the published
	// agent-runtime-<slug> pod. Specs without that identity are older inline
	// configs and still get a workflow-scoped ephemeral agent.
	const publishedAgent = await resolvePublishedWorkflowAgent(workflowData, {
		agentId: effectiveAgentId,
		agentVersion: effectiveAgentVersion,
		projectId,
	});
	if (
		resolvedSavedAgent &&
		(!publishedAgent ||
			publishedAgent.agentId !== resolvedSavedAgent.id ||
			publishedAgent.agentVersion !== resolvedSavedAgent.version)
	) {
		return error(409, "published agent identity does not match saved version");
	}
	const sessionAgent = await sessionCommands.resolveWorkflowSessionAgent({
		publishedAgent,
		workflowId,
		nodeId,
		agentConfig: dispatchAgentConfig,
		userId,
	});
	const { agentId, agentVersion } = sessionAgent;
	if (
		resolvedSavedAgent &&
		(agentId !== resolvedSavedAgent.id ||
			agentVersion !== resolvedSavedAgent.version)
	) {
		return error(409, "workflow session agent does not match saved version");
	}
	await sessionCommands.syncWorkflowSessionAgentRuntime({ agentId });
	const savedDispatchAppId = (
		dispatchAgentConfig as AgentConfig & { agentAppId?: unknown }
	).agentAppId;
	const runtimeIdentity = resolvedSavedAgent
		? {
				slug: resolvedSavedAgent.slug,
				appId: resolveAgentRuntimeRoute({
					agentSlug: resolvedSavedAgent.slug,
					runtimeAppId:
						typeof savedDispatchAppId === "string" && savedDispatchAppId.trim()
							? savedDispatchAppId.trim()
							: resolvedSavedAgent.runtimeAppId,
					config: dispatchAgentConfig,
				}).appId,
			}
		: await resolveRuntimeIdentity(workflowData, agentId);

	// Create the session row with the deterministic id. We bypass createSession's
	// auto-id generation by inserting directly, then reuse createSession's
	// defaults via a follow-up lookup. To keep a single code path, we do a
	// direct insert here since createSession doesn't accept a pre-computed id.
  let incomingSandboxName =
		bridgeSandboxName ?? dispatchAgentConfig.runtime ?? "dapr-agent-py";
  const provisioningLease = await workflowData.createWorkflowEnsureSession({
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
  if (!provisioningLease) {
    return error(409, "workflow execution is stopping or terminal");
  }
  let provisioningLeaseClosed = false;
  let sessionHost: Awaited<ReturnType<typeof maybeProvisionAgentWorkflowHost>> =
    null;
  let sessionPublishedHostReadiness: "ready" | "not_ready" | null = null;
  let childAgentAppId: string | null = null;
  let childRuntimeSandboxName: string | null = null;
  const cleanupProvisioning = async (): Promise<void> => {
    if (provisioningLeaseClosed) return;
    provisioningLeaseClosed = true;
    await sessionCommands.cleanupUnpublishedRuntimeProvisioning({
      sessionId,
      sandboxName: sessionHost?.sandboxName ?? null,
      leaseStartedAt: provisioningLease.startedAt,
    });
  };
  try {
    if (
      shouldAutoProvisionOpenShellSandbox &&
      !(await provisionAutoWorkspace())
    ) {
      await cleanupProvisioning();
      return json(
        {
          error: "session_stopping",
          message: `Session ${sessionId} stopped while its workspace was provisioning`,
        },
        { status: 409 },
      );
    }
    incomingSandboxName = bridgeSandboxName ?? incomingSandboxName;
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
    sessionHost = await maybeProvisionAgentWorkflowHost({
		sessionId,
		agentConfig: executionDispatchAgentConfig,
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
    sharedWorkspaceKey: runtimeUsesSharedWorkspace(swapTarget?.capabilities)
				? (bridgeWorkspaceRef ?? workflowExecutionId)
				: null,
		seedWorkspaceFrom: bridgeSeedWorkspaceFrom,
      provisioningStartedAt: provisioningLease.startedAt,
	});
    childAgentAppId = sessionHost?.agentAppId ?? targetAgentAppId;
	// Concurrency plan P3: when a shared-pool runtime skipped the per-session
	// host, the identity the orchestrator stamped (legacy shared app id, e.g.
	// "dapr-agent-py") must be re-routed through the pool resolver so the
	// session multiplexes onto the standing pool Deployment
	// (agent-runtime-pool-<class>) instead of the legacy Deployment.
	if (
		!sessionHost &&
		getRuntimeDescriptor(
			(dispatchAgentConfig as { runtime?: string } | null)?.runtime,
		)?.hostMode === "shared-pool"
	) {
		const poolRoute = resolveAgentRuntimeRoute({
			agentSlug: bodyAgentSlug ?? dispatchAgentConfig?.runtime ?? "agent",
			runtimeAppId: targetAgentAppId,
			config: dispatchAgentConfig,
		});
		if (poolRoute.isolation === "shared") {
			childAgentAppId = poolRoute.appId;
		}
	}
    childRuntimeSandboxName = sessionHost?.sandboxName ?? null;
	if (childAgentAppId) {
      const attached = await workflowData.updateWorkflowEnsureSessionRuntime({
			sessionId,
        expectedStartedAt: provisioningLease.startedAt,
			runtimeAppId: childAgentAppId,
			runtimeSandboxName: childRuntimeSandboxName,
        runtimeHostOwned: sessionHost?.sandboxName != null,
        runtimeHostLaunchSpec: sessionHost?.launchSpec ?? null,
		});
      if (!attached) {
        await cleanupProvisioning();
        return json(
          {
            error: "session_stopping",
            message: `Session ${sessionId} stopped while its runtime host was provisioning`,
          },
          { status: 409 },
        );
      }
      provisioningLeaseClosed = true;
      if (sessionHost?.sandboxName) {
        const publishedHost = await sessionRuntimeHostRecovery.ensurePublished({
          sessionId,
          runtimeAppId: childAgentAppId,
          runtimeSandboxName: sessionHost.sandboxName,
          sessionSecretEnv: workflowSessionSecretEnv,
          traceContext,
        });
        sessionPublishedHostReadiness = publishedHost.readiness;
      }
    } else {
      await cleanupProvisioning();
      return error(500, "could not resolve workflow session runtime target");
    }
  } catch (caught) {
    await cleanupProvisioning();
    throw caught;
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
		...(resolvedAgentSlug ? { resolvedAgentSlug } : {}),
		agentSlug: runtimeIdentity?.slug ?? bodyAgentSlug,
		agentAppId: childAgentAppId,
		runtimeSandboxName: childRuntimeSandboxName,
		agentHostStatus:
			sessionPublishedHostReadiness === "ready"
				? "ready"
				: sessionPublishedHostReadiness === "not_ready"
					? "queued"
					: (sessionHost?.status ?? null),
		childInput: buildChildInput({
			sessionId,
      workflowMcpSessionToken,
			agentConfig: executionDispatchAgentConfig,
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
			activeModelId: resolvedSavedAgent
				? resolvedSavedAgent.mlflowModelVersion
				: publishedAgent?.mlflowModelVersion ?? null,
			activeModelName: resolvedSavedAgent
				? resolvedSavedAgent.mlflowModelName
				: publishedAgent?.mlflowModelName ?? null,
			activeModelUri: resolvedSavedAgent
				? resolvedSavedAgent.mlflowUri
				: publishedAgent?.mlflowUri ?? null,
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
  workflowMcpSessionToken: string | null;
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
    workflowMcpSessionToken: params.workflowMcpSessionToken,
		agentId: params.agentId ?? null,
		agentVersion: params.agentVersion ?? null,
		agentConfig: params.agentConfig,
		instructionBundle: params.instructionBundle ?? null,
		agentSlug: params.agentSlug ?? null,
		agentAppId: params.agentAppId ?? null,
    requiresStartAuthority: true,
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
