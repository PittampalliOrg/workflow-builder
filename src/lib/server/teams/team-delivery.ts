/**
 * Agent Teams — wake-on-deliver (subscribe side).
 *
 * Consumes `workflow.team-message` delivery triggers (published by
 * injectTeamMessage) and guarantees the recipient session actually RECEIVES the
 * persisted mailbox events, even when its runtime was suspended or reaped:
 *
 *   liveness → (wake) → claim → raise
 *
 * The Dapr `session_workflow` survives pod death (parked on
 * wait_for_external_event in the shared task hub), so "wake" is purely a pod
 * matter: converge any EXITED pod, patch the Sandbox CR back to replicas=1
 * (the controller recreates the pod from the preserved podTemplate — same
 * per-session app-id and DAPR_AGENT_SESSION_HOST_INSTANCE_ID — and the
 * durabletask worker reconnects; the stranded-host rescue verified this live
 * 2026-07-07), then wait for app readiness.
 *
 * Exactly-once raising: raised batches are NOT deduped runtime-side (each
 * raise = an agent turn), so the atomic `claimUnraisedTeamEvents` stamp is the
 * dedup layer — a JetStream redelivery or a concurrent broadcast/nudge that
 * loses the claim race sees zero rows and treats the message as delivered.
 * A failed raise unclaims so redelivery retries.
 *
 * Outcomes map to the Dapr subscriber contract (message-deliver route):
 *   "delivered"/"drop" → SUCCESS (ack), "retry" → RETRY (JetStream redelivery,
 *   ackWait 60s × maxDeliver 30 ≈ a 30-minute wake budget; after exhaustion the
 *   durable rows remain and the next message/nudge to the session re-flushes).
 */

import { getApplicationAdapters } from "$lib/server/application";
import type { TeamStore } from "$lib/server/application/ports";
import {
	getKubernetesSandbox,
	getSessionRuntimePodStatus,
	deleteSessionRuntimeExitedPods,
	resumeSessionSandbox,
	sandboxDesiredRunning,
} from "$lib/server/kube/client";
import {
	sessionHostAppId,
	waitForAgentWorkflowHostAppReady,
} from "$lib/server/sessions/agent-workflow-host";
import { raiseSessionUserEvents } from "$lib/server/sessions/spawn";
import { setMemberStatus, getMemberBySession } from "$lib/server/teams/team-repo";

export type DeliverOutcome = "delivered" | "retry" | "drop";

/** Statuses from which a session can never receive another turn. */
const TERMINAL_SESSION_STATUSES = new Set([
	"terminated",
	"completed",
	"failed",
	"canceled",
	"cancelled",
	"error",
	"crashed",
]);

/** Bounded so the whole handler stays under JetStream's 60s ackWait. */
const WAKE_READY_TIMEOUT_SECONDS = 40;

export type TeamDeliveryDeps = {
	store: TeamStore;
	getSessionRuntimePodStatus: typeof getSessionRuntimePodStatus;
	deleteSessionRuntimeExitedPods: typeof deleteSessionRuntimeExitedPods;
	getKubernetesSandbox: typeof getKubernetesSandbox;
	resumeSessionSandbox: typeof resumeSessionSandbox;
	waitForAgentWorkflowHostAppReady: (params: {
		agentAppId: string;
		timeoutSeconds?: number;
	}) => Promise<unknown>;
	claimUnraisedTeamEvents: (
		sessionId: string,
	) => Promise<Array<{ id: string; sequence: number; data: Record<string, unknown> }>>;
	unclaimSessionEvents: (sessionId: string, ids: string[]) => Promise<void>;
	raiseSessionUserEvents: (
		sessionId: string,
		events: Array<Record<string, unknown>>,
	) => Promise<unknown>;
	appendSessionEvent: (
		sessionId: string,
		event: {
			type: string;
			data?: Record<string, unknown>;
			processedAt?: Date | null;
			sourceEventId?: string | null;
		},
	) => Promise<unknown>;
};

function realDeps(): TeamDeliveryDeps {
	const adapters = getApplicationAdapters();
	return {
		store: adapters.teamStore,
		getSessionRuntimePodStatus,
		deleteSessionRuntimeExitedPods,
		getKubernetesSandbox,
		resumeSessionSandbox,
		waitForAgentWorkflowHostAppReady,
		claimUnraisedTeamEvents: (sessionId) =>
			adapters.workflowData.claimUnraisedTeamEvents(sessionId),
		unclaimSessionEvents: (sessionId, ids) =>
			adapters.workflowData.unclaimSessionEvents(sessionId, ids),
		raiseSessionUserEvents: (sessionId, events) =>
			raiseSessionUserEvents(sessionId, events as never),
		appendSessionEvent: (sessionId, event) =>
			adapters.workflowData.appendSessionEvent(sessionId, event),
	};
}

/**
 * Deliver every pending team-origin message to `recipientSessionId`, waking the
 * runtime if needed. Idempotent and safe under concurrent invocation.
 */
export async function deliverTeamMessages(
	recipientSessionId: string,
	deps: TeamDeliveryDeps = realDeps(),
): Promise<DeliverOutcome> {
	const session = await deps.store.getSessionDeliveryState(recipientSessionId);
	if (!session) return "drop"; // session row gone
	if (TERMINAL_SESSION_STATUSES.has(session.status)) return "drop";
	// Never spawned: the pending events flow into the workflow as initialEvents
	// at spawn time (spawn.ts listSessionEvents) — nothing to raise yet.
	if (!session.daprInstanceId) return "drop";

	const appId = session.runtimeAppId ?? sessionHostAppId(recipientSessionId);

	// (1) Liveness: present-and-not-exited pod == reachable workflow host.
	const pod = await deps.getSessionRuntimePodStatus({ runtimeAppId: appId });
	if (pod.presence === "unknown") return "retry"; // API blip — try again
	if (pod.presence !== "present" || pod.exited) {
		// (2) Wake. Sandbox CR must still exist (it survives suspension; only a
		// destroyed session deletes it).
		const sandboxName = session.runtimeSandboxName ?? `agent-host-${appId}`;
		const cr = await deps.getKubernetesSandbox(sandboxName);
		if (!cr) return "drop"; // destroyed — rows stay persisted for a future resume
		if (pod.exited) {
			// Exited pod blocks the controller from recreating; converge it first.
			await deps.deleteSessionRuntimeExitedPods({ runtimeAppId: appId });
		}
		if (!sandboxDesiredRunning(cr)) {
			await deps.resumeSessionSandbox(sandboxName);
		}
		try {
			await deps.waitForAgentWorkflowHostAppReady({
				agentAppId: appId,
				timeoutSeconds: WAKE_READY_TIMEOUT_SECONDS,
			});
		} catch {
			return "retry"; // still booting / Kueue-queued — JetStream redelivers
		}
	}

	// (3) Flush: atomically claim ALL pending team-origin events; raise as ONE
	// ordered batch (one agent turn sees the full mailbox).
	const claimed = await deps.claimUnraisedTeamEvents(recipientSessionId);
	if (claimed.length === 0) return "delivered"; // raced claim — already flushed
	try {
		await deps.raiseSessionUserEvents(
			recipientSessionId,
			claimed.map((e) => e.data),
		);
	} catch (err) {
		console.warn(
			`[team-delivery] raise to ${recipientSessionId} failed (${claimed.length} events unclaimed for retry):`,
			err instanceof Error ? err.message : err,
		);
		await deps
			.unclaimSessionEvents(
				recipientSessionId,
				claimed.map((e) => e.id),
			)
			.catch((unclaimErr) =>
				console.error(
					`[team-delivery] UNCLAIM FAILED for ${recipientSessionId} — events stranded as raised:`,
					unclaimErr,
				),
			);
		return "retry";
	}

	// (4) Best-effort finalization: member back to working + audit trail.
	try {
		const member = await getMemberBySession(recipientSessionId, deps.store);
		if (member && member.role !== "lead") {
			await setMemberStatus(recipientSessionId, "working", deps.store);
		}
		await deps.appendSessionEvent(recipientSessionId, {
			type: "session.host_woken",
			data: { source: "team-delivery", raisedEvents: claimed.length },
			processedAt: new Date(),
			sourceEventId: `host-wake:${recipientSessionId}:${claimed[0]?.id ?? "none"}`,
		});
	} catch (err) {
		console.warn("[team-delivery] post-delivery bookkeeping failed:", err);
	}
	return "delivered";
}
