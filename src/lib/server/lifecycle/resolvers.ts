/**
 * Per-target-kind resolution for the lifecycle controller.
 *
 * A resolver turns a high-level {@link DurableRunTarget} into the concrete
 * Dapr/K8s/DB handles the generic cascade needs: the parent orchestrator
 * instance(s), the per-session agent-runtime workflow instances (each under its
 * own app-id), the Sandbox CR names to reap, the extra instance ids for raw
 * state-row purge, the auth scope, whether the run is still active, and a
 * `finalizeDb` that flips the owning rows terminal once the durable tree is
 * confirmed closed.
 */
import { createHash } from "node:crypto";
import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	evaluationRuns,
	sessions,
	workflowAgentRuns,
	workflowExecutions,
	workflowWorkspaceSessions,
} from "$lib/server/db/schema";
import type { AgentRuntimeTarget } from "./cascade";

export type DurableRunTarget =
	| { kind: "workflowExecution"; id: string }
	| { kind: "session"; id: string }
	| { kind: "evalRun"; id: string };

export type DurableTargetScope = { projectId: string | null; userId: string };

export type ResolvedDurableTarget = {
	notFound: boolean;
	/** DB row indicates a non-terminal (still-running) durable run. */
	dbActive: boolean;
	scope: DurableTargetScope | null;
	parentInstanceIds: string[];
	agentRuntimeTargets: AgentRuntimeTarget[];
	/** Per-session Sandbox CR names to delete on purge/reset. */
	sandboxNames: string[];
	statePurgeInstanceIds: string[];
	/** Flip owning DB rows terminal. Only invoked once the cascade confirms closure. */
	finalizeDb: (reason: string) => Promise<void>;
	/**
	 * Stamp the durable stop-intent (stop_requested_at) the moment a stop is
	 * requested — BEFORE the cascade confirms closure. Keeps the row non-terminal
	 * but marks it so the UI shows "Stopping…" and the terminal-status reaper can
	 * finalize it later if the in-request poll window expires. Idempotent.
	 */
	markStopRequested: (reason: string) => Promise<void>;
};

/** Per-session agent-runtime app-id — mirrors agent-workflow-host.ts:sessionHostAppId. */
function sessionHostAppId(sessionId: string): string | null {
	const normalized = sessionId.trim();
	if (!normalized) return null;
	return `agent-session-${createHash("sha256").update(normalized).digest("hex").slice(0, 20)}`;
}

function notFoundResult(): ResolvedDurableTarget {
	return {
		notFound: true,
		dbActive: false,
		scope: null,
		parentInstanceIds: [],
		agentRuntimeTargets: [],
		sandboxNames: [],
		statePurgeInstanceIds: [],
		finalizeDb: async () => {},
		markStopRequested: async () => {},
	};
}

function compact(values: Array<string | null | undefined>): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const v of values) {
		const t = (v ?? "").trim();
		if (t && !seen.has(t)) {
			seen.add(t);
			out.push(t);
		}
	}
	return out;
}

function agentTargetForSession(row: {
	id: string;
	daprInstanceId: string | null;
	runtimeAppId: string | null;
}): AgentRuntimeTarget | null {
	const instanceId = (row.daprInstanceId ?? row.id ?? "").trim();
	const runtimeAppId = (row.runtimeAppId ?? sessionHostAppId(row.id) ?? "").trim();
	if (!instanceId || !runtimeAppId) return null;
	return { runtimeAppId, instanceId };
}

async function resolveWorkflowExecution(id: string): Promise<ResolvedDurableTarget> {
	const database = db;
	if (!database) return notFoundResult();
	const [exec] = await database
		.select({
			id: workflowExecutions.id,
			daprInstanceId: workflowExecutions.daprInstanceId,
			status: workflowExecutions.status,
			projectId: workflowExecutions.projectId,
			userId: workflowExecutions.userId,
		})
		.from(workflowExecutions)
		.where(eq(workflowExecutions.id, id))
		.limit(1);
	if (!exec) return notFoundResult();

	const childSessions = await database
		.select({
			id: sessions.id,
			daprInstanceId: sessions.daprInstanceId,
			runtimeAppId: sessions.runtimeAppId,
			runtimeSandboxName: sessions.runtimeSandboxName,
		})
		.from(sessions)
		.where(eq(sessions.workflowExecutionId, id));

	const agentRuns = await database
		.select({
			daprInstanceId: workflowAgentRuns.daprInstanceId,
			agentWorkflowId: workflowAgentRuns.agentWorkflowId,
		})
		.from(workflowAgentRuns)
		.where(eq(workflowAgentRuns.workflowExecutionId, id));

	const agentRuntimeTargets: AgentRuntimeTarget[] = [];
	for (const s of childSessions) {
		const t = agentTargetForSession(s);
		if (t) agentRuntimeTargets.push(t);
	}

	return {
		notFound: false,
		dbActive: exec.status === "pending" || exec.status === "running",
		scope: { projectId: exec.projectId ?? null, userId: exec.userId },
		parentInstanceIds: compact([exec.daprInstanceId ?? exec.id]),
		agentRuntimeTargets,
		sandboxNames: compact(childSessions.map((s) => s.runtimeSandboxName)),
		statePurgeInstanceIds: compact([
			...childSessions.map((s) => s.daprInstanceId),
			...agentRuns.flatMap((r) => [r.daprInstanceId, r.agentWorkflowId]),
		]),
		finalizeDb: async (reason: string) => {
			const now = new Date();
			await database.transaction(async (tx) => {
				await tx
					.update(workflowExecutions)
					.set({ status: "cancelled", error: reason, completedAt: now })
					.where(
						and(
							eq(workflowExecutions.id, id),
							inArray(workflowExecutions.status, ["pending", "running"]),
						),
					);
				await tx
					.update(sessions)
					.set({ status: "terminated", completedAt: now, updatedAt: now })
					.where(
						and(
							eq(sessions.workflowExecutionId, id),
							ne(sessions.status, "terminated"),
						),
					);
				await tx
					.update(workflowAgentRuns)
					.set({ status: "failed", error: reason, completedAt: now, updatedAt: now })
					.where(
						and(
							eq(workflowAgentRuns.workflowExecutionId, id),
							inArray(workflowAgentRuns.status, ["scheduled", "running"]),
						),
					);
				await tx
					.update(workflowWorkspaceSessions)
					.set({ status: "cleaned", cleanedAt: now, updatedAt: now })
					.where(
						and(
							eq(workflowWorkspaceSessions.workflowExecutionId, id),
							eq(workflowWorkspaceSessions.status, "active"),
						),
					);
			});
		},
		markStopRequested: async (reason: string) => {
			await database
				.update(workflowExecutions)
				.set({ stopRequestedAt: new Date(), stopReason: reason })
				.where(
					and(
						eq(workflowExecutions.id, id),
						inArray(workflowExecutions.status, ["pending", "running"]),
					),
				);
		},
	};
}

async function resolveSession(id: string): Promise<ResolvedDurableTarget> {
	const database = db;
	if (!database) return notFoundResult();
	const [s] = await database
		.select({
			id: sessions.id,
			status: sessions.status,
			daprInstanceId: sessions.daprInstanceId,
			runtimeAppId: sessions.runtimeAppId,
			runtimeSandboxName: sessions.runtimeSandboxName,
			projectId: sessions.projectId,
			userId: sessions.userId,
		})
		.from(sessions)
		.where(eq(sessions.id, id))
		.limit(1);
	if (!s) return notFoundResult();

	const target = agentTargetForSession(s);
	return {
		notFound: false,
		dbActive: s.status !== "terminated",
		scope: { projectId: s.projectId ?? null, userId: s.userId },
		parentInstanceIds: [],
		agentRuntimeTargets: target ? [target] : [],
		sandboxNames: compact([s.runtimeSandboxName]),
		statePurgeInstanceIds: compact([s.daprInstanceId ?? s.id]),
		finalizeDb: async (reason: string) => {
			const now = new Date();
			await database
				.update(sessions)
				.set({
					status: "terminated",
					stopReason: { reason, source: "lifecycle_controller" },
					completedAt: now,
					updatedAt: now,
				})
				.where(and(eq(sessions.id, id), ne(sessions.status, "terminated")));
		},
		markStopRequested: async () => {
			await database
				.update(sessions)
				.set({ stopRequestedAt: new Date(), updatedAt: new Date() })
				.where(and(eq(sessions.id, id), ne(sessions.status, "terminated")));
		},
	};
}

async function resolveEvalRun(id: string): Promise<ResolvedDurableTarget> {
	const database = db;
	if (!database) return notFoundResult();
	const [run] = await database
		.select({
			id: evaluationRuns.id,
			status: evaluationRuns.status,
			coordinatorExecutionId: evaluationRuns.coordinatorExecutionId,
		})
		.from(evaluationRuns)
		.where(eq(evaluationRuns.id, id))
		.limit(1);
	if (!run) return notFoundResult();
	// DB flip + scope are owned by evaluations/service.ts::cancelEvaluationRun;
	// the controller only drives the durable terminate/purge of the coordinator
	// execution here.
	return {
		notFound: false,
		dbActive: !["completed", "failed", "cancelled"].includes(run.status),
		scope: null,
		parentInstanceIds: compact([run.coordinatorExecutionId]),
		agentRuntimeTargets: [],
		sandboxNames: [],
		statePurgeInstanceIds: compact([run.coordinatorExecutionId]),
		finalizeDb: async () => {},
		markStopRequested: async () => {
			await database
				.update(evaluationRuns)
				.set({ cancelRequestedAt: new Date() })
				.where(eq(evaluationRuns.id, id));
		},
	};
}

export function resolveDurableTarget(
	target: DurableRunTarget,
): Promise<ResolvedDurableTarget> {
	switch (target.kind) {
		case "workflowExecution":
			return resolveWorkflowExecution(target.id);
		case "session":
			return resolveSession(target.id);
		case "evalRun":
			return resolveEvalRun(target.id);
	}
}
