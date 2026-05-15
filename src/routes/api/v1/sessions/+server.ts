import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	attachWorkspaceSandbox,
	createSession,
	listSessions,
	type CreateSessionInput,
} from "$lib/server/sessions/registry";
import { sendUserEvent } from "$lib/server/sessions/events";
import { spawnSessionWorkflow } from "$lib/server/sessions/spawn";
import { provisionSessionSandbox } from "$lib/server/sandboxes/provision";
import { resolveAgentRef } from "$lib/server/agents/registry";
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
 *     vaultIds?, title?, initialMessage? }
 *
 * If `initialMessage` is present, it's appended as a `user.message` event
 * immediately so the session has a kickoff without a second round-trip.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const agentId = typeof body.agentId === "string" ? body.agentId : "";
	if (!agentId) return error(400, "agentId is required");

	const input: CreateSessionInput = {
		agentId,
		agentVersion:
			typeof body.agentVersion === "number" ? body.agentVersion : undefined,
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

		if (provisioning === "eager") {
			try {
				const sandbox = await provisionSessionSandbox({
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
			} catch (sandboxErr) {
				console.error("[sessions] sandbox provisioning failed:", sandboxErr);
				// Surface on the session row but don't fail the whole create.
				session.errorMessage =
					sandboxErr instanceof Error
						? sandboxErr.message
						: "Sandbox provisioning failed";
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
