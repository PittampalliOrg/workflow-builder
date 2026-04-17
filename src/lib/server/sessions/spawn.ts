import { daprFetch } from "$lib/server/dapr-client";
import { attachRuntime, getSession } from "$lib/server/sessions/registry";
import { resolveAgentRef } from "$lib/server/agents/registry";
import { resolveEnvironmentRef } from "$lib/server/environments/registry";
import { listEvents } from "$lib/server/sessions/events";

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

	const payload = {
		sessionId,
		agentConfig: agent.config,
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
		initialEvents,
	};

	// The Dapr workflow HTTP API does not route cross-app via placement —
	// the runtime must be registered on the sidecar that receives the
	// call. workflow-builder hosts no workflows. Instead, invoke the
	// /internal/sessions/spawn endpoint on dapr-agent-py via Dapr
	// service-invoke; that endpoint calls StartInstance on its own
	// sidecar which owns the session_workflow runtime.
	const instanceId = sessionId;
	const daprEndpoint = getDaprSidecarUrl();
	const url = `${daprEndpoint}/v1.0/invoke/dapr-agent-py/method/internal/sessions/spawn`;
	const res = await daprFetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ instanceId, payload }),
	});
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
	const daprEndpoint = getDaprSidecarUrl();
	const url = `${daprEndpoint}/v1.0/invoke/dapr-agent-py/method/internal/sessions/raise-event`;
	const res = await daprFetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			instanceId: session.daprInstanceId,
			eventName: "session.user_events",
			payload: { events },
		}),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(
			`Dapr raiseEvent failed (${res.status}): ${text.slice(0, 200)}`,
		);
	}
}
