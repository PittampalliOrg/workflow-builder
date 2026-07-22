import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

/**
 * Event-driven agent invocation (P1/P2).
 *
 * A Dapr pub/sub message on topic `workflow.agent-trigger` (NATS JetStream `pubsub`
 * component, delivered via `Subscription-agent-trigger.yaml`) starts a
 * `session_workflow` run through the EXISTING runtime-agnostic direct-session
 * dispatcher. The runtime (CLI vs
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
 * redelivery resolves to the same session. Validation failures are acknowledged;
 * transient dispatch failures return Dapr `RETRY`, allowing JetStream max-deliver
 * and its DLQ policy to govern bounded recovery.
 */

export const POST: RequestHandler = async ({ request }) => {
	let body: Record<string, unknown> = {};
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		return json({ status: "SUCCESS" }); // malformed — ack + drop
	}

	try {
		const { sessionCommands } = getApplicationAdapters();
		const result = await sessionCommands.dispatchAgentTrigger({ body });
		return json({ status: result.status === "retry" ? "RETRY" : "SUCCESS" });
	} catch (err) {
		console.error(
			"[agent-trigger] dispatch failed:",
			err instanceof Error ? err.message : err,
		);
		return json({ status: "RETRY" });
	}
};
