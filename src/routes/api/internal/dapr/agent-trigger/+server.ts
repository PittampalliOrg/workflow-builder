import { json } from "@sveltejs/kit";
import { createHash } from "node:crypto";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import {
	createSession,
	getSession,
	type CreateSessionInput,
} from "$lib/server/sessions/registry";
import { sendUserEvent } from "$lib/server/sessions/events";
import { spawnSessionWorkflow } from "$lib/server/sessions/spawn";
import { getAgentBySlug, resolveAgentRef } from "$lib/server/agents/registry";

/**
 * Event-driven agent invocation (P1/P2).
 *
 * A Dapr pub/sub message on topic `workflow.agent-trigger` (NATS JetStream `pubsub`
 * component, delivered via `Subscription-agent-trigger.yaml`) starts a
 * `session_workflow` run through the EXISTING runtime-agnostic direct-session
 * dispatcher (`spawnSessionWorkflow` → `spawn.ts`). The runtime (CLI vs
 * dapr-agent-py) is selected from the named agent's configured runtime, so a
 * single handler covers all runtimes — no per-service subscription, no
 * dapr-agents "extensions" API, no dispatch migration (placement/lifecycle +
 * the cliAuth/ANTHROPIC_API_KEY-exclusion invariants all stay in spawn.ts).
 *
 * SECURITY: the message is DATA, not a command. The route is reachable only via
 * the in-cluster daprd subscription, and we still authorize every event —
 * resolve the named agent, require it to belong to `projectId`, and require the
 * acting `userId` to be a member of that project (the session owner whose CLI
 * credential spawn.ts resolves). v1 trusts only in-cluster/authenticated
 * publishers; external webhooks → pub/sub are out of scope.
 *
 * IDEMPOTENCY: JetStream is at-least-once (≤3 deliveries). The session id is
 * derived deterministically from `dedupKey` (or the CloudEvent id), so a
 * redelivery resolves to the same session — already-exists short-circuits in
 * both getSession and spawnSessionWorkflow. We ALWAYS ack (`{status:"SUCCESS"}`)
 * so a poison message can't wedge the subscription (JetStream max-deliver → DLQ).
 */

type TriggerPayload = {
	agentId?: unknown;
	agentSlug?: unknown;
	agentVersion?: unknown;
	projectId?: unknown;
	userId?: unknown;
	objective?: unknown;
	prompt?: unknown;
	initialMessage?: unknown;
	dedupKey?: unknown;
	title?: unknown;
	vaultIds?: unknown;
};

/** Deterministic, Dapr-instance-id-safe session id from a dedup key (≤64 chars). */
function triggerSessionId(dedupKey: string): string {
	const hex = createHash("sha256").update(dedupKey).digest("hex").slice(0, 40);
	return `evt-${hex}`;
}

async function isProjectMember(
	projectId: string,
	userId: string,
): Promise<boolean> {
	const { workflowData } = getApplicationAdapters();
	const membership = await workflowData.getWorkspaceProjectMembershipDetail({
		projectId,
		userId,
	});
	return !!membership?.selfRole;
}

export const POST: RequestHandler = async ({ request }) => {
	let body: Record<string, unknown> = {};
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		return json({ status: "SUCCESS" }); // malformed — ack + drop
	}

	const data = (
		body.data && typeof body.data === "object" ? body.data : body
	) as TriggerPayload;

	try {
		const agentIdRaw =
			typeof data.agentId === "string" ? data.agentId.trim() : "";
		const agentSlugRaw =
			typeof data.agentSlug === "string" ? data.agentSlug.trim() : "";
		const projectId =
			typeof data.projectId === "string" ? data.projectId.trim() : "";
		const userId = typeof data.userId === "string" ? data.userId.trim() : "";
		const objective =
			typeof data.objective === "string"
				? data.objective
				: typeof data.prompt === "string"
					? data.prompt
					: typeof data.initialMessage === "string"
						? data.initialMessage
						: "";
		const dedupKey =
			(typeof data.dedupKey === "string" && data.dedupKey.trim()) ||
			(typeof body.id === "string" && body.id.trim()) ||
			"";
		const agentVersion =
			typeof data.agentVersion === "number" ? data.agentVersion : undefined;
		const vaultIds = Array.isArray(data.vaultIds)
			? (data.vaultIds as unknown[]).filter(
					(v): v is string => typeof v === "string",
				)
			: undefined;
		const title =
			typeof data.title === "string" && data.title.trim()
				? data.title
				: undefined;

		if ((!agentIdRaw && !agentSlugRaw) || !projectId || !userId || !dedupKey) {
			console.warn(
				"[agent-trigger] missing required fields (agentId|agentSlug, projectId, userId, dedupKey) — dropping",
			);
			return json({ status: "SUCCESS" });
		}

		// Resolve the named agent → a ResolvedAgent (carries projectId/version).
		// Slug lookups resolve to an id first, then through resolveAgentRef so the
		// downstream shape is uniform.
		let resolveId = agentIdRaw;
		if (!resolveId && agentSlugRaw) {
			const bySlug = await getAgentBySlug(agentSlugRaw);
			if (bySlug) resolveId = bySlug.id;
		}
		const agent = resolveId
			? await resolveAgentRef({ id: resolveId, version: agentVersion })
			: null;
		if (!agent) {
			console.warn(
				`[agent-trigger] agent not found (id=${agentIdRaw} slug=${agentSlugRaw}) — dropping`,
			);
			return json({ status: "SUCCESS" });
		}

		// Authorize: agent must belong to the named project, and the acting user
		// must be a member of it (the session owner for credential resolution).
		if (agent.projectId && agent.projectId !== projectId) {
			console.warn(
				`[agent-trigger] agent ${agent.id} not in project ${projectId} — dropping`,
			);
			return json({ status: "SUCCESS" });
		}
		if (!(await isProjectMember(projectId, userId))) {
			console.warn(
				`[agent-trigger] user ${userId} is not a member of project ${projectId} — dropping`,
			);
			return json({ status: "SUCCESS" });
		}

		const sessionId = triggerSessionId(dedupKey);

		// Idempotency: a prior delivery already created (and likely spawned) this
		// session — nothing to do.
		const existing = await getSession(sessionId);
		if (existing) {
			return json({ status: "SUCCESS" });
		}

		const input: CreateSessionInput = {
			id: sessionId,
			agentId: agent.id,
			agentVersion: agent.version ?? agentVersion,
			vaultIds,
			title: title ?? `Triggered · ${agent.name}`,
			userId,
			projectId,
		};
		const session = await createSession(input);

		if (objective.trim()) {
			await sendUserEvent(session.id, {
				type: "user.message",
				content: [{ type: "text", text: objective }],
			});
		}

		await spawnSessionWorkflow(session.id);
		console.info(
			`[agent-trigger] started session ${session.id} for agent ${agent.slug} (project ${projectId})`,
		);
	} catch (err) {
		// Never NACK on a handler error — ack so JetStream redelivery/DLQ governs,
		// not an infinite wedge. The deterministic id makes a manual replay safe.
		console.error(
			"[agent-trigger] dispatch failed:",
			err instanceof Error ? err.message : err,
		);
	}

	return json({ status: "SUCCESS" });
};
