/**
 * Agent Teams — wake-on-deliver (subscribe side).
 *
 * Consumes `workflow.team-message` delivery triggers (published by
 * injectTeamMessage) and guarantees the recipient session actually RECEIVES the
 * persisted mailbox events, even when its runtime was suspended or reaped:
 *
 *   own(desired=running) → lease mailbox → liveness → (wake) → accept → complete
 *
 * The Dapr `session_workflow` survives pod death (parked on
 * wait_for_external_event in the shared task hub), so "wake" is purely a pod
 * matter: converge any EXITED pod, patch the Sandbox CR back to replicas=1
 * (the controller recreates the pod from the preserved podTemplate — same
 * per-session app-id and DAPR_AGENT_SESSION_HOST_INSTANCE_ID — and the
 * durabletask worker reconnects; the stranded-host rescue verified this live
 * 2026-07-07), then wait for app readiness.
 *
 * Crash safety: claiming never changes processed_at. The runtime accepts a
 * deterministic batch id plus stable event ids and deduplicates both in its
 * durable session_workflow state. Only after that idempotent acceptance does
 * this worker mark the exact claim token processed. A crash in either side of
 * the HTTP response is recovered by exact-token release or stale reclaim.
 *
 * Outcomes map to the Dapr subscriber contract (message-deliver route):
 *   "delivered"/"drop" → SUCCESS (ack), "retry" → RETRY (JetStream redelivery,
 *   ackWait 60s × maxDeliver 30 ≈ a 30-minute wake budget; after exhaustion the
 *   durable rows remain and the next message/nudge to the session re-flushes).
 *   A pre-runtime drop is re-driven immediately by the runtime-publication
 *   application service; it is never copied into raw workflow initialEvents.
 */

import { createHash, randomUUID } from "node:crypto";
import { getApplicationAdapters } from "$lib/server/application";
import type {
	SessionUserEventAcceptance,
	TeamMailboxDeliveryMetadata,
  TeamRuntimeHostPort,
  TeamStore,
} from "$lib/server/application/ports";
import { sessionHostAppId } from "$lib/server/sessions/agent-workflow-host";
import {
  ensurePublishedSessionWorkflowHost,
  raiseSessionUserEvents,
} from "$lib/server/sessions/spawn";

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
const RUNTIME_OPERATION_STALE_SECONDS = 300;
const MAILBOX_CLAIM_STALE_SECONDS = RUNTIME_OPERATION_STALE_SECONDS;

function cannotReceive(
  session: {
    status: string;
    stopRequested: boolean;
    daprInstanceId: string | null;
  } | null,
): boolean {
  return (
    !session ||
    session.stopRequested ||
    TERMINAL_SESSION_STATUSES.has(session.status) ||
    !session.daprInstanceId
  );
}

export type TeamDeliveryDeps = {
	store: TeamStore;
  runtimeHost: TeamRuntimeHostPort;
	claimUnraisedTeamEvents: (
		input: {
			sessionId: string;
			claimToken: string;
			staleAfterSeconds: number;
		},
  ) => Promise<
    Array<{ id: string; sequence: number; data: Record<string, unknown> }>
  >;
	hasUnprocessedTeamEvents: (sessionId: string) => Promise<boolean>;
	completeTeamEventDelivery: (input: {
		sessionId: string;
		claimToken: string;
	}) => Promise<number>;
	releaseTeamEventDeliveryClaim: (input: {
		sessionId: string;
		claimToken: string;
	}) => Promise<number>;
	newClaimToken: () => string;
  ensurePublishedRuntimeHost: (input: {
    sessionId: string;
    runtimeAppId: string;
    runtimeSandboxName: string;
  }) => Promise<{ recovered: boolean }>;
	raiseSessionUserEvents: (
		sessionId: string,
		events: Array<Record<string, unknown>>,
		delivery: TeamMailboxDeliveryMetadata,
	) => Promise<SessionUserEventAcceptance>;
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
    runtimeHost: adapters.teamRuntimeHost,
		claimUnraisedTeamEvents: (input) =>
			adapters.workflowData.claimUnraisedTeamEvents(input),
		hasUnprocessedTeamEvents: (sessionId) =>
			adapters.workflowData.hasUnprocessedTeamEvents(sessionId),
		completeTeamEventDelivery: (input) =>
			adapters.workflowData.completeTeamEventDelivery(input),
		releaseTeamEventDeliveryClaim: (input) =>
			adapters.workflowData.releaseTeamEventDeliveryClaim(input),
		newClaimToken: randomUUID,
    ensurePublishedRuntimeHost: (input) =>
      ensurePublishedSessionWorkflowHost(input),
		raiseSessionUserEvents: (sessionId, events, delivery) =>
			raiseSessionUserEvents(sessionId, events as never, delivery),
		appendSessionEvent: (sessionId, event) =>
			adapters.workflowData.appendSessionEvent(sessionId, event),
	};
}

export function teamMailboxBatchId(
	sessionId: string,
	eventIds: string[],
): string {
	const digest = createHash("sha256")
		.update(sessionId)
		.update("\0")
		.update(eventIds.join("\0"))
		.digest("hex");
	return `team-mailbox:${digest}`;
}

/**
 * Deliver every pending team-origin message to `recipientSessionId`, waking the
 * runtime if needed. Idempotent and safe under concurrent invocation.
 */
export async function deliverTeamMessages(
	recipientSessionId: string,
	deps: TeamDeliveryDeps = realDeps(),
): Promise<DeliverOutcome> {
  // (1) Own desired-running before touching the mailbox or Kubernetes. A
  // suspend operation holding the opposite intent makes this retry; it cannot
  // be stolen while its scale-to-zero patch is in flight.
  const lease = await deps.store.claimRuntimeOperation({
    sessionId: recipientSessionId,
    operation: "delivery",
    staleAfterSeconds: RUNTIME_OPERATION_STALE_SECONDS,
  });
  if (!lease) {
    const [session, member] = await Promise.all([
      deps.store.getSessionDeliveryState(recipientSessionId),
      deps.store.getMemberBySession(recipientSessionId),
    ]);
    return cannotReceive(session) || !member ? "drop" : "retry";
  }

  const finish = (memberStatus?: "working") =>
    deps.store.finishRuntimeOperation({
      sessionId: recipientSessionId,
      operationId: lease.operationId,
      operation: "delivery",
      ...(memberStatus ? { memberStatus } : {}),
    });
  const ownsDesiredRunning = () =>
    deps.store.verifyRuntimeOperation({
      sessionId: recipientSessionId,
      operationId: lease.operationId,
      operation: "delivery",
      desiredRunning: true,
    });

	let claimed: Array<{
    id: string;
    sequence: number;
		data: Record<string, unknown>;
	}>;
	const claimToken = deps.newClaimToken();
	try {
    // (2) Claim before a potentially slow probe/wake. While the lease is held,
    // suspend cannot make the host undesired underneath this batch.
		claimed = await deps.claimUnraisedTeamEvents({
			sessionId: recipientSessionId,
			claimToken,
			staleAfterSeconds: MAILBOX_CLAIM_STALE_SECONDS,
		});
  } catch (err) {
		// The UPDATE may have committed even when its response was lost. Release by
		// the known exact token when possible; otherwise stale reclaim remains safe.
		await deps
			.releaseTeamEventDeliveryClaim({
				sessionId: recipientSessionId,
				claimToken,
			})
			.catch(() => 0);
    await finish().catch(() => false);
    console.warn("[team-delivery] mailbox claim failed:", err);
    return "retry";
  }
  if (claimed.length === 0) {
		let pending = true;
		try {
			pending = await deps.hasUnprocessedTeamEvents(recipientSessionId);
		} catch (err) {
			console.warn(
				`[team-delivery] could not distinguish empty from busy mailbox for ${recipientSessionId}:`,
				err,
			);
		}
    await finish().catch(() => false);
		return pending ? "retry" : "delivered";
  }

	const releaseClaimAndFinish = async (outcome: DeliverOutcome) => {
		try {
			await deps.releaseTeamEventDeliveryClaim({
				sessionId: recipientSessionId,
				claimToken,
			});
		} catch (err) {
			console.error(
				`[team-delivery] failed to release ${claimed.length} events for ${recipientSessionId}:`,
        err,
      );
      outcome = "retry";
    }
    await finish().catch((err) =>
      console.error(
        `[team-delivery] failed to release delivery ownership for ${recipientSessionId}:`,
        err,
      ),
    );
    return outcome;
  };

  if (!(await ownsDesiredRunning())) {
    const session =
      await deps.store.getSessionDeliveryState(recipientSessionId);
		return releaseClaimAndFinish(cannotReceive(session) ? "drop" : "retry");
  }

  const appId = lease.runtimeAppId ?? sessionHostAppId(recipientSessionId);
  const sandboxName = lease.runtimeSandboxName ?? `agent-host-${appId}`;
  const recoverMissingHost = async (): Promise<DeliverOutcome | null> => {
    if (!(await ownsDesiredRunning())) {
      const session =
        await deps.store.getSessionDeliveryState(recipientSessionId);
			return releaseClaimAndFinish(cannotReceive(session) ? "drop" : "retry");
    }
    try {
      await deps.ensurePublishedRuntimeHost({
        sessionId: recipientSessionId,
        runtimeAppId: appId,
        runtimeSandboxName: sandboxName,
      });
    } catch (err) {
      console.warn(
        `[team-delivery] runtime recovery failed for ${recipientSessionId}:`,
        err instanceof Error ? err.message : err,
      );
      const session =
        await deps.store.getSessionDeliveryState(recipientSessionId);
			return releaseClaimAndFinish(cannotReceive(session) ? "drop" : "retry");
    }
    if (!(await ownsDesiredRunning())) {
      const session =
        await deps.store.getSessionDeliveryState(recipientSessionId);
			return releaseClaimAndFinish(cannotReceive(session) ? "drop" : "retry");
    }
    try {
      await deps.runtimeHost.waitUntilReady({
        runtimeAppId: appId,
        timeoutSeconds: WAKE_READY_TIMEOUT_SECONDS,
      });
    } catch {
			return releaseClaimAndFinish("retry");
    }
    return null;
  };

  // (3) Converge the physical host to the desired-running intent.
  try {
    const pod = await deps.runtimeHost.getPodStatus({ runtimeAppId: appId });
		if (pod.presence === "unknown") return releaseClaimAndFinish("retry");
	if (pod.presence !== "present" || pod.exited) {
      const sandbox = await deps.runtimeHost.getSandboxState(sandboxName);
      if (sandbox.presence === "absent") {
        const recoveryOutcome = await recoverMissingHost();
        if (recoveryOutcome) return recoveryOutcome;
      } else {
				if (!(await ownsDesiredRunning())) return releaseClaimAndFinish("retry");
		if (pod.exited) {
          await deps.runtimeHost.deleteExitedPods({ runtimeAppId: appId });
		}
        if (
          !sandbox.desiredRunning &&
          (await deps.runtimeHost.resume(sandboxName)) === "missing"
        ) {
          const recoveryOutcome = await recoverMissingHost();
          if (recoveryOutcome) return recoveryOutcome;
        } else {
		try {
            await deps.runtimeHost.waitUntilReady({
              runtimeAppId: appId,
				timeoutSeconds: WAKE_READY_TIMEOUT_SECONDS,
			});
		} catch {
						return releaseClaimAndFinish("retry");
          }
        }
		}
	}
  } catch (err) {
    console.warn("[team-delivery] runtime convergence failed:", err);
		return releaseClaimAndFinish("retry");
  }

  // Recheck the exact token and desired-running intent immediately before the
  // irreversible raise. Stop/shutdown and stale takeover both fail closed.
  if (!(await ownsDesiredRunning())) {
    const session =
      await deps.store.getSessionDeliveryState(recipientSessionId);
		return releaseClaimAndFinish(cannotReceive(session) ? "drop" : "retry");
	}
	const eventIds = claimed.map((event) => event.id);
	const batchId = teamMailboxBatchId(recipientSessionId, eventIds);
	try {
		await deps.raiseSessionUserEvents(
			recipientSessionId,
			claimed.map((e) => e.data),
			{ kind: "team-mailbox", batchId, eventIds },
		);
	} catch (err) {
		console.warn(
			`[team-delivery] raise to ${recipientSessionId} failed (${claimed.length} events unclaimed for retry):`,
			err instanceof Error ? err.message : err,
		);
		return releaseClaimAndFinish("retry");
	}

	// Runtime acceptance is idempotent for batchId/eventIds. processed_at is
	// advanced only after that receipt, and only by the exact claim owner.
	try {
		const completed = await deps.completeTeamEventDelivery({
			sessionId: recipientSessionId,
			claimToken,
		});
		if (completed !== claimed.length) {
			console.warn(
				`[team-delivery] accepted batch ${batchId} but completed ${completed}/${claimed.length} exact-claim rows`,
			);
			await finish().catch(() => false);
			return "retry";
		}
	} catch (err) {
		// Do not release an accepted claim. A stale worker will reclaim it and the
		// durable runtime receipt filters the duplicate before another model turn.
		console.warn(
			`[team-delivery] accepted batch ${batchId} but completion failed:`,
			err instanceof Error ? err.message : err,
			);
		await finish().catch(() => false);
		return "retry";
	}

  // (4) Exact-token finalization. Terminal lifecycle state is preserved by the
  // store even if it raced the successful raise.
	try {
    const transitioned = await finish("working");
    if (transitioned) {
		await deps.appendSessionEvent(recipientSessionId, {
			type: "session.host_woken",
			data: { source: "team-delivery", raisedEvents: claimed.length },
			processedAt: new Date(),
			sourceEventId: `host-wake:${batchId}`,
		});
    }
	} catch (err) {
		console.warn("[team-delivery] post-delivery bookkeeping failed:", err);
	}
	return "delivered";
}
