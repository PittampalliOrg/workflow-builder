import "server-only";

import {
	and,
	desc,
	eq,
	gte,
	inArray,
	isNull,
	lte,
	or,
	type SQL,
} from "drizzle-orm";
import { db } from "@/lib/db";
import { workflowExecutions, workflows } from "@/lib/db/schema";
import type { JaegerTag, JaegerTrace } from "./jaeger-types";
import type { JaegerTraceContext } from "./normalization";

type CorrelatedExecution = {
	executionId: string;
	workflowId: string;
	workflowName: string;
	daprInstanceId: string | null;
	status: string;
	phase: string | null;
	progress: number | null;
	startedAt: Date;
};

type CorrelationIds = {
	executionIds: Set<string>;
	instanceIds: Set<string>;
	workflowIds: Set<string>;
};

type ProjectExecutionIndex = {
	byExecutionId: Map<string, CorrelatedExecution>;
	byInstanceId: Map<string, CorrelatedExecution>;
	byWorkflowId: Map<string, CorrelatedExecution[]>;
};

type ProjectScopeParams = {
	projectId: string;
	userId: string;
};

function projectWorkflowScope({ projectId, userId }: ProjectScopeParams): SQL {
	return or(
		eq(workflows.projectId, projectId),
		and(isNull(workflows.projectId), eq(workflows.userId, userId)),
	) as SQL;
}

function toExecution(row: {
	executionId: string;
	workflowId: string;
	workflowName: string;
	daprInstanceId: string | null;
	status: string;
	phase: string | null;
	progress: number | null;
	startedAt: Date;
}): CorrelatedExecution {
	return {
		executionId: row.executionId,
		workflowId: row.workflowId,
		workflowName: row.workflowName,
		daprInstanceId: row.daprInstanceId,
		status: row.status,
		phase: row.phase,
		progress: row.progress,
		startedAt: row.startedAt,
	};
}

function getTag(tags: JaegerTag[] | undefined, keys: string[]): string | null {
	for (const key of keys) {
		const value = tags?.find((tag) => tag.key === key)?.value;
		if (typeof value === "string" && value.trim()) {
			return value;
		}
	}
	return null;
}

export function extractTraceCorrelation(trace: JaegerTrace): CorrelationIds {
	const correlation: CorrelationIds = {
		executionIds: new Set<string>(),
		instanceIds: new Set<string>(),
		workflowIds: new Set<string>(),
	};

	for (const span of trace.spans ?? []) {
		const tags = span.tags;

		const executionId = getTag(tags, [
			"workflow.db_execution_id",
			"workflow.dbExecutionId",
			"db.execution_id",
			"dbExecutionId",
		]);

		if (executionId) {
			correlation.executionIds.add(executionId);
		}

		const instanceId = getTag(tags, [
			"workflow.instance_id",
			"workflow.instanceId",
			"dapr.instance_id",
			"daprInstanceId",
		]);

		if (instanceId) {
			correlation.instanceIds.add(instanceId);
		}

		const workflowId = getTag(tags, [
			"workflow.id",
			"workflow_id",
			"workflowId",
		]);
		if (workflowId) {
			correlation.workflowIds.add(workflowId);
		}
	}

	return correlation;
}

export async function getProjectExecutionIndex(
	scope: ProjectScopeParams,
	params?: {
		from?: Date;
		to?: Date;
		limit?: number;
	},
): Promise<ProjectExecutionIndex> {
	const filters: SQL[] = [projectWorkflowScope(scope)];

	if (params?.from) {
		filters.push(gte(workflowExecutions.startedAt, params.from));
	}

	if (params?.to) {
		filters.push(lte(workflowExecutions.startedAt, params.to));
	}

	const rows = await db
		.select({
			executionId: workflowExecutions.id,
			workflowId: workflowExecutions.workflowId,
			workflowName: workflows.name,
			daprInstanceId: workflowExecutions.daprInstanceId,
			status: workflowExecutions.status,
			phase: workflowExecutions.phase,
			progress: workflowExecutions.progress,
			startedAt: workflowExecutions.startedAt,
		})
		.from(workflowExecutions)
		.innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
		.where(and(...filters))
		.orderBy(desc(workflowExecutions.startedAt))
		.limit(params?.limit ?? 2000);

	const index: ProjectExecutionIndex = {
		byExecutionId: new Map(),
		byInstanceId: new Map(),
		byWorkflowId: new Map(),
	};

	for (const row of rows) {
		const execution = toExecution(row);

		index.byExecutionId.set(execution.executionId, execution);

		if (execution.daprInstanceId) {
			index.byInstanceId.set(execution.daprInstanceId, execution);
		}

		const list = index.byWorkflowId.get(execution.workflowId) ?? [];
		list.push(execution);
		index.byWorkflowId.set(execution.workflowId, list);
	}

	return index;
}

function pickLatest(
	executions: CorrelatedExecution[],
): CorrelatedExecution | null {
	if (executions.length === 0) {
		return null;
	}

	return executions
		.slice()
		.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
}

function executionToContext(
	execution: CorrelatedExecution | null,
): JaegerTraceContext {
	if (!execution) {
		return {
			workflowId: null,
			workflowName: null,
			executionId: null,
			daprInstanceId: null,
			phase: null,
		};
	}

	return {
		workflowId: execution.workflowId,
		workflowName: execution.workflowName,
		executionId: execution.executionId,
		daprInstanceId: execution.daprInstanceId,
		phase: execution.phase,
	};
}

export function resolveTraceContextFromIndex(
	correlation: CorrelationIds,
	index: ProjectExecutionIndex,
): JaegerTraceContext {
	for (const executionId of correlation.executionIds) {
		const execution = index.byExecutionId.get(executionId);
		if (execution) {
			return executionToContext(execution);
		}
	}

	for (const instanceId of correlation.instanceIds) {
		const execution = index.byInstanceId.get(instanceId);
		if (execution) {
			return executionToContext(execution);
		}
	}

	for (const workflowId of correlation.workflowIds) {
		const executions = index.byWorkflowId.get(workflowId);
		const latest = executions ? pickLatest(executions) : null;
		if (latest) {
			return executionToContext(latest);
		}
	}

	return executionToContext(null);
}

export async function findTraceContextForProject(
	scope: ProjectScopeParams,
	correlation: CorrelationIds,
): Promise<JaegerTraceContext> {
	const predicates: SQL[] = [];

	if (correlation.executionIds.size > 0) {
		predicates.push(
			inArray(workflowExecutions.id, Array.from(correlation.executionIds)),
		);
	}

	if (correlation.instanceIds.size > 0) {
		predicates.push(
			inArray(
				workflowExecutions.daprInstanceId,
				Array.from(correlation.instanceIds),
			),
		);
	}

	if (correlation.workflowIds.size > 0) {
		predicates.push(
			inArray(
				workflowExecutions.workflowId,
				Array.from(correlation.workflowIds),
			),
		);
	}

	if (predicates.length === 0) {
		return executionToContext(null);
	}

	const rows = await db
		.select({
			executionId: workflowExecutions.id,
			workflowId: workflowExecutions.workflowId,
			workflowName: workflows.name,
			daprInstanceId: workflowExecutions.daprInstanceId,
			status: workflowExecutions.status,
			phase: workflowExecutions.phase,
			progress: workflowExecutions.progress,
			startedAt: workflowExecutions.startedAt,
		})
		.from(workflowExecutions)
		.innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
		.where(and(projectWorkflowScope(scope), or(...predicates)))
		.orderBy(desc(workflowExecutions.startedAt))
		.limit(50);

	if (rows.length === 0) {
		return executionToContext(null);
	}

	const candidates = rows.map(toExecution);

	const sorted = candidates.sort((a, b) => {
		const scoreA =
			(correlation.executionIds.has(a.executionId) ? 100 : 0) +
			(a.daprInstanceId && correlation.instanceIds.has(a.daprInstanceId)
				? 10
				: 0) +
			(correlation.workflowIds.has(a.workflowId) ? 1 : 0);

		const scoreB =
			(correlation.executionIds.has(b.executionId) ? 100 : 0) +
			(b.daprInstanceId && correlation.instanceIds.has(b.daprInstanceId)
				? 10
				: 0) +
			(correlation.workflowIds.has(b.workflowId) ? 1 : 0);

		if (scoreA !== scoreB) {
			return scoreB - scoreA;
		}

		return b.startedAt.getTime() - a.startedAt.getTime();
	});

	return executionToContext(sorted[0] ?? null);
}
