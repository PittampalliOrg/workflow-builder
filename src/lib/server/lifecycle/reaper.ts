/**
 * Terminal-status reaper — the scheduled reconciliation behind the
 * lifecycle-terminal-reaper CronJob. Productionizes the operator scripts
 * scripts/reconcile-stale-workflow-agent-runs.ts + scripts/dev-purge-stale-workflows.ts.
 *
 * Divergence-safe: it only acts on rows whose DB status is stuck non-terminal
 * while the Dapr instance is ALREADY terminal/gone — it never terminates a
 * legitimately running instance. Because that per-row guard IS the safety, it
 * runs even while a benchmark is active (a leaked lease must not blind it to a
 * genuine orphan — the exact failure that left a stuck run unreconcilable). It
 * also prioritizes rows the user explicitly requested to stop
 * (stop_requested_at), finalizing them the moment Dapr goes terminal.
 */
import { createHash } from "node:crypto";
import { and, count, eq, inArray, isNotNull, lte, ne, notInArray } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	benchmarkResourceLeases,
	benchmarkRuns,
	sessions,
	workflowAgentRuns,
	workflowExecutions,
	workflowWorkspaceSessions,
} from "$lib/server/db/schema";
import {
	createDaprCascadeDeps,
	DURABLE_RUNTIME_MISSING_STATUS,
	isTerminalDurableRuntimeStatus,
} from "./cascade";
import { stopDurableRun } from "./index";

export type ReapTerminalOptions = { olderThanMinutes?: number; limit?: number };

export type ReapTerminalResult = {
	skipped: boolean;
	reason?: string;
	agentRunsReconciled: number;
	executionsPurged: number;
	executionsSkippedActive: number;
	sessionsPurged: number;
	workspaceSessionsCleaned: number;
	errors: string[];
};

const cascadeDeps = createDaprCascadeDeps();
const EXECUTION_TERMINAL = ["success", "error", "cancelled"] as const;
// The per-session sandbox backing a retained workspace is reaped by the
// workflow-builder-sandbox-gc CronJob at ~4h; only flip a still-'active' row to
// 'cleaned' once its owning execution has been terminal at least this long, so we
// never mark a still-live post-run live-preview cleaned.
const WORKSPACE_CLEANUP_AFTER_MS = 4 * 60 * 60_000;

async function activeBenchmarkCount(): Promise<number> {
	if (!db) return 0;
	const [runs] = await db
		.select({ n: count() })
		.from(benchmarkRuns)
		.where(notInArray(benchmarkRuns.status, ["completed", "failed", "cancelled"]));
	const [leases] = await db
		.select({ n: count() })
		.from(benchmarkResourceLeases)
		.where(eq(benchmarkResourceLeases.status, "active"));
	return Number(runs?.n ?? 0) + Number(leases?.n ?? 0);
}

/** True if the orchestrator-app workflow instance is terminal or gone (safe-to-reap). */
async function isDurableTerminalOrGone(instanceId: string | null): Promise<boolean> {
	if (!instanceId) return true; // no durable handle -> nothing to keep alive
	try {
		const status = await cascadeDeps.getParentStatus(instanceId);
		return status === DURABLE_RUNTIME_MISSING_STATUS || isTerminalDurableRuntimeStatus(status);
	} catch {
		return false; // unknown -> be conservative, don't reap
	}
}

/** Per-session agent-runtime app-id — mirrors resolvers.ts:sessionHostAppId. */
function sessionHostAppId(sessionId: string): string | null {
	const n = sessionId.trim();
	if (!n) return null;
	return `agent-session-${createHash("sha256").update(n).digest("hex").slice(0, 20)}`;
}

/**
 * True if a SESSION's durable workflow is terminal or gone. A session_workflow
 * runs on its per-session agent-runtime app-id (NOT the orchestrator), so we must
 * poll getAgentRuntimeStatus — polling the orchestrator would always report
 * "missing" and wrongly treat a LIVE session as reapable.
 */
async function isSessionTerminalOrGone(s: {
	id: string;
	daprInstanceId: string | null;
	runtimeAppId: string | null;
}): Promise<boolean> {
	const runtimeAppId = (s.runtimeAppId ?? sessionHostAppId(s.id) ?? "").trim();
	const instanceId = (s.daprInstanceId ?? s.id).trim();
	if (!runtimeAppId || !instanceId) return true;
	try {
		const status = await cascadeDeps.getAgentRuntimeStatus(runtimeAppId, instanceId);
		return status === DURABLE_RUNTIME_MISSING_STATUS || isTerminalDurableRuntimeStatus(status);
	} catch {
		return false; // unknown -> be conservative, don't reap
	}
}

export async function reapTerminalRuns(
	opts: ReapTerminalOptions = {},
): Promise<ReapTerminalResult> {
	const result: ReapTerminalResult = {
		skipped: false,
		agentRunsReconciled: 0,
		executionsPurged: 0,
		executionsSkippedActive: 0,
		sessionsPurged: 0,
		workspaceSessionsCleaned: 0,
		errors: [],
	};
	if (!db) {
		return { ...result, skipped: true, reason: "database not configured" };
	}
	const olderThanMinutes = Math.max(1, opts.olderThanMinutes ?? 60);
	const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
	const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);

	// We do NOT skip wholesale on benchmark activity any more: every step below
	// acts only on rows whose Dapr handle is already terminal/gone, so it can't
	// disturb a live run. (A leaked benchmark lease kept activeBenchmarkCount > 0
	// and blinded the reaper to a genuine orphan — the exact failure we hit.)
	const active = await activeBenchmarkCount();
	if (active > 0) {
		result.reason = `benchmark active (${active}); reconciling terminal-divergence only`;
	}

	// 0) Priority: finalize runs the user EXPLICITLY requested to stop (HTTP 202
	//    "stopping"), the moment their Dapr handle is terminal/gone — no age cutoff.
	//    Closes the "clicked Stop, got 202, closed the tab" loop within one cycle.
	const stopReqExecs = await db
		.select({ id: workflowExecutions.id, daprInstanceId: workflowExecutions.daprInstanceId })
		.from(workflowExecutions)
		.where(
			and(
				inArray(workflowExecutions.status, ["pending", "running"]),
				isNotNull(workflowExecutions.stopRequestedAt),
			),
		)
		.limit(limit);
	for (const exec of stopReqExecs) {
		try {
			if (!(await isDurableTerminalOrGone(exec.daprInstanceId ?? exec.id))) continue;
			const r = await stopDurableRun(
				{ kind: "workflowExecution", id: exec.id },
				{ mode: "purge", reason: "terminal-status reaper: stop-requested" },
			);
			if (r.confirmed) result.executionsPurged += 1;
		} catch (err) {
			result.errors.push(
				`stop-requested execution ${exec.id}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
	const stopReqSessions = await db
		.select({
			id: sessions.id,
			daprInstanceId: sessions.daprInstanceId,
			runtimeAppId: sessions.runtimeAppId,
		})
		.from(sessions)
		.where(and(ne(sessions.status, "terminated"), isNotNull(sessions.stopRequestedAt)))
		.limit(limit);
	for (const s of stopReqSessions) {
		try {
			if (!(await isSessionTerminalOrGone(s))) continue;
			const r = await stopDurableRun(
				{ kind: "session", id: s.id },
				{ mode: "purge", reason: "terminal-status reaper: stop-requested" },
			);
			if (r.confirmed) result.sessionsPurged += 1;
		} catch (err) {
			result.errors.push(
				`stop-requested session ${s.id}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	// 1) Reconcile child agent-runs left scheduled/running under a now-terminal,
	//    aged-out parent execution (DB-only; mirrors reconcile-stale-workflow-agent-runs).
	const reconciled = await db
		.update(workflowAgentRuns)
		.set({ status: "failed", completedAt: new Date(), updatedAt: new Date(), error: "reaped: parent execution terminal" })
		.where(
			and(
				inArray(workflowAgentRuns.status, ["scheduled", "running"]),
				inArray(
					workflowAgentRuns.workflowExecutionId,
					db
						.select({ id: workflowExecutions.id })
						.from(workflowExecutions)
						.where(
							and(
								inArray(workflowExecutions.status, [...EXECUTION_TERMINAL]),
								lte(workflowExecutions.completedAt, cutoff),
							),
						),
				),
			),
		)
		.returning({ id: workflowAgentRuns.id });
	result.agentRunsReconciled = reconciled.length;

	// 2) Purge stuck executions whose DB row is non-terminal + aged-out but whose
	//    Dapr instance is already terminal/gone (divergence). Never touches a live run.
	const stuckExecs = await db
		.select({ id: workflowExecutions.id, daprInstanceId: workflowExecutions.daprInstanceId })
		.from(workflowExecutions)
		.where(and(inArray(workflowExecutions.status, ["pending", "running"]), lte(workflowExecutions.startedAt, cutoff)))
		.limit(limit);
	for (const exec of stuckExecs) {
		try {
			if (!(await isDurableTerminalOrGone(exec.daprInstanceId ?? exec.id))) {
				result.executionsSkippedActive += 1;
				continue;
			}
			const r = await stopDurableRun({ kind: "workflowExecution", id: exec.id }, { mode: "purge", reason: "terminal-status reaper" });
			if (r.confirmed) result.executionsPurged += 1;
			else result.errors.push(`execution ${exec.id}: not confirmed`);
		} catch (err) {
			result.errors.push(`execution ${exec.id}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// 3) Purge stuck sessions: non-terminal + aged-out, whose durable run is gone.
	//    Uses the per-session agent-runtime handle (isSessionTerminalOrGone) — a
	//    session_workflow does not live on the orchestrator task hub.
	const stuckSessions = await db
		.select({
			id: sessions.id,
			daprInstanceId: sessions.daprInstanceId,
			runtimeAppId: sessions.runtimeAppId,
		})
		.from(sessions)
		.where(and(ne(sessions.status, "terminated"), lte(sessions.updatedAt, cutoff)))
		.limit(limit);
	for (const s of stuckSessions) {
		try {
			if (!(await isSessionTerminalOrGone(s))) continue; // still live
			const r = await stopDurableRun({ kind: "session", id: s.id }, { mode: "purge", reason: "terminal-status reaper" });
			if (r.confirmed) result.sessionsPurged += 1;
		} catch (err) {
			result.errors.push(`session ${s.id}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// 4) Tidy retained workspace-session rows whose owning execution is terminal and
	//    aged-out enough that the per-session sandbox is already gone — so they don't
	//    linger 'active' forever (the benchmark/controller terminal paths flip these
	//    on stop, but pre-controller and happy-path-completed rows accumulate). The
	//    age guard avoids cleaning a still-live post-run live-preview. UI-session
	//    workspaces (null workflow_execution_id) are left to the session stop path.
	try {
		const workspaceCutoff = new Date(Date.now() - WORKSPACE_CLEANUP_AFTER_MS);
		const cleanedWorkspaces = await db
			.update(workflowWorkspaceSessions)
			.set({ status: "cleaned", cleanedAt: new Date(), updatedAt: new Date() })
			.where(
				and(
					eq(workflowWorkspaceSessions.status, "active"),
					inArray(
						workflowWorkspaceSessions.workflowExecutionId,
						db
							.select({ id: workflowExecutions.id })
							.from(workflowExecutions)
							.where(
								and(
									inArray(workflowExecutions.status, [...EXECUTION_TERMINAL]),
									lte(workflowExecutions.completedAt, workspaceCutoff),
								),
							),
					),
				),
			)
			.returning({ ref: workflowWorkspaceSessions.workspaceRef });
		result.workspaceSessionsCleaned = cleanedWorkspaces.length;
	} catch (err) {
		result.errors.push(
			`workspace-session cleanup: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	return result;
}
