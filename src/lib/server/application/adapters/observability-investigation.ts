import { eq, or } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	workflowExecutionLogs,
	workflowExecutions,
} from "$lib/server/db/schema";
import type {
	ObservabilityExecutionResolution,
	ObservabilityInvestigationWorkflowReader,
	ObservabilityWorkflowStepInfo,
} from "$lib/server/observability/investigation";
import type { ObservabilityWorkflowStep } from "$lib/types/observability";

export class PostgresObservabilityInvestigationWorkflowReader
	implements ObservabilityInvestigationWorkflowReader
{
	async resolveExecutionForInvestigation(
		identifier: string,
	): Promise<ObservabilityExecutionResolution> {
		if (!db) {
			return { executionId: null, sessionId: null };
		}

		const [execution] = await db
			.select({
				id: workflowExecutions.id,
				workflowSessionId: workflowExecutions.workflowSessionId,
			})
			.from(workflowExecutions)
			.where(
				or(
					eq(workflowExecutions.id, identifier),
					eq(workflowExecutions.workflowSessionId, identifier),
				),
			)
			.limit(1);

		return {
			executionId: execution?.id ?? null,
			sessionId: execution?.workflowSessionId ?? null,
		};
	}

	async getWorkflowSteps(
		executionOrSessionId: string,
	): Promise<ObservabilityWorkflowStepInfo> {
		if (!db) {
			return { steps: [], status: null, startedAt: null, completedAt: null };
		}

		const resolved =
			await this.resolveExecutionForInvestigation(executionOrSessionId);
		const resolvedExecutionId = resolved.executionId ?? executionOrSessionId;

		const [execution] = await db
			.select()
			.from(workflowExecutions)
			.where(eq(workflowExecutions.id, resolvedExecutionId))
			.limit(1);

		const dbLogs = await db
			.select()
			.from(workflowExecutionLogs)
			.where(eq(workflowExecutionLogs.executionId, resolvedExecutionId))
			.orderBy(workflowExecutionLogs.startedAt);

		if (dbLogs.length > 0) {
			return {
				status: execution?.status ?? null,
				startedAt: execution?.startedAt?.toISOString() ?? null,
				completedAt: execution?.completedAt?.toISOString() ?? null,
				steps: dbLogs
					.filter((log) => !["trigger", "state"].includes(log.nodeId))
					.map((log) => ({
						id: log.id,
						stepName: log.nodeId,
						label: log.nodeName,
						actionType: log.activityName ?? log.nodeType,
						status: log.status,
						input: log.input,
						output: log.output,
						error: log.error,
						durationMs: log.duration ? Number.parseInt(log.duration, 10) : null,
						startedAt: log.startedAt?.toISOString() ?? null,
						completedAt: log.completedAt?.toISOString() ?? null,
						routedTo: log.routedTo ?? null,
					})),
			};
		}

		const execOutput = execution?.output as Record<string, unknown> | null;
		const stepOutputs = execOutput?.outputs as
			| Record<string, unknown>
			| undefined;
		const fallbackStart = execution?.startedAt?.toISOString() ?? null;
		return {
			status: execution?.status ?? null,
			startedAt: execution?.startedAt?.toISOString() ?? null,
			completedAt: execution?.completedAt?.toISOString() ?? null,
			steps: stepOutputs
				? Object.entries(stepOutputs)
						.filter(([name]) => !["trigger", "state"].includes(name))
						.map(([name, value], index) => {
							const record = value as Record<string, unknown>;
							const data =
								(record.data as Record<string, unknown> | undefined) ?? {};
							return {
								id: `fallback-${name}-${index}`,
								stepName: name,
								label: (record.label as string) || name,
								actionType: (record.actionType as string) || "",
								status: (data.success === false || data.error
									? "error"
									: data.success === true
										? "success"
										: "unknown") as ObservabilityWorkflowStep["status"],
								input: data.input ?? null,
								output: data.output ?? data ?? null,
								error: (data.error as string) ?? null,
								durationMs: (data.duration_ms as number) ?? null,
								startedAt: fallbackStart,
								completedAt: null,
								routedTo: null,
							};
						})
				: [],
		};
	}
}

export const postgresObservabilityInvestigationWorkflowReader =
	new PostgresObservabilityInvestigationWorkflowReader();
