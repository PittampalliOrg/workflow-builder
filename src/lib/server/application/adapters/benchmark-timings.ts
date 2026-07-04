import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	benchmarkRunInstances,
	sessionEvents,
	workflowExecutionLogs,
	workflowExecutions,
} from "$lib/server/db/schema";
import {
	buildSessionTimingPatch,
	buildWorkflowTimingPatch,
	type TimingPatch,
} from "$lib/server/benchmarks/timings";

const TIMING_EVENT_TYPES = [
	"agent.llm_usage",
	"agent.tool_result",
	"session.turn_started",
	"session.turn_heartbeat",
	"tool_activity.scheduled",
	"tool_activity.started",
	"session.status_terminated",
	"session.status_errored",
];

async function mergeTimingPatchForRunInstance(
	runInstanceId: string,
	patch: TimingPatch,
): Promise<void> {
	const clean = Object.fromEntries(
		Object.entries(patch).filter(([, value]) => value !== undefined),
	);
	if (Object.keys(clean).length === 0) return;
	await db?.execute(sql`
		UPDATE benchmark_run_instances
		SET timings = COALESCE(timings, '{}'::jsonb) || ${JSON.stringify(clean)}::jsonb,
			updated_at = NOW()
		WHERE id = ${runInstanceId}
	`);
}

export async function aggregateBenchmarkSessionTimings(
	sessionId: string,
	options: { finalize?: boolean } = {},
): Promise<void> {
	if (!db || !sessionId) return;
	const [row] = await db
		.select({ id: benchmarkRunInstances.id })
		.from(benchmarkRunInstances)
		.where(eq(benchmarkRunInstances.sessionId, sessionId))
		.limit(1);
	if (!row) return;
	const events = await db
		.select({
			type: sessionEvents.type,
			data: sessionEvents.data,
			createdAt: sessionEvents.createdAt,
		})
		.from(sessionEvents)
		.where(
			and(
				eq(sessionEvents.sessionId, sessionId),
				inArray(sessionEvents.type, TIMING_EVENT_TYPES),
			),
		)
		.orderBy(asc(sessionEvents.createdAt));
	await mergeTimingPatchForRunInstance(
		row.id,
		buildSessionTimingPatch(events, options),
	);
}

export async function aggregateBenchmarkInstanceTimings(
	runInstanceId: string,
): Promise<void> {
	if (!db || !runInstanceId) return;
	const [row] = await db
		.select()
		.from(benchmarkRunInstances)
		.where(eq(benchmarkRunInstances.id, runInstanceId))
		.limit(1);
	if (!row) return;

	const patch: TimingPatch = {};
	if (row.sessionId) {
		const events = await db
			.select({
				type: sessionEvents.type,
				data: sessionEvents.data,
				createdAt: sessionEvents.createdAt,
			})
			.from(sessionEvents)
			.where(
				and(
					eq(sessionEvents.sessionId, row.sessionId),
					inArray(sessionEvents.type, TIMING_EVENT_TYPES),
				),
			)
			.orderBy(asc(sessionEvents.createdAt));
		Object.assign(
			patch,
			buildSessionTimingPatch(events, {
				finalize: row.inferenceCompletedAt != null,
			}),
		);
	}
	if (row.workflowExecutionId) {
		const [execution] = await db
			.select({
				startedAt: workflowExecutions.startedAt,
				completedAt: workflowExecutions.completedAt,
				duration: workflowExecutions.duration,
			})
			.from(workflowExecutions)
			.where(eq(workflowExecutions.id, row.workflowExecutionId))
			.limit(1);
		const logs = await db
			.select({
				nodeId: workflowExecutionLogs.nodeId,
				duration: workflowExecutionLogs.duration,
				startedAt: workflowExecutionLogs.startedAt,
				completedAt: workflowExecutionLogs.completedAt,
				output: workflowExecutionLogs.output,
			})
			.from(workflowExecutionLogs)
			.where(eq(workflowExecutionLogs.executionId, row.workflowExecutionId))
			.orderBy(asc(workflowExecutionLogs.startedAt));
		Object.assign(
			patch,
			buildWorkflowTimingPatch({
				runInstance: row,
				execution,
				logs,
			}),
		);
	} else {
		Object.assign(
			patch,
			buildWorkflowTimingPatch({
				runInstance: row,
				execution: null,
				logs: [],
			}),
		);
	}
	await mergeTimingPatchForRunInstance(row.id, patch);
}
