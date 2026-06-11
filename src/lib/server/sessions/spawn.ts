import { daprFetch } from "$lib/server/dapr-client";
import { attachRuntime, getSession } from "$lib/server/sessions/registry";
import { resolveAgentRef } from "$lib/server/agents/registry";
import { resolveEnvironmentRef } from "$lib/server/environments/registry";
import { appendEvent, listEvents } from "$lib/server/sessions/events";
import { rewriteMcpForBrowserSidecar } from "$lib/server/agents/mcp-sidecar";
import { resolveAgentConfigMcpForProject } from "$lib/server/agents/mcp-resolution";
import { compilePromptStack } from "$lib/server/prompt-presets";
import {
	agentRuntimeDedicatedAppId,
	agentRuntimeInvokeTarget,
	resolveAgentRuntimeRoute,
} from "$lib/server/agents/runtime-routing";
import {
	maybeProvisionAgentWorkflowHost,
	waitForAgentWorkflowHostAppReady,
} from "$lib/server/sessions/agent-workflow-host";
import { resolveSessionRuntimeTarget } from "$lib/server/sessions/runtime-target";
import { getRuntimeDescriptor } from "$lib/server/agents/runtime-registry";
import { evaluateSwap } from "$lib/server/agents/swap-safety";
import {
	CliTokenError,
	getUserCliCredential,
} from "$lib/server/users/cli-credentials";
import { mountSessionRepositoriesViaHost } from "$lib/server/sessions/repositories";

function modelIdFromMlflowUri(value: string | null | undefined): string | null {
	const text = value?.trim() ?? "";
	const match = text.match(/^models:\/([^/]+)$/);
	return match?.[1] ?? null;
}

/** Session owner (sessions.userId) — not part of the public SessionDetail
 * shape, so read it directly for the CLI-token gate. */
async function resolveSessionOwnerUserId(
	sessionId: string,
): Promise<string | null> {
	const { db } = await import("$lib/server/db");
	if (!db) return null;
	const { sessions } = await import("$lib/server/db/schema");
	const { eq } = await import("drizzle-orm");
	const [row] = await db
		.select({ userId: sessions.userId })
		.from(sessions)
		.where(eq(sessions.id, sessionId))
		.limit(1);
	return row?.userId ?? null;
}

/**
 * Spawn a `session_workflow` instance in `dapr-agent-py` for the given
 * session row. Uses the Dapr sidecar's workflow API directly — no new
 * orchestrator endpoint, no new Dapr primitive. The sidecar URL resolves
 * from `DAPR_HTTP_ENDPOINT` / `DAPR_HTTP_PORT` the same way other callers
 * use it.
 *
 * Idempotent: if a workflow instance with the session's id already exists,
 * returns the existing instance without re-starting.
 */
export async function spawnSessionWorkflow(sessionId: string): Promise<{
	instanceId: string;
	natsSubject: string;
}> {
	const session = await getSession(sessionId);
	if (!session) throw new Error(`Session ${sessionId} not found`);

	// If we already have a Dapr instance ID recorded, short-circuit.
	if (session.daprInstanceId) {
		return {
			instanceId: session.daprInstanceId,
			natsSubject: session.natsSubject ?? `session.events.${sessionId}`,
		};
	}

	const agent = await resolveAgentRef({
		id: session.agentId,
		version: session.agentVersion ?? undefined,
	});
	if (!agent) throw new Error(`Agent ${session.agentId} not found`);

	// Enrich callableAgents: config stores slugs; the runtime needs full
	// metadata ({slug, agentId, appId, team, registryKey}) to dispatch to
	// the peer's app_id without re-hitting the registry. Mirrors what the
	// workflow resolver does for durable/run nodes.
	const callableSlugs = Array.isArray(agent.config.callableAgents)
		? agent.config.callableAgents
		: [];
	const callableAgents = await (async () => {
		if (!agent.projectId || callableSlugs.length === 0) return [] as Array<{
			slug: string;
			agentId: string;
			version: number;
			appId: string;
			team: string;
			registryKey: string;
		}>;
		const { resolveCallableAgents } = await import("$lib/server/agents/registry");
		const { agentRegistryKey } = await import(
			"$lib/server/agents/registry-sync"
		);
		const peers = await resolveCallableAgents(agent.projectId, callableSlugs);
		return peers.map((p) => ({
			slug: p.slug,
			agentId: p.agentId,
			version: p.version,
			appId: p.runtimeAppId ?? agentRuntimeDedicatedAppId(p.slug),
			team: agent.projectId as string,
			registryKey: agentRegistryKey(agent.projectId as string, p.slug),
		}));
	})();

	const environment = session.environmentId
		? await resolveEnvironmentRef({
				id: session.environmentId,
				version: session.environmentVersion ?? undefined,
			})
		: null;

	// Seed the workflow with any events the user already posted between
	// session.create and workflow spawn (e.g. an `initialMessage` sent via
	// POST /api/v1/sessions).
	const existingEvents = await listEvents(sessionId, { limit: 50 });
	const initialEvents = existingEvents
		.filter((e) => e.type.startsWith("user."))
		.map((e) => e.data);

	// Rewrite Playwright MCP entries to point at the per-agent browser
	// sidecar (http://localhost:3100/mcp). The DB config stores stdio
	// presets from agent-mcp-picker; sending those unmodified makes the
	// agent try to launch Chromium inside the dapr-agent-py container
	// (no binary). The per-turn config wins at runtime over the bootstrap
	// env var (see dapr-agent-py _ensure_mcp_client_async), so this
	// rewrite must happen here — registry-sync only covers the bootstrap.
	const resolvedAgentConfig = await resolveAgentConfigMcpForProject(
		agent.config,
		agent.projectId,
	);
	const { mcpServers: rewrittenMcp, useBrowserSidecar } =
		resolvedAgentConfig.runtime === "browser-use-agent"
			? {
					mcpServers:
						((resolvedAgentConfig as { mcpServers?: unknown[] })
							.mcpServers as never) ?? [],
					useBrowserSidecar: false,
				}
			: rewriteMcpForBrowserSidecar(
					(resolvedAgentConfig as { mcpServers?: unknown[] }).mcpServers as never,
				);
	const runtimeRoute = resolveAgentRuntimeRoute({
		agentSlug: agent.slug,
		runtimeAppId: agent.runtimeAppId,
		config: resolvedAgentConfig,
		useBrowserSidecar,
	});
	// Swap-safety gate (Phase 3): surface when the dispatched runtime would
	// drop a capability the agent's config relies on (e.g. an unsupported model
	// provider, or MCP on a non-MCP runtime). WARN-first: logs the degraded
	// capabilities; only hard-fails when AGENT_RUNTIME_REJECT_LOSSY_SWAP is set.
	// Normal spawns (agent on its own runtime) resolve to "allow".
	const swapTarget = getRuntimeDescriptor(
		(resolvedAgentConfig as { runtime?: string }).runtime,
	);
	if (swapTarget) {
		const verdict = evaluateSwap(
			resolvedAgentConfig as Record<string, unknown>,
			swapTarget,
			// The agent row's configured runtime is the swap SOURCE; crossing the
			// interactive-cli family boundary is reject-class (interaction model
			// changes, not just feature degradation).
			{ sourceFamily: getRuntimeDescriptor(agent.runtime)?.family ?? null },
		);
		if (verdict.drops.length > 0) {
			console.warn(
				`[swap-safety] session ${sessionId} \u2192 runtime "${swapTarget.id}" ${verdict.decision}: ` +
					verdict.drops.map((d) => `${d.capability}(${d.severity})`).join(", "),
			);
			for (const d of verdict.drops) console.warn(`[swap-safety]   ${d.detail}`);
			// Surface the degraded swap as a session event so it's queryable in
			// session_events + visible in the UI (the WARN-phase audit dataset).
			// Fire-and-forget with a deterministic sourceEventId (dedupes re-spawns);
			// an event-write failure must never block the spawn.
			void appendEvent(sessionId, {
				type: "runtime.swap_degraded",
				data: {
					runtimeId: swapTarget.id,
					decision: verdict.decision,
					drops: verdict.drops,
				},
				sourceEventId: `swap:${sessionId}:${swapTarget.id}`,
			}).catch((err) =>
				console.warn(
					`[swap-safety] swap_degraded event emit failed: ${err instanceof Error ? err.message : err}`,
				),
			);
			if (verdict.decision === "reject") {
				throw new Error(
					`Runtime "${swapTarget.id}" cannot satisfy required agent capabilities: ` +
						verdict.drops
							.filter((d) => d.severity === "reject")
							.map((d) => d.detail)
							.join("; "),
				);
			}
		}
	}
	// Resolve Prompt Workbench preset bindings (version-pinned) into raw text
	// arrays the runtime can stitch into the bundle without DB access. Fail
	// open: a missing preset must never block a session spawn.
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
	const compiledPresetStack = agent.projectId
		? await compilePromptStack(resolvedAgentConfig, {
				projectId: agent.projectId,
			}).catch((err) => {
				console.warn(
					"[session-spawn] compilePromptStack failed, continuing with empty stack:",
					err instanceof Error ? err.message : err,
				);
				return emptyPresetStack;
			})
		: emptyPresetStack;
	const agentConfigForDispatch = {
		...resolvedAgentConfig,
		mcpServers: stampGoalMcpSessionHeader(
			ensureGoalMcpServer(rewrittenMcp, swapTarget?.capabilities?.supportsMcp ?? false),
			sessionId,
		),
		compiledStaticPresetSections: compiledPresetStack.static,
		compiledDynamicPresetSections: compiledPresetStack.dynamic,
		// Phase 3a v2: per-ref version-id + mlflow_uri manifest so
		// dapr-agent-py can stamp `tag.prompt_version_id` / `tag.prompt_version`
		// on agent traces. Empty array when no presets are bound.
		promptPresetManifest: [
			...compiledPresetStack.staticManifest,
			...compiledPresetStack.dynamicManifest,
		],
	};

	// Interactive-CLI lane: the runtime hosts the real CLI TUI in the session
	// pod. The host selects the adapter from `agentConfig.cliAdapter`, stamped
	// here from the runtime descriptor (one image hosts claude/codex/agy).
	if (swapTarget?.capabilities?.interactiveTerminal && swapTarget.cliAdapter) {
		(agentConfigForDispatch as Record<string, unknown>).cliAdapter =
			swapTarget.cliAdapter;
	}

	// OAuth credential delivery, generalized over cliAuth.credentialKind:
	//   - env_token / file → resolve the session owner's stored credential and
	//     deliver it as the secret env var (`sessionSecretEnv`); the in-pod
	//     adapter consumes it (env_token: read directly; file: seed() writes the
	//     credential file). Fail fast with a typed 412-mappable error if missing.
	//   - device_login → no pre-provisioned credential; the user completes the
	//     in-terminal device-code OAuth flow on first launch. No gate, no secret.
	// Tokens are NEVER placed in agentConfig or the Dapr payload.
	let sessionSecretEnv: Record<string, string> | null = null;
	const cliAuth = swapTarget?.capabilities?.interactiveTerminal
		? swapTarget.cliAuth
		: undefined;
	if (cliAuth && cliAuth.credentialKind !== "device_login") {
		const { provider, envVar, setupCommand } = cliAuth;
		if (!envVar) {
			throw new Error(
				`Runtime "${swapTarget?.id}" cliAuth.credentialKind=${cliAuth.credentialKind} requires an envVar`,
			);
		}
		const setupHint = setupCommand ? `run \`${setupCommand}\` locally` : "see the runtime docs";
		const ownerUserId = await resolveSessionOwnerUserId(sessionId);
		const credential = ownerUserId
			? await getUserCliCredential(ownerUserId, provider)
			: null;
		if (!credential) {
			throw new CliTokenError(
				"CLI_TOKEN_MISSING",
				provider,
				`No ${provider} CLI credential linked for this user. ` +
					`Add one under Settings → CLI tokens (${setupHint}).`,
			);
		}
		if (credential.expiresAt && credential.expiresAt.getTime() < Date.now()) {
			throw new CliTokenError(
				"CLI_TOKEN_EXPIRED",
				provider,
				`The linked ${provider} CLI credential has expired. ` +
					`Re-enroll under Settings → CLI tokens (${setupHint}).`,
			);
		}
		sessionSecretEnv = { [envVar]: credential.token };
	}

	// Resolve the dispatch app-id. Two paths share the same downstream shape
	// (Dapr service-invoke into `/internal/sessions/spawn`); only the pod
	// backing the app-id differs:
	//   1. Kueue Sandbox path (preferred for non-browser agents): a fresh
	//      `agents.x-k8s.io/v1alpha1 Sandbox` is admitted via Kueue, the pod
	//      gets a deterministic `agent-session-<sha20>` app-id, and the BFF
	//      blocks until the pod is ready. No wake handshake needed.
	//   2. SandboxWarmPool path (browser-use-agent + Playwright MCP): per-slug
	//      pool emitted at agent publish; we patch `spec.replicas: 1` on demand
	//      via `wakeAgentRuntime` and the upstream agent-sandbox controller
	//      manages the pod.
	const sessionHost = await maybeProvisionAgentWorkflowHost({
		sessionId,
		agentConfig: agentConfigForDispatch,
		workflowExecutionId: session.workflowExecutionId ?? null,
		benchmarkRunId: null,
		benchmarkInstanceId: null,
		timeoutMinutes: null,
		sessionSecretEnv,
	}).catch((err) => {
		console.warn(
			`[session-spawn] sandbox provision failed, falling back to warm-pool wake:`,
			err instanceof Error ? err.message : err,
		);
		return null;
	});
	const targetAppId = sessionHost?.agentAppId ?? runtimeRoute.appId;
	if (!sessionHost) {
		try {
			const { wakeAgentRuntime } = await import(
				"$lib/server/kube/client"
			);
			await wakeAgentRuntime(runtimeRoute.slug, 30_000);
		} catch (err) {
			console.warn(
				`[session-spawn] wake ${runtimeRoute.slug} failed, continuing anyway:`,
				err instanceof Error ? err.message : err,
			);
		}
	}

		const mlflowSessionId = session.mlflowSessionId ?? session.id;
		const activeModelUri = agent.mlflowUri ?? null;
		const activeModelId = agent.mlflowModelVersion ?? modelIdFromMlflowUri(activeModelUri);
		const mlflowContext = session.mlflowRunId
			? {
					experimentId: session.mlflowExperimentId ?? undefined,
					traceExperimentId:
						process.env.MLFLOW_TRACE_EXPERIMENT_ID ??
						session.mlflowExperimentId ??
						undefined,
					traceExperimentName:
						process.env.MLFLOW_TRACE_EXPERIMENT_NAME ?? undefined,
					runId: session.mlflowRunId,
					parentRunId: session.mlflowParentRunId ?? null,
					mlflowSessionId,
					activeModelId,
					activeModelName: agent.mlflowModelName ?? null,
					activeModelUri,
					traceGroupId: session.id,
					applicationKind: "agent",
					applicationId: agent.id,
				}
			: null;
		const payload = {
			sessionId,
			agentId: agent.id,
			agentVersion: session.agentVersion ?? agent.version ?? null,
		agentSlug: agent.slug,
		agentAppId: targetAppId,
		agentRuntimeClass: runtimeRoute.runtimeClass,
		agentRuntimeIsolation: runtimeRoute.isolation,
		runtimeConfigInspectionVersion: 1,
		agentConfig: agentConfigForDispatch,
		// Flat metadata the call_agent tool needs to dispatch peers by name.
		callableAgents,
		registryTeam: agent.projectId ?? null,
		environmentConfig: environment ? environment.config : null,
		vaultIds: session.vaultIds,
		dbExecutionId: session.workflowExecutionId ?? null,
		// UI sessions get a per-session OpenShell sandbox provisioned on
		// create (see src/lib/server/sandboxes/provision.ts). session_workflow
		// inlines this into every child agent_workflow turn so
		// OpenShellRuntime.set_sandbox_name(...) fires before tool execution.
		// Workflow-driven sessions leave this null — the preceding
		// workspace_profile node provides its own sandboxName.
			sandboxName: session.workspaceSandboxName ?? null,
			mlflowSessionId,
			mlflowContext,
			initialEvents,
		};

	const instanceId = sessionId;
	const daprEndpoint = getDaprSidecarUrl();
	// Per-agent runtime pods now live in the same namespace as the
	// BFF + orchestrator (workflow-builder). Bare app-id routing works
	// for Dapr service-invoke within a namespace. Cross-namespace
	// suffix (`<app-id>.<ns>`) is only appended when
	// AGENT_RUNTIME_NAMESPACE is overridden away from the BFF's own
	// namespace — supports the rollback path back to openshell.
	const invokeTarget = agentRuntimeInvokeTarget(targetAppId);
	let directRuntimeBaseUrl: string | null = null;
	if (sessionHost) {
		const ready = await waitForAgentWorkflowHostAppReady({
			agentAppId: targetAppId,
		});
		directRuntimeBaseUrl = ready.baseUrl;
	}
	// Interactive-CLI runtimes work in the agent pod's own /sandbox (no
	// OpenShell workspace sandbox), so attached repos are cloned via the host's
	// `/internal/workspace/command` BEFORE the TUI starts. Best-effort —
	// failures emit session events, never block the spawn.
	if (directRuntimeBaseUrl && swapTarget?.capabilities?.interactiveTerminal) {
		try {
			await mountSessionRepositoriesViaHost(sessionId, directRuntimeBaseUrl);
		} catch (err) {
			console.warn(
				`[session-spawn] host repository mount failed for ${sessionId}:`,
				err instanceof Error ? err.message : err,
			);
		}
	}
	const res = await (directRuntimeBaseUrl
		? daprFetch(`${directRuntimeBaseUrl}/internal/sessions/spawn`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ instanceId, payload }),
				maxRetries: 0,
			})
		: daprFetch(
				`${daprEndpoint}/v1.0/invoke/${encodeURIComponent(invokeTarget)}/method/internal/sessions/spawn`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ instanceId, payload }),
				},
			));
	if (!res.ok && res.status !== 409) {
		const text = await res.text().catch(() => "");
		throw new Error(
			`Dapr workflow start failed (${res.status}): ${text.slice(0, 200)}`,
		);
	}

	const natsSubject = `session.events.${sessionId}`;
	await attachRuntime(sessionId, {
		daprInstanceId: instanceId,
		natsSubject,
		runtimeAppId: targetAppId,
		runtimeSandboxName: sessionHost?.sandboxName ?? null,
	});

	return { instanceId, natsSubject };
}

function getDaprSidecarUrl(): string {
	const host = process.env.DAPR_HOST ?? "127.0.0.1";
	const port = process.env.DAPR_HTTP_PORT ?? "3500";
	return `http://${host}:${port}`;
}

const GOAL_MCP_SERVER_URL =
	process.env.GOAL_MCP_SERVER_URL ??
	"http://workflow-mcp-server.workflow-builder.svc.cluster.local:3200/mcp";

/**
 * Auto-wire the goal MCP server (create_goal/update_goal/get_goal) into every
 * MCP-capable session so goals set from the UI can always self-complete —
 * without the tools, a goal loop can only end via budget/iteration caps or a
 * manual pause. Skipped when the runtime doesn't support MCP, when an entry
 * already matches the goal server, or when GOAL_MCP_AUTO_WIRE=false.
 */
function ensureGoalMcpServer<T>(servers: T, runtimeSupportsMcp: boolean): T {
	if (!runtimeSupportsMcp) return servers;
	if (process.env.GOAL_MCP_AUTO_WIRE === "false") return servers;
	if (!Array.isArray(servers)) return servers;
	const hasGoal = servers.some((entry) => {
		if (!entry || typeof entry !== "object") return false;
		const e = entry as Record<string, unknown>;
		const name = typeof e.name === "string" ? e.name.toLowerCase() : "";
		const url = typeof e.url === "string" ? e.url : "";
		return /goal/.test(name) || url.includes("workflow-mcp-server");
	});
	if (hasGoal) return servers;
	return [
		...servers,
		{ name: "goal", transport: "streamable_http", url: GOAL_MCP_SERVER_URL },
	] as T;
}

/**
 * Stamp the workflow-builder session id (== codex thread id) into the goal MCP
 * server entry's headers so the goal tools (create_goal/update_goal/get_goal)
 * resolve which session they act on. Scoped to the goal MCP entry — matched by
 * name (~goal) or URL (workflow-mcp-server) — so we don't leak the session id
 * to third-party MCP servers. Other servers ignore the extra header.
 */
function stampGoalMcpSessionHeader<T>(servers: T, sessionId: string): T {
	if (!Array.isArray(servers)) return servers;
	return servers.map((entry) => {
		if (!entry || typeof entry !== "object") return entry;
		const e = entry as Record<string, unknown>;
		const name = typeof e.name === "string" ? e.name.toLowerCase() : "";
		const url = typeof e.url === "string" ? e.url : "";
		const isGoalServer = /goal/.test(name) || url.includes("workflow-mcp-server");
		if (!isGoalServer) return entry;
		const headers = {
			...((e.headers as Record<string, unknown> | undefined) ?? {}),
			"X-Wfb-Session-Id": sessionId,
		};
		return { ...e, headers };
	}) as T;
}

/**
 * Raise a user-side event batch into the session's workflow. Used by
 * `POST /api/v1/sessions/[id]/events` after DB append.
 */
export async function raiseSessionUserEvents(
	sessionId: string,
	events: unknown[],
): Promise<void> {
	const session = await getSession(sessionId);
	if (!session?.daprInstanceId) return; // not yet spawned — events will be picked up at spawn time via listEvents
	// Route raise-event to the exact runtime that owns the session. New rows
	// persist this at spawn time; older rows fall back through the agent route.
	const target = await resolveSessionRuntimeTarget(sessionId);
	const invokeTarget = target?.invokeTarget ?? agentRuntimeInvokeTarget("dapr-agent-py");
	const daprEndpoint = getDaprSidecarUrl();
	const body = JSON.stringify({
		instanceId: session.daprInstanceId,
		eventName: "session.user_events",
		payload: { events },
	});
	const res =
		target?.runtimeSandboxName || target?.appId.startsWith("agent-session-")
			? await daprFetch(
					`${(await waitForAgentWorkflowHostAppReady({ agentAppId: target.appId })).baseUrl}/internal/sessions/raise-event`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body,
						maxRetries: 0,
					},
				)
			: await daprFetch(
					`${daprEndpoint}/v1.0/invoke/${encodeURIComponent(invokeTarget)}/method/internal/sessions/raise-event`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body,
					},
				);
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(
			`Dapr raiseEvent failed (${res.status}): ${text.slice(0, 200)}`,
		);
	}
}
