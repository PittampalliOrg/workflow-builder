import {
	and,
	asc,
	eq,
	exists,
	inArray,
	isNotNull,
	isNull,
	lt,
	or,
	sql,
} from "drizzle-orm";
import { db as defaultDb } from "$lib/server/db";
import {
	workflowExecutionRuntimeHosts,
	workflowExecutions,
} from "$lib/server/db/schema";
import type {
	BeginWorkflowExecutionRuntimeHostRollbackResult,
	CompleteWorkflowExecutionRuntimeHostActivationResult,
	PublishWorkflowExecutionRuntimeHostResult,
	WorkflowExecutionRuntimeHostCleanupCandidate,
	WorkflowExecutionRuntimeHostIdentity,
	WorkflowExecutionRuntimeHostRepository,
} from "$lib/server/application/ports";

type Database = typeof defaultDb;

const TERMINAL_EXECUTION_STATUSES = ["success", "error", "cancelled"] as const;

function executionIsActive(row: {
	status: string;
	stopRequestedAt: Date | null;
}): boolean {
	return (
		(row.status === "pending" || row.status === "running") &&
		row.stopRequestedAt == null
	);
}

function exactTargetConditions(input: WorkflowExecutionRuntimeHostIdentity) {
	return [
		eq(workflowExecutionRuntimeHosts.workflowExecutionId, input.executionId),
		eq(workflowExecutionRuntimeHosts.purpose, input.purpose),
		eq(workflowExecutionRuntimeHosts.helperSessionId, input.helperSessionId),
		eq(
			workflowExecutionRuntimeHosts.generationStartedAt,
			input.generationStartedAt,
		),
		eq(workflowExecutionRuntimeHosts.runtimeAppId, input.runtimeAppId),
		eq(
			workflowExecutionRuntimeHosts.runtimeInstanceId,
			input.runtimeInstanceId,
		),
		eq(
			workflowExecutionRuntimeHosts.runtimeSandboxName,
			input.runtimeSandboxName,
		),
		eq(workflowExecutionRuntimeHosts.owned, input.owned),
	];
}

function executionCleanupEligible(database: Database) {
	return exists(
		database
			.select({ value: sql<number>`1` })
			.from(workflowExecutions)
			.where(
				and(
					eq(
						workflowExecutions.id,
						workflowExecutionRuntimeHosts.workflowExecutionId,
					),
					inArray(workflowExecutions.status, [
						...TERMINAL_EXECUTION_STATUSES,
					]),
				),
			),
	);
}

function mapCandidate(
	row: typeof workflowExecutionRuntimeHosts.$inferSelect,
): WorkflowExecutionRuntimeHostCleanupCandidate {
	return {
		executionId: row.workflowExecutionId,
		purpose: row.purpose,
		helperSessionId: row.helperSessionId,
		generationStartedAt: row.generationStartedAt,
		runtimeAppId: row.runtimeAppId,
		runtimeInstanceId: row.runtimeInstanceId,
		runtimeSandboxName: row.runtimeSandboxName,
		owned: row.owned,
	};
}

export class PostgresWorkflowExecutionRuntimeHostRepository
	implements WorkflowExecutionRuntimeHostRepository
{
	constructor(private readonly database: Database = defaultDb) {}

	async reserve(input: {
		proposedTarget: WorkflowExecutionRuntimeHostIdentity;
		operationId: string;
		startedAt: Date;
		staleBefore: Date;
	}) {
		const target = input.proposedTarget;
		return this.database.transaction(async (tx) => {
			const [execution] = await tx
				.select({
					status: workflowExecutions.status,
					stopRequestedAt: workflowExecutions.stopRequestedAt,
				})
				.from(workflowExecutions)
				.where(eq(workflowExecutions.id, target.executionId))
				.limit(1)
				.for("update");
			if (!execution) return { status: "not_found" as const };
			if (!executionIsActive(execution)) {
				return { status: "execution_not_active" as const };
			}

			await tx
				.insert(workflowExecutionRuntimeHosts)
				.values({
					workflowExecutionId: target.executionId,
					purpose: target.purpose,
					helperSessionId: target.helperSessionId,
					generationStartedAt: target.generationStartedAt,
					runtimeAppId: target.runtimeAppId,
					runtimeInstanceId: target.runtimeInstanceId,
					runtimeSandboxName: target.runtimeSandboxName,
					owned: target.owned,
					operationId: input.operationId,
					operationStartedAt: input.startedAt,
					createdAt: input.startedAt,
					updatedAt: input.startedAt,
				})
				.onConflictDoNothing();

			const [current] = await tx
				.select()
				.from(workflowExecutionRuntimeHosts)
				.where(
					and(
						eq(
							workflowExecutionRuntimeHosts.workflowExecutionId,
							target.executionId,
						),
						eq(workflowExecutionRuntimeHosts.purpose, target.purpose),
					),
				)
				.limit(1)
				.for("update");
			if (
				!current ||
				current.helperSessionId !== target.helperSessionId ||
				current.owned !== target.owned ||
				current.cleanupCompletedAt
			) {
				return { status: "target_mismatch" as const };
			}
			const currentTarget = mapCandidate(current);
			if (current.operationId === input.operationId) {
				return { status: "reserved" as const, target: currentTarget };
			}
			if (
				current.operationId &&
				current.operationStartedAt &&
				current.operationStartedAt >= input.staleBefore
			) {
				return { status: "busy" as const };
			}

			const acquired = await tx
				.update(workflowExecutionRuntimeHosts)
				.set({
					operationId: input.operationId,
					operationStartedAt: input.startedAt,
					lastError: null,
					updatedAt: input.startedAt,
				})
				.where(
					and(
						...exactTargetConditions(currentTarget),
						isNull(workflowExecutionRuntimeHosts.cleanupCompletedAt),
						or(
							isNull(workflowExecutionRuntimeHosts.operationId),
							lt(
								workflowExecutionRuntimeHosts.operationStartedAt,
								input.staleBefore,
							),
						),
					),
				)
				.returning({
					workflowExecutionId:
						workflowExecutionRuntimeHosts.workflowExecutionId,
				});
			return acquired.length > 0
				? { status: "reserved" as const, target: currentTarget }
				: { status: "busy" as const };
		});
	}

	async publish(
		input: WorkflowExecutionRuntimeHostIdentity & {
			operationId: string;
			publishedAt: Date;
		},
	): Promise<PublishWorkflowExecutionRuntimeHostResult> {
		return this.database.transaction(async (tx) => {
			const [execution] = await tx
				.select({
					status: workflowExecutions.status,
					stopRequestedAt: workflowExecutions.stopRequestedAt,
				})
				.from(workflowExecutions)
				.where(eq(workflowExecutions.id, input.executionId))
				.limit(1)
				.for("update");
			if (!execution) return { status: "lost" };
			if (!executionIsActive(execution)) {
				return { status: "execution_not_active" };
			}

			const published = await tx
				.update(workflowExecutionRuntimeHosts)
				.set({
					// Keep exact operation authority through provider activation. The
					// post-activation CAS below is the only successful release.
					operationStartedAt: input.publishedAt,
					provisionedAt: input.publishedAt,
					lastError: null,
					updatedAt: input.publishedAt,
				})
				.where(
					and(
						...exactTargetConditions(input),
						eq(workflowExecutionRuntimeHosts.operationId, input.operationId),
						isNull(workflowExecutionRuntimeHosts.cleanupCompletedAt),
					),
				)
				.returning({
					workflowExecutionId:
						workflowExecutionRuntimeHosts.workflowExecutionId,
				});
			if (published.length === 0) return { status: "lost" };
			return { status: "published" };
		});
	}

	async completeActivation(
		input: WorkflowExecutionRuntimeHostIdentity & {
			operationId: string;
			activatedAt: Date;
		},
	): Promise<CompleteWorkflowExecutionRuntimeHostActivationResult> {
		return this.database.transaction(async (tx) => {
			const [execution] = await tx
				.select({
					status: workflowExecutions.status,
					stopRequestedAt: workflowExecutions.stopRequestedAt,
				})
				.from(workflowExecutions)
				.where(eq(workflowExecutions.id, input.executionId))
				.limit(1)
				.for("update");
			if (!execution) return { status: "lost" };
			if (!executionIsActive(execution)) {
				return { status: "execution_not_active" };
			}

			const completed = await tx
				.update(workflowExecutionRuntimeHosts)
				.set({
					operationId: null,
					operationStartedAt: null,
					lastError: null,
					updatedAt: input.activatedAt,
				})
				.where(
					and(
						...exactTargetConditions(input),
						eq(
							workflowExecutionRuntimeHosts.operationId,
							input.operationId,
						),
						isNotNull(workflowExecutionRuntimeHosts.provisionedAt),
						isNull(workflowExecutionRuntimeHosts.cleanupCompletedAt),
					),
				)
				.returning({
					workflowExecutionId:
						workflowExecutionRuntimeHosts.workflowExecutionId,
				});
			return completed.length > 0
				? { status: "activated" }
				: { status: "lost" };
		});
	}

	async abort(
		input: WorkflowExecutionRuntimeHostIdentity & {
			operationId: string;
			abortedAt: Date;
			error: string;
		},
	): Promise<boolean> {
		const aborted = await this.database
			.update(workflowExecutionRuntimeHosts)
			.set({
				operationId: null,
				operationStartedAt: null,
				lastError: input.error.slice(0, 2_000),
				updatedAt: input.abortedAt,
			})
			.where(
				and(
					...exactTargetConditions(input),
					eq(workflowExecutionRuntimeHosts.operationId, input.operationId),
					isNull(workflowExecutionRuntimeHosts.cleanupCompletedAt),
				),
			)
			.returning({
				workflowExecutionId:
					workflowExecutionRuntimeHosts.workflowExecutionId,
			});
		return aborted.length > 0;
	}

	async beginRollback(
		input: WorkflowExecutionRuntimeHostIdentity & {
			operationId: string;
			startedAt: Date;
			error: string;
		},
	): Promise<BeginWorkflowExecutionRuntimeHostRollbackResult> {
		return this.database.transaction(async (tx) => {
			const claimed = await tx
				.update(workflowExecutionRuntimeHosts)
				.set({
					operationStartedAt: input.startedAt,
					lastError: input.error.slice(0, 2_000),
					updatedAt: input.startedAt,
				})
				.where(
					and(
						...exactTargetConditions(input),
						eq(
							workflowExecutionRuntimeHosts.operationId,
							input.operationId,
						),
						isNull(workflowExecutionRuntimeHosts.cleanupCompletedAt),
					),
				)
				.returning({
					workflowExecutionId:
						workflowExecutionRuntimeHosts.workflowExecutionId,
				});
			if (claimed.length > 0) return { status: "claimed" };

			const [current] = await tx
				.select({
					cleanupCompletedAt:
						workflowExecutionRuntimeHosts.cleanupCompletedAt,
				})
				.from(workflowExecutionRuntimeHosts)
				.where(and(...exactTargetConditions(input)))
				.limit(1);
			return current?.cleanupCompletedAt
				? { status: "cleanup_complete" }
				: { status: "lost" };
		});
	}

	async listPendingCleanup(input: {
		limit: number;
		availableBefore: Date;
		operationStaleBefore: Date;
		executionId?: string;
	}): Promise<WorkflowExecutionRuntimeHostCleanupCandidate[]> {
		const limit = Math.max(1, Math.min(Math.trunc(input.limit || 50), 200));
		const executionId = input.executionId?.trim();
		if (input.executionId !== undefined && !executionId) return [];
		const rows = await this.database
			.select({ host: workflowExecutionRuntimeHosts })
			.from(workflowExecutionRuntimeHosts)
			.innerJoin(
				workflowExecutions,
				eq(
					workflowExecutions.id,
					workflowExecutionRuntimeHosts.workflowExecutionId,
				),
			)
			.where(
				and(
					eq(workflowExecutionRuntimeHosts.owned, true),
					isNull(workflowExecutionRuntimeHosts.cleanupCompletedAt),
					or(
						isNull(workflowExecutionRuntimeHosts.cleanupAttemptedAt),
						lt(
							workflowExecutionRuntimeHosts.cleanupAttemptedAt,
							input.availableBefore,
						),
					),
					or(
						isNull(workflowExecutionRuntimeHosts.operationId),
						lt(
							workflowExecutionRuntimeHosts.operationStartedAt,
							input.operationStaleBefore,
						),
					),
					inArray(workflowExecutions.status, [
						...TERMINAL_EXECUTION_STATUSES,
					]),
					executionId
						? eq(
								workflowExecutionRuntimeHosts.workflowExecutionId,
								executionId,
							)
						: undefined,
				),
			)
			.orderBy(
				sql`${workflowExecutionRuntimeHosts.cleanupAttemptedAt} ASC NULLS FIRST`,
				asc(workflowExecutionRuntimeHosts.createdAt),
			)
			.limit(limit);
		return rows.map(({ host }) => mapCandidate(host));
	}

	async claimCleanup(
		input: WorkflowExecutionRuntimeHostCleanupCandidate & {
			attemptedAt: Date;
			availableBefore: Date;
			operationStaleBefore: Date;
		},
	): Promise<boolean> {
		const claimed = await this.database
			.update(workflowExecutionRuntimeHosts)
			.set({
				cleanupAttemptedAt: input.attemptedAt,
				lastError: null,
				updatedAt: input.attemptedAt,
			})
			.where(
				and(
					...exactTargetConditions(input),
					isNull(workflowExecutionRuntimeHosts.cleanupCompletedAt),
					or(
						isNull(workflowExecutionRuntimeHosts.cleanupAttemptedAt),
						lt(
							workflowExecutionRuntimeHosts.cleanupAttemptedAt,
							input.availableBefore,
						),
					),
					or(
						isNull(workflowExecutionRuntimeHosts.operationId),
						lt(
							workflowExecutionRuntimeHosts.operationStartedAt,
							input.operationStaleBefore,
						),
					),
					executionCleanupEligible(this.database),
				),
			)
			.returning({
				workflowExecutionId:
					workflowExecutionRuntimeHosts.workflowExecutionId,
			});
		return claimed.length > 0;
	}

	async acknowledgeCleanup(
		input: WorkflowExecutionRuntimeHostCleanupCandidate & {
			completedAt: Date;
		},
	): Promise<boolean> {
		const acknowledged = await this.database
			.update(workflowExecutionRuntimeHosts)
			.set({
				cleanupCompletedAt: input.completedAt,
				lastError: null,
				updatedAt: input.completedAt,
			})
			.where(
				and(
					...exactTargetConditions(input),
					isNull(workflowExecutionRuntimeHosts.cleanupCompletedAt),
					executionCleanupEligible(this.database),
				),
			)
			.returning({
				workflowExecutionId:
					workflowExecutionRuntimeHosts.workflowExecutionId,
			});
		return acknowledged.length > 0;
	}
}
