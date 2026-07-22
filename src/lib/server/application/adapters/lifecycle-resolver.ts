import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { db as defaultDb } from "$lib/server/db";
import { toPostgresTimestampParam } from "$lib/server/db/sql-params";
import {
	evaluationRuns,
	sessions,
	workflowAgentRuns,
	workflowExecutions,
	workflowWorkspaceSessions,
} from "$lib/server/db/schema";
import {
	agentTargetForSession,
  agentTargetsForSession,
	compactLifecycleIds,
  type DurableStopMode,
	type FinalizeOutcome,
	type LifecycleTargetResolver,
	notFoundLifecycleTarget,
	nodeIdFromChildSessionId,
  normalizeDurableStopMode,
  prospectiveAgentTargetForSession,
  sessionRequiresRuntimeLinkage,
} from "$lib/server/lifecycle/resolvers";
import type { WorkspaceRetentionIdentity } from "$lib/server/lifecycle/resolvers";

type Database = typeof defaultDb;

function cancelledExecutionOutput(
  value: unknown,
  reason: string,
): Record<string, unknown> {
  const prior =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
	return {
    success: false,
		outputs: null,
    workflowOutput: null,
		durationMs: typeof prior.durationMs === "number" ? prior.durationMs : null,
    phase: "cancelled",
    error: reason,
  };
}

function compactWorkspaceRetentionIdentities(
  values: WorkspaceRetentionIdentity[],
): WorkspaceRetentionIdentity[] {
  const unique = new Map<string, WorkspaceRetentionIdentity>();
  for (const value of values) {
    const durableExecutionId = value.durableExecutionId.trim();
    const databaseExecutionId = value.databaseExecutionId?.trim() || null;
    if (!durableExecutionId && !databaseExecutionId) continue;
    unique.set(
      `${durableExecutionId}\u0000${databaseExecutionId ?? ""}`,
      { durableExecutionId, databaseExecutionId },
    );
  }
  return [...unique.values()];
}

function persistedModeOrNull(value: unknown): DurableStopMode | null {
  return value == null ? null : normalizeDurableStopMode(value);
}

function stopIntentMatches(
  requestedAt: Date | null,
  persistedMode: unknown,
  expectedMode: DurableStopMode | undefined,
): boolean {
  if (expectedMode === undefined) return requestedAt == null;
  return (
    requestedAt != null &&
    normalizeDurableStopMode(persistedMode) === expectedMode
  );
}

function dedicatedHostReservationPending(row: {
  runtimeAppId: string | null;
  runtimeSandboxName?: string | null;
}): boolean {
  return (
    (row.runtimeAppId ?? "").startsWith("agent-session-") &&
    !(row.runtimeSandboxName ?? "").trim()
  );
}

/**
 * Atomic monotonic stop mode expression. A brand-new intent starts at the
 * requested mode. Once a timestamp exists, a legacy null mode means terminate;
 * later explicit requests may escalate terminate -> purge -> reset, never
 * downgrade. The returned database value is the only mode the cascade trusts.
 */
function monotonicStopMode(
  stopRequestedAt: unknown,
  stopRequestedMode: unknown,
  requestedMode: DurableStopMode,
) {
  return sql<DurableStopMode>`CASE
		WHEN ${stopRequestedAt} IS NULL THEN ${requestedMode}
		WHEN ${stopRequestedMode} = 'reset' OR ${requestedMode} = 'reset' THEN 'reset'
		WHEN ${stopRequestedMode} = 'purge' OR ${requestedMode} = 'purge' THEN 'purge'
		ELSE 'terminate'
	END`;
}

export function createPostgresLifecycleTargetResolver(
	database: Database = defaultDb,
): LifecycleTargetResolver {
  async function acknowledgeStoppedRuntimeProvisioningLease(input: {
    sessionId: string;
    expectedStartedAt: Date;
    workflowExecutionId?: string;
  }): Promise<boolean> {
    const conditions = [
      eq(sessions.id, input.sessionId),
      isNotNull(sessions.stopRequestedAt),
      eq(sessions.runtimeProvisioningStartedAt, input.expectedStartedAt),
    ];
    if (input.workflowExecutionId !== undefined) {
      conditions.push(
        eq(sessions.workflowExecutionId, input.workflowExecutionId),
      );
    }
    const acknowledged = await database
      .update(sessions)
      .set({
        runtimeProvisioningStartedAt: null,
			runtimeProvisioningAppId: null,
			runtimeProvisioningInstanceId: null,
			runtimeProvisioningSandboxName: null,
			runtimeProvisioningHostOwned: null,
			runtimeProvisioningHostLaunchSpec: null,
        updatedAt: sql<Date>`GREATEST(
          date_trunc('milliseconds', clock_timestamp()),
          ${sessions.updatedAt},
          ${toPostgresTimestampParam(input.expectedStartedAt)}
        )`,
      })
      .where(and(...conditions))
      .returning({ id: sessions.id });
    return acknowledged.length > 0;
  }

	async function resolveWorkflowExecution(id: string) {
		if (!database) return notFoundLifecycleTarget();
		const [exec] = await database
			.select({
				id: workflowExecutions.id,
				daprInstanceId: workflowExecutions.daprInstanceId,
				status: workflowExecutions.status,
				stopRequestedAt: workflowExecutions.stopRequestedAt,
        stopRequestedMode: workflowExecutions.stopRequestedMode,
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
				agentId: sessions.agentId,
				status: sessions.status,
				completedAt: sessions.completedAt,
				daprInstanceId: sessions.daprInstanceId,
        workspaceSandboxName: sessions.workspaceSandboxName,
				runtimeAppId: sessions.runtimeAppId,
				runtimeSandboxName: sessions.runtimeSandboxName,
					runtimeHostOwned: sessions.runtimeHostOwned,
        runtimeProvisioningStartedAt: sessions.runtimeProvisioningStartedAt,
				runtimeProvisioningAppId: sessions.runtimeProvisioningAppId,
				runtimeProvisioningInstanceId: sessions.runtimeProvisioningInstanceId,
				runtimeProvisioningSandboxName: sessions.runtimeProvisioningSandboxName,
				runtimeProvisioningHostOwned: sessions.runtimeProvisioningHostOwned,
			})
			.from(sessions)
			.where(eq(sessions.workflowExecutionId, id));

		// Node ids of child durable/run sessions whose agent child is really gone.
		// A node qualifies only when every run-index child of it is DB-terminated:
		// in a same-node durable/run loop, run__0 can be terminated while the parent
		// legitimately advances to run__1 of the same node.
    const nodeChildCounts = new Map<
      string,
      { total: number; terminated: number }
    >();
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
      if (
        s.status === "terminated" ||
        (s.status === "failed" && s.completedAt != null)
      ) {
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

    const activeOpenShellWorkspaces = await database
      .select({ workspaceRef: workflowWorkspaceSessions.workspaceRef })
      .from(workflowWorkspaceSessions)
      .where(
        and(
          eq(workflowWorkspaceSessions.workflowExecutionId, id),
          eq(workflowWorkspaceSessions.backend, "openshell"),
          eq(workflowWorkspaceSessions.status, "active"),
        ),
      );

		const agentRuntimeTargets = [];
    const runtimeProvisioningLeases = [];
    const unresolvedRuntimeLinkages = [];
		const runtimeHostCleanupTargets: Array<{
			sessionId: string;
			runtimeAppId: string;
			instanceId: string;
			runtimeSandboxName: string | null;
		}> = [];
		for (const s of childSessions) {
      const requiresRuntimeLinkage = sessionRequiresRuntimeLinkage(s);
      const persistedTarget = agentTargetForSession(s);
      const targets = requiresRuntimeLinkage ? agentTargetsForSession(s) : [];
      agentRuntimeTargets.push(...targets);
			if (
				persistedTarget?.ownsRuntimeSandbox !== false &&
				persistedTarget?.runtimeSandboxName?.trim()
			) {
				runtimeHostCleanupTargets.push({
					sessionId: s.id,
					runtimeAppId: persistedTarget.runtimeAppId,
					instanceId: persistedTarget.instanceId,
					runtimeSandboxName: s.runtimeSandboxName,
				});
			}
      const active =
        s.status !== "terminated" &&
        !(s.status === "failed" && s.completedAt != null);
      const prospectiveTarget = s.runtimeProvisioningStartedAt
        ? prospectiveAgentTargetForSession(s)
        : null;
      if (
        active &&
        requiresRuntimeLinkage &&
        s.runtimeProvisioningStartedAt &&
        prospectiveTarget
      ) {
        runtimeProvisioningLeases.push({
          sessionId: s.id,
          startedAt: s.runtimeProvisioningStartedAt,
          prospectiveTarget,
        });
		}
      if (
        active &&
        requiresRuntimeLinkage &&
        (s.runtimeProvisioningStartedAt != null ||
          !persistedTarget ||
          dedicatedHostReservationPending(s))
      ) {
        unresolvedRuntimeLinkages.push(s.id);
		}
    }
    const requestedAt = exec.stopRequestedAt ?? new Date();

		return {
			notFound: false,
			dbActive: exec.status === "pending" || exec.status === "running",
			stopRequestedAt: exec.stopRequestedAt ?? null,
      stopRequestedMode: persistedModeOrNull(exec.stopRequestedMode),
			terminatedChildNodes,
			activeChildNodes,
			scope: { projectId: exec.projectId ?? null, userId: exec.userId },
			parentInstanceIds: compactLifecycleIds([exec.daprInstanceId ?? exec.id]),
			agentRuntimeTargets,
      runtimeProvisioningLeases,
      acknowledgeRuntimeProvisioningCompensation: (
        sessionId: string,
        expectedStartedAt: Date,
      ) =>
        acknowledgeStoppedRuntimeProvisioningLease({
          sessionId,
          expectedStartedAt,
          workflowExecutionId: id,
        }),
      unresolvedRuntimeLinkages: compactLifecycleIds(unresolvedRuntimeLinkages),
			sandboxNames: compactLifecycleIds(
	        agentRuntimeTargets
	          .filter((target) => target.ownsRuntimeSandbox !== false)
	          .map((target) => target.runtimeSandboxName),
	      ),
      workspaceSandboxNames: compactLifecycleIds(
        childSessions.map((s) => s.workspaceSandboxName),
			),
      workspaceRetentionIdentities: compactWorkspaceRetentionIdentities([
        ...(activeOpenShellWorkspaces.length > 0
          ? [
              {
                durableExecutionId: exec.daprInstanceId ?? exec.id,
                databaseExecutionId: exec.id,
              },
            ]
          : []),
        ...childSessions
          .filter((session) => Boolean(session.workspaceSandboxName?.trim()))
          .map((session) => ({
            durableExecutionId: session.id,
            databaseExecutionId: exec.id,
          })),
      ]),
      workspaceCleanupExecutionIds:
        activeOpenShellWorkspaces.length > 0 ? [id] : [],
			statePurgeInstanceIds: compactLifecycleIds([
				...childSessions.map((s) => s.daprInstanceId),
				...agentRuns.flatMap((r) => [r.daprInstanceId, r.agentWorkflowId]),
			]),
      finalizeDb: async (
        reason: string,
        outcome: FinalizeOutcome = "terminated",
        expectedMode?: DurableStopMode,
      ) => {
				if (outcome === "crashed") {
					// Documented no-op: the workflow-execution finalize writes `cancelled`
					// (its own terminal vocabulary); the `crashed` outcome only shapes the
					// per-SESSION resolver. No behavior change — just make the drop visible.
					console.warn(
						`[lifecycle-resolver] finalizeDb(crashed) dropped for workflowExecution ${id} — workflow finalize writes 'cancelled'`,
					);
				}
        return database.transaction(async (tx) => {
          const [current] = await tx
            .select({
              status: workflowExecutions.status,
              stopRequestedAt: workflowExecutions.stopRequestedAt,
              stopRequestedMode: workflowExecutions.stopRequestedMode,
								daprInstanceId: workflowExecutions.daprInstanceId,
              completedAt: workflowExecutions.completedAt,
              output: workflowExecutions.output,
              summaryOutput: workflowExecutions.summaryOutput,
            })
            .from(workflowExecutions)
            .where(eq(workflowExecutions.id, id))
            .limit(1)
            .for("update");
          if (
            !current ||
            !stopIntentMatches(
              current.stopRequestedAt,
              current.stopRequestedMode,
              expectedMode,
            )
          ) {
            return "mode_changed" as const;
          }
							if (current.daprInstanceId !== exec.daprInstanceId) {
								return "mode_changed" as const;
							}

				const now = new Date();
          const stopWonTerminalRace =
            current.stopRequestedAt != null &&
            (current.completedAt == null ||
              current.completedAt.getTime() >= current.stopRequestedAt.getTime());
          if (
            current.status === "pending" ||
            current.status === "running" ||
							(current.status !== "cancelled" && stopWonTerminalRace) ||
							(current.status === "cancelled" && current.stopRequestedAt != null)
          ) {
					await tx
						.update(workflowExecutions)
						.set({
							status: "cancelled",
							phase: "cancelled",
							progress: 100,
							error: reason,
							completedAt: now,
							output: cancelledExecutionOutput(current.output, reason),
							summaryOutput: null,
						})
              .where(eq(workflowExecutions.id, id));
          }
					await tx
						.update(sessions)
            .set({
              status: "terminated",
              completedAt: now,
              runtimeProvisioningStartedAt: null,
							runtimeProvisioningAppId: null,
							runtimeProvisioningInstanceId: null,
							runtimeProvisioningSandboxName: null,
							runtimeProvisioningHostOwned: null,
							runtimeProvisioningHostLaunchSpec: null,
              updatedAt: now,
            })
						.where(
							and(
								eq(sessions.workflowExecutionId, id),
								ne(sessions.status, "terminated"),
							),
						);
					// finalizeDb is reached only after the cascade has deleted every
					// provider-owned runtime Sandbox (or SEA confirmed it absent). Persist
					// that physical-cleanup acknowledgement for both newly and previously
					// terminal children.
					for (const cleanupTarget of runtimeHostCleanupTargets) {
						await tx
							.update(sessions)
							.set({
								runtimeHostCleanupCompletedAt: now,
								updatedAt: now,
							})
							.where(
								and(
									eq(sessions.workflowExecutionId, id),
									eq(sessions.id, cleanupTarget.sessionId),
									eq(sessions.runtimeAppId, cleanupTarget.runtimeAppId),
									or(
										eq(sessions.daprInstanceId, cleanupTarget.instanceId),
										and(
											isNull(sessions.daprInstanceId),
											eq(sessions.id, cleanupTarget.instanceId),
										),
									),
									cleanupTarget.runtimeSandboxName === null
										? isNull(sessions.runtimeSandboxName)
										: eq(
												sessions.runtimeSandboxName,
												cleanupTarget.runtimeSandboxName,
											),
									eq(sessions.runtimeHostOwned, true),
									isNotNull(sessions.runtimeAppId),
								),
							);
					}
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
          if (expectedMode === "purge" || expectedMode === "reset") {
					await tx
						.update(workflowWorkspaceSessions)
						.set({ status: "cleaned", cleanedAt: now, updatedAt: now })
						.where(
							and(
								eq(workflowWorkspaceSessions.workflowExecutionId, id),
								eq(workflowWorkspaceSessions.status, "active"),
							),
						);
          }
          if (expectedMode !== undefined) {
            const childIntentSatisfied =
              expectedMode === "reset"
                ? sql`true`
                : expectedMode === "purge"
                  ? sql`${sessions.stopRequestedMode} IS NULL OR ${sessions.stopRequestedMode} IN ('terminate', 'purge')`
                  : sql`${sessions.stopRequestedMode} IS NULL OR ${sessions.stopRequestedMode} = 'terminate'`;
            // The parent cascade covered every resolved child at this mode. Ack
            // only child intents no stronger than that work; a concurrent child
            // reset remains pending for the session reconciler.
            await tx
              .update(sessions)
									.set({ stopRequestedAt: null, stopRequestedMode: null })
              .where(
                and(
                  eq(sessions.workflowExecutionId, id),
                  sql`${sessions.stopRequestedAt} IS NOT NULL`,
                  childIntentSatisfied,
                ),
              );
							// Clearing the timestamp is the durable acknowledgement. Retain the mode
							// as last-stop authority so a scheduler linkage published after cleanup
							// can re-drive the same purge/reset strength without reopening duplicates.
            await tx
              .update(workflowExecutions)
									.set({ stopRequestedAt: null })
              .where(eq(workflowExecutions.id, id));
          }
          return "finalized" as const;
				});
			},
      markStopRequested: async (reason: string, mode: DurableStopMode) => {
        return database.transaction(async (tx) => {
          // Deliberately update by id even when the execution is already terminal:
          // repeated cleanup must remain idempotent and still reap leaked compute.
          const persisted = await tx
					.update(workflowExecutions)
            .set({
              stopRequestedAt: sql<Date>`COALESCE(
                ${workflowExecutions.stopRequestedAt},
                ${toPostgresTimestampParam(requestedAt)}
              )`,
              stopRequestedMode: monotonicStopMode(
                workflowExecutions.stopRequestedAt,
                workflowExecutions.stopRequestedMode,
                mode,
              ),
              stopReason: sql<string>`COALESCE(${workflowExecutions.stopReason}, ${reason})`,
            })
            .where(eq(workflowExecutions.id, id))
            .returning({
              stopRequestedAt: workflowExecutions.stopRequestedAt,
              stopRequestedMode: workflowExecutions.stopRequestedMode,
            });
          const row = persisted[0];
          if (!row?.stopRequestedAt) {
            throw new Error(
              `workflow execution ${id} stop intent was not persisted`,
            );
          }
          const persistedMode = normalizeDurableStopMode(row.stopRequestedMode);

          // A workflow and its child sessions share one durable stop intent. Stamp
          // active children in the same transaction so the session reconciler can
          // independently re-drive their per-host control after a BFF restart.
          await tx
            .update(sessions)
            .set({
              stopRequestedAt: sql<Date>`COALESCE(
                ${sessions.stopRequestedAt},
                ${toPostgresTimestampParam(row.stopRequestedAt)}
              )`,
              stopRequestedMode: monotonicStopMode(
                sessions.stopRequestedAt,
                sessions.stopRequestedMode,
                persistedMode,
              ),
              updatedAt: sql<Date>`CASE
                WHEN ${sessions.stopRequestedAt} IS NULL
                THEN ${toPostgresTimestampParam(row.stopRequestedAt)}
                ELSE ${sessions.updatedAt}
              END`,
            })
					.where(
						and(
                eq(sessions.workflowExecutionId, id),
                ne(sessions.status, "terminated"),
                isNull(sessions.completedAt),
						),
					);

          return { requestedAt: row.stopRequestedAt, mode: persistedMode };
        });
			},
		};
	}

	async function resolveSession(id: string) {
		if (!database) return notFoundLifecycleTarget();
		const [session] = await database
			.select({
				id: sessions.id,
				agentId: sessions.agentId,
				status: sessions.status,
        completedAt: sessions.completedAt,
				stopRequestedAt: sessions.stopRequestedAt,
        stopRequestedMode: sessions.stopRequestedMode,
				daprInstanceId: sessions.daprInstanceId,
        workspaceSandboxName: sessions.workspaceSandboxName,
				runtimeAppId: sessions.runtimeAppId,
				runtimeSandboxName: sessions.runtimeSandboxName,
						runtimeHostOwned: sessions.runtimeHostOwned,
        runtimeProvisioningStartedAt: sessions.runtimeProvisioningStartedAt,
					runtimeProvisioningAppId: sessions.runtimeProvisioningAppId,
					runtimeProvisioningInstanceId: sessions.runtimeProvisioningInstanceId,
					runtimeProvisioningSandboxName: sessions.runtimeProvisioningSandboxName,
					runtimeProvisioningHostOwned: sessions.runtimeProvisioningHostOwned,
				projectId: sessions.projectId,
				userId: sessions.userId,
				workflowExecutionId: sessions.workflowExecutionId,
			})
			.from(sessions)
			.where(eq(sessions.id, id))
			.limit(1);
		if (!session) return notFoundLifecycleTarget();

    const requiresRuntimeLinkage = sessionRequiresRuntimeLinkage(session);
    const persistedTarget = agentTargetForSession(session);
    const targets = requiresRuntimeLinkage
      ? agentTargetsForSession(session)
      : [];
    const prospectiveTarget = session.runtimeProvisioningStartedAt
      ? prospectiveAgentTargetForSession(session)
      : null;
    const active =
      session.status !== "terminated" &&
      !(session.status === "failed" && session.completedAt != null);
    const requestedAt = session.stopRequestedAt ?? new Date();
		return {
			notFound: false,
      dbActive: active,
			dbStatus: session.status,
			stopRequestedAt: session.stopRequestedAt ?? null,
      stopRequestedMode: persistedModeOrNull(session.stopRequestedMode),
			terminatedChildNodes: [],
			activeChildNodes: [],
			scope: { projectId: session.projectId ?? null, userId: session.userId },
			parentInstanceIds: [],
      agentRuntimeTargets: targets,
      runtimeProvisioningLeases:
        active &&
        requiresRuntimeLinkage &&
        session.runtimeProvisioningStartedAt &&
        prospectiveTarget
          ? [
              {
                sessionId: session.id,
                startedAt: session.runtimeProvisioningStartedAt,
                prospectiveTarget,
              },
            ]
          : [],
      acknowledgeRuntimeProvisioningCompensation: (
        sessionId: string,
        expectedStartedAt: Date,
      ) =>
        sessionId === id
          ? acknowledgeStoppedRuntimeProvisioningLease({
              sessionId,
              expectedStartedAt,
            })
          : Promise.resolve(false),
      unresolvedRuntimeLinkages:
        active &&
        requiresRuntimeLinkage &&
        (session.runtimeProvisioningStartedAt != null ||
          !persistedTarget ||
          dedicatedHostReservationPending(session))
          ? [session.id]
          : [],
	      sandboxNames: compactLifecycleIds(
	        targets
	          .filter((target) => target.ownsRuntimeSandbox !== false)
	          .map((target) => target.runtimeSandboxName),
	      ),
      workspaceSandboxNames: compactLifecycleIds([
        session.workspaceSandboxName,
      ]),
      workspaceRetentionIdentities: session.workspaceSandboxName?.trim()
        ? [
            {
              durableExecutionId: session.id,
              databaseExecutionId: session.workflowExecutionId ?? null,
            },
          ]
        : [],
      workspaceCleanupExecutionIds: [],
			statePurgeInstanceIds: compactLifecycleIds([
				session.daprInstanceId ?? session.id,
			]),
      finalizeDb: async (
        reason: string,
        outcome: FinalizeOutcome = "terminated",
        expectedMode?: DurableStopMode,
      ) => {
        return database.transaction(async (tx) => {
          const [current] = await tx
            .select({
              status: sessions.status,
              stopRequestedAt: sessions.stopRequestedAt,
              stopRequestedMode: sessions.stopRequestedMode,
            })
            .from(sessions)
            .where(eq(sessions.id, id))
            .limit(1)
            .for("update");
          if (
            !current ||
            !stopIntentMatches(
              current.stopRequestedAt,
              current.stopRequestedMode,
              expectedMode,
            )
          ) {
            return "mode_changed" as const;
          }

				const now = new Date();
				const crashed = outcome === "crashed";
          await tx
					.update(sessions)
					.set({
              ...(current.status === "terminated"
                ? {}
                : {
                    // A reconciler-converged crash lands `failed` + a
                    // `crashed` reason; a normal stop lands `terminated`.
						status: crashed ? "failed" : "terminated",
						stopReason: {
							type: crashed ? "crashed" : undefined,
							reason,
							source: "lifecycle_controller",
						},
						completedAt: now,
                  }),
              ...(expectedMode !== undefined
                ? { stopRequestedAt: null, stopRequestedMode: null }
                : {}),
              runtimeProvisioningStartedAt: null,
							runtimeProvisioningAppId: null,
							runtimeProvisioningInstanceId: null,
							runtimeProvisioningSandboxName: null,
							runtimeProvisioningHostOwned: null,
							runtimeProvisioningHostLaunchSpec: null,
							...(persistedTarget?.ownsRuntimeSandbox !== false &&
							persistedTarget?.runtimeSandboxName?.trim()
								? {
										runtimeHostCleanupCompletedAt: sql<Date | null>`CASE
											WHEN ${sessions.runtimeAppId} = ${persistedTarget.runtimeAppId}
												AND COALESCE(${sessions.daprInstanceId}, ${sessions.id}) = ${persistedTarget.instanceId}
												AND ${session.runtimeSandboxName === null
													? isNull(sessions.runtimeSandboxName)
													: eq(sessions.runtimeSandboxName, session.runtimeSandboxName)}
												AND ${sessions.runtimeHostOwned} = true
											THEN ${now}
											ELSE ${sessions.runtimeHostCleanupCompletedAt}
										END`,
									}
								: {}),
						updatedAt: now,
					})
            .where(eq(sessions.id, id));
          return "finalized" as const;
        });
			},
      markStopRequested: async (_reason: string, mode: DurableStopMode) => {
        // Update terminal rows too: a repeated Stop & clean must be able to reap
        // leaked compute instead of failing because the projection is terminal.
        const persisted = await database
					.update(sessions)
          .set({
            stopRequestedAt: sql<Date>`COALESCE(
              ${sessions.stopRequestedAt},
              ${toPostgresTimestampParam(requestedAt)}
            )`,
            stopRequestedMode: monotonicStopMode(
              sessions.stopRequestedAt,
              sessions.stopRequestedMode,
              mode,
            ),
            updatedAt: sql<Date>`CASE
              WHEN ${sessions.stopRequestedAt} IS NULL
              THEN ${toPostgresTimestampParam(requestedAt)}
              ELSE ${sessions.updatedAt}
            END`,
          })
          .where(eq(sessions.id, id))
          .returning({
            stopRequestedAt: sessions.stopRequestedAt,
            stopRequestedMode: sessions.stopRequestedMode,
          });
        const row = persisted[0];
        if (!row?.stopRequestedAt) {
          throw new Error(`session ${id} stop intent was not persisted`);
        }
        return {
          requestedAt: row.stopRequestedAt,
          mode: normalizeDurableStopMode(row.stopRequestedMode),
        };
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
    const requestedAt = run.cancelRequestedAt ?? new Date();
		// DB flip + scope are owned by evaluations/service.ts::cancelEvaluationRun;
		// the controller only drives the durable terminate/purge of the coordinator
		// execution here.
		return {
			notFound: false,
			dbActive: !["completed", "failed", "cancelled"].includes(run.status),
			stopRequestedAt: run.cancelRequestedAt ?? null,
      // Evaluation cancellation has one authority and one destructive semantic:
      // cancelEvaluationRun always purges the coordinator durable state. Preserve
      // that mode across a delayed confirmation without adding a second mode
      // column to the evaluation aggregate.
      stopRequestedMode: run.cancelRequestedAt ? ("purge" as const) : null,
			terminatedChildNodes: [],
			activeChildNodes: [],
			scope: null,
			parentInstanceIds: compactLifecycleIds([run.coordinatorExecutionId]),
			agentRuntimeTargets: [],
      runtimeProvisioningLeases: [],
      acknowledgeRuntimeProvisioningCompensation: async () => false,
      unresolvedRuntimeLinkages: [],
			sandboxNames: [],
      workspaceSandboxNames: [],
      workspaceRetentionIdentities: [],
      workspaceCleanupExecutionIds: [],
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
        return "finalized" as const;
			},
      markStopRequested: async (_reason: string, _mode: DurableStopMode) => {
        const persisted = await database
					.update(evaluationRuns)
          .set({
            cancelRequestedAt: sql<Date>`COALESCE(
              ${evaluationRuns.cancelRequestedAt},
              ${toPostgresTimestampParam(requestedAt)}
            )`,
          })
          .where(eq(evaluationRuns.id, id))
          .returning({ cancelRequestedAt: evaluationRuns.cancelRequestedAt });
        if (!persisted[0]?.cancelRequestedAt) {
          throw new Error(`evaluation run ${id} stop intent was not persisted`);
        }
        return {
          requestedAt: persisted[0].cancelRequestedAt,
          mode: "purge" as const,
        };
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
