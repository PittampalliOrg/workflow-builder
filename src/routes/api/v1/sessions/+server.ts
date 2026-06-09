import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	addResource,
	attachWorkspaceSandbox,
	createSession,
	listSessions,
	recordSessionSandboxProvisioningError,
	type CreateSessionInput,
} from "$lib/server/sessions/registry";
import { sendUserEvent } from "$lib/server/sessions/events";
import { spawnSessionWorkflow } from "$lib/server/sessions/spawn";
import {
	mountSessionRepositories,
	type RepositorySandboxTarget,
} from "$lib/server/sessions/repositories";
import {
	provisionSessionSandboxWithRetry,
	sandboxProvisionFailureMessage,
} from "$lib/server/sandboxes/provision";
import { resolveAgentRef } from "$lib/server/agents/registry";
import { findOrCreateExperimentAgent } from "$lib/server/agents/ephemeral";
import { isAgentConfigEquivalent } from "$lib/utils/agent-config-diff";
import type { AgentConfig } from "$lib/types/agents";
import { safeCreateInteractiveSessionMlflowRun } from "$lib/server/observability/mlflow-lifecycle";

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const agentId = url.searchParams.get("agentId") ?? undefined;
	const status = url.searchParams.get("status") as
		| "rescheduling"
		| "running"
		| "idle"
		| "terminated"
		| null;
	const sourceParam = url.searchParams.get("source") as
		| "direct"
		| "workflow"
		| "api"
		| null;
	const workflowId = url.searchParams.get("workflowId") ?? undefined;
	const executionId = url.searchParams.get("executionId") ?? undefined;
	const q = url.searchParams.get("q") ?? undefined;
	const includeArchived = url.searchParams.get("includeArchived") === "true";
	const limitParam = url.searchParams.get("limit");
	const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
	const sessions = await listSessions({
		userId: locals.session.userId,
		// locals.session.projectId was overridden by hooks.server.ts when the
		// request carried an X-Workspace header or came from a workspace-scoped
		// URL. Sessions from other workspaces are correctly excluded.
		projectId: locals.session.projectId,
		agentId,
		status: status ?? undefined,
		source: sourceParam ?? undefined,
		workflowId,
		executionId,
		q,
		includeArchived,
		limit: Number.isFinite(limit) ? limit : undefined,
	});
	return json({ sessions });
};

/**
 * Create a session. Body:
 *   { agentId, agentVersion?, environmentId?, environmentVersion?,
 *     vaultIds?, title?, initialMessage?, agentConfig? }
 *
 * If `initialMessage` is present, it's appended as a `user.message` event
 * immediately so the session has a kickoff without a second round-trip.
 *
 * If `agentConfig` is present AND it differs from the resolved base agent's
 * published config, the BFF auto-creates a `session-experiment`-tagged
 * ephemeral agent row whose `agentVersions` config is the tweaked snapshot,
 * and the session FK's the experiment agent instead of the base. Same
 * agentConfig applied twice reuses the same experiment agent (slug keyed
 * on baseSlug + configHash). Tweaks that match the published config are a
 * no-op — the session points at the base agent directly.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const requestedAgentId = typeof body.agentId === "string" ? body.agentId : "";
	if (!requestedAgentId) return error(400, "agentId is required");

	let resolvedAgentId = requestedAgentId;
	let resolvedAgentVersion =
		typeof body.agentVersion === "number" ? body.agentVersion : undefined;

	const tweakedConfig = isAgentConfigShape(body.agentConfig)
		? (body.agentConfig as AgentConfig)
		: null;

	if (tweakedConfig) {
		const baseAgent = await resolveAgentRef({
			id: requestedAgentId,
			version: resolvedAgentVersion,
		});
		if (!baseAgent) return error(404, "Base agent not found");
		if (!isAgentConfigEquivalent(baseAgent.config, tweakedConfig)) {
			try {
				const experiment = await findOrCreateExperimentAgent({
					baseAgentId: baseAgent.id,
					baseAgentSlug: baseAgent.slug,
					baseAgentName: baseAgent.name,
					agentConfig: tweakedConfig,
					userId: locals.session.userId,
					projectId: locals.session.projectId ?? null,
				});
				resolvedAgentId = experiment.agentId;
				resolvedAgentVersion = experiment.agentVersion;
			} catch (err) {
				return error(
					400,
					err instanceof Error ? err.message : "Experiment agent create failed",
				);
			}
		}
	}

	const input: CreateSessionInput = {
		agentId: resolvedAgentId,
		agentVersion: resolvedAgentVersion,
		environmentId:
			typeof body.environmentId === "string"
				? (body.environmentId as string)
				: undefined,
		environmentVersion:
			typeof body.environmentVersion === "number"
				? body.environmentVersion
				: undefined,
		vaultIds: Array.isArray(body.vaultIds)
			? (body.vaultIds as unknown[]).filter(
					(v): v is string => typeof v === "string",
				)
			: undefined,
		title: typeof body.title === "string" ? body.title : undefined,
		userId: locals.session.userId,
		projectId: locals.session.projectId ?? null,
	};

	try {
		const session = await createSession(input);
		const resolvedAgent = await resolveAgentRef({
			id: session.agentId,
			version: session.agentVersion ?? undefined,
		});
		const mlflowRunContext = resolvedAgent
			? await safeCreateInteractiveSessionMlflowRun({
					sessionId: session.id,
					title: session.title,
					projectId: session.projectId,
					userId: locals.session.userId,
					agentId: resolvedAgent.id,
					agentName: resolvedAgent.name,
					agentSlug: resolvedAgent.slug,
					agentVersion: resolvedAgent.version,
					agentAppId: resolvedAgent.runtimeAppId,
					activeModelId: resolvedAgent.mlflowModelVersion,
					activeModelName: resolvedAgent.mlflowModelName,
					activeModelUri: resolvedAgent.mlflowUri,
					existingRunId: session.mlflowRunId,
				})
			: null;
		if (mlflowRunContext) {
			session.mlflowExperimentId = mlflowRunContext.experimentId;
			session.mlflowRunId = mlflowRunContext.runId;
			session.mlflowParentRunId = mlflowRunContext.parentRunId ?? null;
			session.mlflowSessionId = mlflowRunContext.mlflowSessionId ?? session.id;
		}
		if (typeof body.initialMessage === "string" && body.initialMessage.trim()) {
			await sendUserEvent(session.id, {
				type: "user.message",
				content: [{ type: "text", text: body.initialMessage }],
			});
		}

		// Repository resources to clone into the sandbox before the first turn.
		// Merge the agent's published defaults (repo-specialized agents) with any
		// explicitly-requested repos on the create body; an explicit entry for the
		// same URL overrides the agent default. Persist the rows now so the
		// post-provision mount step below clones them.
		const mergedRepos = dedupeRepositoriesByUrl([
			...parseRepositoryResources(resolvedAgent?.config?.repositories),
			...parseRepositoryResources(body.resources),
		]);
		for (const repo of mergedRepos) {
			try {
				await addResource(session.id, {
					type: "github_repository",
					repoUrl: repo.repoUrl,
					checkoutRef: repo.checkoutRef,
					mountPath: repo.mountPath,
					authTokenCredentialId: repo.authTokenCredentialId,
				});
			} catch (resErr) {
				console.warn("[sessions] failed to persist repo resource:", resErr);
			}
		}

		// Sandbox provisioning modes (Anthropic CMA TTFT win, Tier 2b):
		//   - "eager" (default, legacy): provision at session-create time so
		//     bash/file tools work as soon as the agent starts. Adds sandbox
		//     boot latency to every session's TTFT, even sessions that never
		//     touch the shell.
		//   - "lazy": skip provisioning here. The agent binds to a sandbox
		//     lazily on first workspace-tool use via the idempotent
		//     workspace/profile activity. Saves setup cost for chat-only
		//     sessions; matches Anthropic's "hands as cattle" pattern.
		// Workflow-driven sessions are unaffected — they get their sandbox
		// from the preceding workspace_profile workflow node.
		const provisioning =
			typeof body.provisioning === "string" &&
			body.provisioning.trim().toLowerCase() === "lazy"
				? "lazy"
				: "eager";

		let repoMountTarget: RepositorySandboxTarget | null = null;
		if (provisioning === "eager") {
			try {
				const sandbox = await provisionSessionSandboxWithRetry({
					executionId: session.id,
					name: session.title ?? `session-${session.id.slice(0, 8)}`,
					sandboxTemplate:
						typeof body.sandboxTemplate === "string"
							? (body.sandboxTemplate as string)
							: "base",
					keepAfterRun: true,
				});
				await attachWorkspaceSandbox(session.id, sandbox.sandboxName);
				session.workspaceSandboxName = sandbox.sandboxName;
				session.errorMessage = null;
				repoMountTarget = {
					executionId: session.id,
					workspaceRef: sandbox.workspaceRef,
					rootPath: sandbox.rootPath,
				};
			} catch (sandboxErr) {
				console.error("[sessions] sandbox provisioning failed:", sandboxErr);
				// Persist the failure but don't fail the whole create. The UI can
				// show why workspace tools are unavailable, and a later lazy bind
				// or explicit retry can still attach a sandbox.
				const message = sandboxProvisionFailureMessage(sandboxErr);
				session.errorMessage = message;
				try {
					await recordSessionSandboxProvisioningError(session.id, message);
				} catch (persistErr) {
					console.error(
						"[sessions] failed to persist sandbox provisioning error:",
						persistErr,
					);
				}
			}
		}

		// Clone any github_repository resources into the sandbox BEFORE the
		// agent's first turn. Best-effort: failures emit a session event and
		// never block the spawn.
		if (repoMountTarget) {
			try {
				await mountSessionRepositories(session.id, repoMountTarget);
			} catch (mountErr) {
				console.error("[sessions] repository mount failed:", mountErr);
			}
		}

		// Spawn the Dapr workflow instance. Failures here don't roll back the
		// session row — the UI can retry via POST /api/v1/sessions/[id]/spawn,
		// and a future idle sweep could garbage-collect orphaned sessions.
		try {
			const { instanceId, natsSubject } = await spawnSessionWorkflow(session.id);
			session.daprInstanceId = instanceId;
			session.natsSubject = natsSubject;
		} catch (spawnErr) {
			console.error("[sessions] spawn failed:", spawnErr);
			session.errorMessage =
				spawnErr instanceof Error ? spawnErr.message : "Workflow spawn failed";
		}
		return json({ session }, { status: 201 });
	} catch (err) {
		return error(
			400,
			err instanceof Error ? err.message : "Session create failed",
		);
	}
};

function isAgentConfigShape(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	// Minimal duck-typing — the validateAgentConfig() inside ensureEphemeralAgent
	// is the source of truth. Here we just gate the experiment-agent path on
	// the body actually carrying a config-shaped object so unrelated payloads
	// (e.g. just `{ agentId, initialMessage }`) bypass the path entirely.
	const v = value as Record<string, unknown>;
	return (
		typeof v.runtime === "string" ||
		typeof v.modelSpec === "string" ||
		typeof v.systemPrompt === "string" ||
		Array.isArray(v.skills) ||
		Array.isArray(v.mcpServers) ||
		Array.isArray(v.builtinTools)
	);
}

type ParsedRepoResource = {
	repoUrl: string;
	checkoutRef?: string;
	mountPath?: string;
	authTokenCredentialId?: string;
};

/** Parse an optional `resources` array on the create-session body into repo
 * mount inputs. Tolerant: drops entries without a string `repoUrl`. */
function parseRepositoryResources(value: unknown): ParsedRepoResource[] {
	if (!Array.isArray(value)) return [];
	const out: ParsedRepoResource[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as Record<string, unknown>;
		const repoUrl = typeof e.repoUrl === "string" ? e.repoUrl.trim() : "";
		if (!repoUrl) continue;
		out.push({
			repoUrl,
			checkoutRef:
				typeof e.checkoutRef === "string" && e.checkoutRef.trim()
					? e.checkoutRef.trim()
					: undefined,
			mountPath:
				typeof e.mountPath === "string" && e.mountPath.trim()
					? e.mountPath.trim()
					: undefined,
			authTokenCredentialId:
				typeof e.authTokenCredentialId === "string" && e.authTokenCredentialId
					? e.authTokenCredentialId
					: undefined,
		});
	}
	return out;
}

/** Dedupe repo entries by URL (case-insensitive), keeping the LAST occurrence —
 * so an explicit create-body entry overrides the agent's default for the same
 * repo. */
function dedupeRepositoriesByUrl(
	repos: ParsedRepoResource[],
): ParsedRepoResource[] {
	const byUrl = new Map<string, ParsedRepoResource>();
	for (const r of repos) byUrl.set(r.repoUrl.toLowerCase(), r);
	return [...byUrl.values()];
}
