import { daprFetch } from "$lib/server/dapr-client";
import { attachRuntime, getSession } from "$lib/server/sessions/registry";
import { resolveAgentRef } from "$lib/server/agents/registry";
import { resolveEnvironmentRef } from "$lib/server/environments/registry";
import { listEvents } from "$lib/server/sessions/events";
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

function modelIdFromMlflowUri(value: string | null | undefined): string | null {
	const text = value?.trim() ?? "";
	const match = text.match(/^models:\/([^/]+)$/);
	return match?.[1] ?? null;
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
		mcpServers: rewrittenMcp,
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
	const res = await (directRuntimeBaseUrl
		? fetch(`${directRuntimeBaseUrl}/internal/sessions/spawn`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ instanceId, payload }),
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
			? await fetch(
					`${(await waitForAgentWorkflowHostAppReady({ agentAppId: target.appId })).baseUrl}/internal/sessions/raise-event`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body,
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
