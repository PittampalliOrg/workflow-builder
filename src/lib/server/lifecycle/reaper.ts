/**
 * Terminal-status reaper — the scheduled reconciliation behind the
 * lifecycle-terminal-reaper CronJob. Productionizes the operator scripts
 * scripts/reconcile-stale-workflow-agent-runs.ts + scripts/dev-purge-stale-workflows.ts.
 *
 * Divergence-safe: it only acts on rows whose DB status is stuck non-terminal
 * while the Dapr instance is ALREADY terminal/gone — it never terminates a
 * legitimately running instance. Skips entirely while any benchmark run is
 * active (so it can't disturb live eval work).
 */
import { and, count, eq, inArray, lte, ne, notInArray } from "drizzle-orm";
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

/** True if the Dapr instance is terminal or already gone (the safe-to-reap case). */
async function isDurableTerminalOrGone(instanceId: string | null): Promise<boolean> {
	if (!instanceId) return true; // no durable handle -> nothing to keep alive
	try {
		const status = await cascadeDeps.getParentStatus(instanceId);
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

	const active = await activeBenchmarkCount();
	if (active > 0) {
		return {
			...result,
			skipped: true,
			reason: `active benchmark runs/leases present (${active}); skipping reap`,
		};
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
	const stuckSessions = await db
		.select({ id: sessions.id, daprInstanceId: sessions.daprInstanceId })
		.from(sessions)
		.where(and(ne(sessions.status, "terminated"), lte(sessions.updatedAt, cutoff)))
		.limit(limit);
	for (const s of stuckSessions) {
		try {
			if (!(await isDurableTerminalOrGone(s.daprInstanceId ?? s.id))) continue; // still live
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
