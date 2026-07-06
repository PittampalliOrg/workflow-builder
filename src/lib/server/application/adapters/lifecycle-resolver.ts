import { and, eq, inArray, ne } from "drizzle-orm";
import { db as defaultDb } from "$lib/server/db";
import {
	evaluationRuns,
	sessions,
	workflowAgentRuns,
	workflowExecutions,
	workflowWorkspaceSessions,
} from "$lib/server/db/schema";
import {
	agentTargetForSession,
	compactLifecycleIds,
	type FinalizeOutcome,
	type LifecycleTargetResolver,
	notFoundLifecycleTarget,
	nodeIdFromChildSessionId,
} from "$lib/server/lifecycle/resolvers";

type Database = typeof defaultDb;

export function createPostgresLifecycleTargetResolver(
	database: Database = defaultDb,
): LifecycleTargetResolver {
	async function resolveWorkflowExecution(id: string) {
		if (!database) return notFoundLifecycleTarget();
		const [exec] = await database
			.select({
				id: workflowExecutions.id,
				daprInstanceId: workflowExecutions.daprInstanceId,
				status: workflowExecutions.status,
				stopRequestedAt: workflowExecutions.stopRequestedAt,
				projectId: workflowExecutions.projectId,
				userId: workflowExecutions.userId,
			})
			.from(workflowExecutions)
			.where(eq(workflowExecutions.id, id))
			.limit(1);
		if (!exec) return notFoundLifecycleTarget();

		const childSessions = await database
			.select({
				id: sessions.id,
				status: sessions.status,
				completedAt: sessions.completedAt,
				daprInstanceId: sessions.daprInstanceId,
				runtimeAppId: sessions.runtimeAppId,
				runtimeSandboxName: sessions.runtimeSandboxName,
			})
			.from(sessions)
			.where(eq(sessions.workflowExecutionId, id));

		// Node ids of child durable/run sessions whose agent child is really gone.
		// A node qualifies only when every run-index child of it is DB-terminated:
		// in a same-node durable/run loop, run__0 can be terminated while the parent
		// legitimately advances to run__1 of the same node.
		const nodeChildCounts = new Map<string, { total: number; terminated: number }>();
		for (const s of childSessions) {
			const node = nodeIdFromChildSessionId(s.id);
			if (!node) continue;
			const entry = nodeChildCounts.get(node) ?? { total: 0, terminated: 0 };
			entry.total += 1;
			// A child is terminal for the cross-app wedge when it is `terminated` OR
			// crash-FINALIZED by the liveness reconciler (`failed` + completed_at set).
			// Without the latter, a reconciler-converged child would land in
			// activeChildNodes and permanently BLOCK the force-finalize the crash path
			// now depends on.
			if (s.status === "terminated" || (s.status === "failed" && s.completedAt != null)) {
				entry.terminated += 1;
			}
			nodeChildCounts.set(node, entry);
		}
		const terminatedChildNodes = compactLifecycleIds(
			[...nodeChildCounts.entries()]
				.filter(([, c]) => c.total > 0 && c.terminated === c.total)
				.map(([node]) => node),
		);
		const activeChildNodes = compactLifecycleIds(
			[...nodeChildCounts.entries()]
				.filter(([, c]) => c.total > 0 && c.terminated < c.total)
				.map(([node]) => node),
		);

		const agentRuns = await database
			.select({
				daprInstanceId: workflowAgentRuns.daprInstanceId,
				agentWorkflowId: workflowAgentRuns.agentWorkflowId,
			})
			.from(workflowAgentRuns)
			.where(eq(workflowAgentRuns.workflowExecutionId, id));

		const agentRuntimeTargets = [];
		for (const s of childSessions) {
			const target = agentTargetForSession(s);
			if (target) agentRuntimeTargets.push(target);
		}

		return {
			notFound: false,
			dbActive: exec.status === "pending" || exec.status === "running",
			stopRequestedAt: exec.stopRequestedAt ?? null,
			terminatedChildNodes,
			activeChildNodes,
			scope: { projectId: exec.projectId ?? null, userId: exec.userId },
			parentInstanceIds: compactLifecycleIds([exec.daprInstanceId ?? exec.id]),
			agentRuntimeTargets,
			sandboxNames: compactLifecycleIds(
				childSessions.map((s) => s.runtimeSandboxName),
			),
			statePurgeInstanceIds: compactLifecycleIds([
				...childSessions.map((s) => s.daprInstanceId),
				...agentRuns.flatMap((r) => [r.daprInstanceId, r.agentWorkflowId]),
			]),
			finalizeDb: async (reason: string, outcome: FinalizeOutcome = "terminated") => {
				if (outcome === "crashed") {
					// Documented no-op: the workflow-execution finalize writes `cancelled`
					// (its own terminal vocabulary); the `crashed` outcome only shapes the
					// per-SESSION resolver. No behavior change — just make the drop visible.
					console.warn(
						`[lifecycle-resolver] finalizeDb(crashed) dropped for workflowExecution ${id} — workflow finalize writes 'cancelled'`,
					);
				}
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
						.set({
							status: "failed",
							error: reason,
							completedAt: now,
							updatedAt: now,
						})
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

	async function resolveSession(id: string) {
		if (!database) return notFoundLifecycleTarget();
		const [session] = await database
			.select({
				id: sessions.id,
				status: sessions.status,
				stopRequestedAt: sessions.stopRequestedAt,
				daprInstanceId: sessions.daprInstanceId,
				runtimeAppId: sessions.runtimeAppId,
				runtimeSandboxName: sessions.runtimeSandboxName,
				projectId: sessions.projectId,
				userId: sessions.userId,
			})
			.from(sessions)
			.where(eq(sessions.id, id))
			.limit(1);
		if (!session) return notFoundLifecycleTarget();

		const target = agentTargetForSession(session);
		return {
			notFound: false,
			dbActive: session.status !== "terminated",
			dbStatus: session.status,
			stopRequestedAt: session.stopRequestedAt ?? null,
			terminatedChildNodes: [],
			activeChildNodes: [],
			scope: { projectId: session.projectId ?? null, userId: session.userId },
			parentInstanceIds: [],
			agentRuntimeTargets: target ? [target] : [],
			sandboxNames: compactLifecycleIds([session.runtimeSandboxName]),
			statePurgeInstanceIds: compactLifecycleIds([
				session.daprInstanceId ?? session.id,
			]),
			finalizeDb: async (reason: string, outcome: FinalizeOutcome = "terminated") => {
				const now = new Date();
				const crashed = outcome === "crashed";
				await database
					.update(sessions)
					.set({
						// A reconciler-converged crash lands `failed` + a `crashed` stop
						// reason (so the row + UI read "Crashed", the resume affordance
						// appears, and it is distinguishable from a clean stop); a normal
						// stop lands `terminated`. Both stamp completedAt (terminal).
						status: crashed ? "failed" : "terminated",
						stopReason: {
							type: crashed ? "crashed" : undefined,
							reason,
							source: "lifecycle_controller",
						},
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

	async function resolveEvalRun(id: string) {
		if (!database) return notFoundLifecycleTarget();
		const [run] = await database
			.select({
				id: evaluationRuns.id,
				status: evaluationRuns.status,
				cancelRequestedAt: evaluationRuns.cancelRequestedAt,
				coordinatorExecutionId: evaluationRuns.coordinatorExecutionId,
			})
			.from(evaluationRuns)
			.where(eq(evaluationRuns.id, id))
			.limit(1);
		if (!run) return notFoundLifecycleTarget();
		// DB flip + scope are owned by evaluations/service.ts::cancelEvaluationRun;
		// the controller only drives the durable terminate/purge of the coordinator
		// execution here.
		return {
			notFound: false,
			dbActive: !["completed", "failed", "cancelled"].includes(run.status),
			stopRequestedAt: run.cancelRequestedAt ?? null,
			terminatedChildNodes: [],
			activeChildNodes: [],
			scope: null,
			parentInstanceIds: compactLifecycleIds([run.coordinatorExecutionId]),
			agentRuntimeTargets: [],
			sandboxNames: [],
			statePurgeInstanceIds: compactLifecycleIds([run.coordinatorExecutionId]),
			finalizeDb: async (_reason: string, outcome?: FinalizeOutcome) => {
				if (outcome === "crashed") {
					// Documented no-op: eval DB flips are owned by
					// evaluations/service.ts::cancelEvaluationRun; the resolver only drives
					// the coordinator's durable terminate/purge here.
					console.warn(
						`[lifecycle-resolver] finalizeDb(crashed) dropped for evalRun ${id} — eval finalize is owned by cancelEvaluationRun`,
					);
				}
			},
			markStopRequested: async () => {
				await database
					.update(evaluationRuns)
					.set({ cancelRequestedAt: new Date() })
					.where(eq(evaluationRuns.id, id));
			},
		};
	}

	return (target) => {
		switch (target.kind) {
			case "workflowExecution":
				return resolveWorkflowExecution(target.id);
			case "session":
				return resolveSession(target.id);
			case "evalRun":
				return resolveEvalRun(target.id);
		}
	};
}

export const resolveDurableTarget = createPostgresLifecycleTargetResolver();
