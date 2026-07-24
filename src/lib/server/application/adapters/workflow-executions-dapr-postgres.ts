import { generateId } from "$lib/server/utils/id";
import { DaprPostgresBindingClient } from "$lib/server/application/adapters/dapr-postgres-binding";
import {
	booleanOrNull,
	dateOrNull,
	dateValue,
	jsonParam,
	jsonValue,
	numberOrNull,
	numberValue,
	stringOrNull,
	stringValue,
} from "$lib/server/application/adapters/dapr-postgres-rows";
import { PostgresWorkflowExecutionRepository } from "$lib/server/application/adapters/postgres";
import type {
	AppendWorkflowExecutionLogInput,
	CompareAndSetWorkflowExecutionReadModelInput,
	CreateWorkflowExecutionInput,
	WorkflowExecutionListItem,
	WorkflowExecutionLogPatch,
	WorkflowExecutionLogRecord,
	WorkflowExecutionReadModelPatch,
	WorkflowExecutionRecord,
	WorkflowExecutionRuntimeProjectionResult,
	WorkflowExecutionStatus,
} from "$lib/server/application/ports";

type BindingClient = Pick<DaprPostgresBindingClient, "query" | "exec">;

const EXECUTION_COLUMNS = `
	id,
	workflow_id,
	user_id,
	project_id,
	status,
	input,
	output,
	execution_ir_version,
	execution_ir,
	error,
	dapr_instance_id,
	phase,
	progress,
	current_node_id,
	current_node_name,
	primary_trace_id,
	workflow_session_id,
	mlflow_experiment_id,
	mlflow_run_id,
	summary_output,
	error_stack_trace,
	rerun_of_execution_id,
	rerun_source_instance_id,
	resume_from_node,
	trigger_source,
	rerun_from_event_id,
	started_at,
	completed_at,
	duration,
	stop_requested_at,
	stop_reason,
	seed_workspace_from
`;

const EXECUTION_LOG_COLUMNS = `
	id,
	execution_id,
	node_id,
	node_name,
	node_type,
	activity_name,
	status,
	input,
	output,
	error,
	started_at,
	completed_at,
	duration,
	timestamp,
	credential_fetch_ms,
	routing_ms,
	cold_start_ms,
	execution_ms,
	routed_to,
	was_cold_start
`;

const READ_MODEL_PATCH_COLUMNS: Record<
	keyof WorkflowExecutionReadModelPatch,
	string
> = {
	status: "status",
	phase: "phase",
	progress: "progress",
	currentNodeId: "current_node_id",
	currentNodeName: "current_node_name",
	primaryTraceId: "primary_trace_id",
	workflowSessionId: "workflow_session_id",
	output: "output",
	summaryOutput: "summary_output",
	error: "error",
	completedAt: "completed_at",
	duration: "duration",
};

const LOG_PATCH_COLUMNS: Record<keyof WorkflowExecutionLogPatch, string> = {
	status: "status",
	output: "output",
	error: "error",
	completedAt: "completed_at",
	duration: "duration",
	credentialFetchMs: "credential_fetch_ms",
	routingMs: "routing_ms",
	coldStartMs: "cold_start_ms",
	executionMs: "execution_ms",
	routedTo: "routed_to",
	wasColdStart: "was_cold_start",
};

function rowToExecution(row: readonly unknown[]): WorkflowExecutionRecord {
	return {
		id: stringValue(row[0]),
		workflowId: stringValue(row[1]),
		userId: stringValue(row[2]),
		projectId: stringOrNull(row[3]),
		status: stringValue(row[4]) as WorkflowExecutionStatus,
		input: jsonValue<Record<string, unknown> | null>(row[5], null),
		output: jsonValue(row[6], null),
		executionIrVersion: stringOrNull(row[7]),
		executionIr: jsonValue(row[8], null),
		error: stringOrNull(row[9]),
		daprInstanceId: stringOrNull(row[10]),
		phase: stringOrNull(row[11]),
		progress: numberOrNull(row[12]),
		currentNodeId: stringOrNull(row[13]),
		currentNodeName: stringOrNull(row[14]),
		primaryTraceId: stringOrNull(row[15]),
		workflowSessionId: stringOrNull(row[16]),
		mlflowExperimentId: stringOrNull(row[17]),
		mlflowRunId: stringOrNull(row[18]),
		summaryOutput: jsonValue<Record<string, unknown> | null>(row[19], null),
		errorStackTrace: stringOrNull(row[20]),
		rerunOfExecutionId: stringOrNull(row[21]),
		rerunSourceInstanceId: stringOrNull(row[22]),
		resumeFromNode: stringOrNull(row[23]),
		triggerSource: stringOrNull(row[24]),
		rerunFromEventId: numberOrNull(row[25]),
		startedAt: dateValue(row[26]),
		completedAt: dateOrNull(row[27]),
		duration: stringOrNull(row[28]),
		stopRequestedAt: dateOrNull(row[29]),
		stopReason: stringOrNull(row[30]),
		seedWorkspaceFrom: stringOrNull(row[31]),
	};
}

function rowToExecutionLog(row: readonly unknown[]): WorkflowExecutionLogRecord {
	return {
		id: stringValue(row[0]),
		executionId: stringValue(row[1]),
		nodeId: stringValue(row[2]),
		nodeName: stringValue(row[3]),
		nodeType: stringValue(row[4]),
		activityName: stringOrNull(row[5]),
		status: stringValue(row[6]) as WorkflowExecutionLogRecord["status"],
		input: jsonValue(row[7], null),
		output: jsonValue(row[8], null),
		error: stringOrNull(row[9]),
		startedAt: dateValue(row[10]),
		completedAt: dateOrNull(row[11]),
		duration: stringOrNull(row[12]),
		timestamp: dateValue(row[13]),
		credentialFetchMs: numberOrNull(row[14]),
		routingMs: numberOrNull(row[15]),
		coldStartMs: numberOrNull(row[16]),
		executionMs: numberOrNull(row[17]),
		routedTo: stringOrNull(row[18]),
		wasColdStart: booleanOrNull(row[19]),
	};
}

function jsonColumn(column: string): boolean {
	return ["input", "output", "execution_ir", "summary_output"].includes(column);
}

function valueForColumn(column: string, value: unknown): unknown {
	if (jsonColumn(column)) return jsonParam(value ?? null);
	if (value instanceof Date) return value.toISOString();
	return value ?? null;
}

function assignmentFor(column: string, index: number): string {
	return jsonColumn(column) ? `${column} = CAST($${index} AS jsonb)` : `${column} = $${index}`;
}

export class DaprPostgresWorkflowExecutionRepository extends PostgresWorkflowExecutionRepository {
	constructor(
		database: ConstructorParameters<typeof PostgresWorkflowExecutionRepository>[0],
		private readonly client: BindingClient = new DaprPostgresBindingClient(),
	) {
		super(database);
	}

	async getById(id: string): Promise<WorkflowExecutionRecord | null> {
		const result = await this.client.query({
			summary: "workflow_executions.select_by_id",
			collection: "workflow_executions",
			sql: `
				SELECT ${EXECUTION_COLUMNS}
				FROM workflow_executions
				WHERE id = $1
				LIMIT 1
			`,
			params: [id],
			paramNames: ["id"],
		});
		return result.rows[0] ? rowToExecution(result.rows[0]) : null;
	}

	async getByDaprInstanceId(instanceId: string): Promise<WorkflowExecutionRecord | null> {
		const result = await this.client.query({
			summary: "workflow_executions.select_by_dapr_instance",
			collection: "workflow_executions",
			sql: `
				SELECT ${EXECUTION_COLUMNS}
				FROM workflow_executions
				WHERE dapr_instance_id = $1
				LIMIT 1
			`,
			params: [instanceId],
			paramNames: ["dapr_instance_id"],
		});
		return result.rows[0] ? rowToExecution(result.rows[0]) : null;
	}

	async listByWorkflowId(input: {
		workflowId: string;
		limit: number;
		include?: "summary" | "full";
	}): Promise<WorkflowExecutionListItem[]> {
		const includeFull = input.include === "full";
		const baseColumns = `id, workflow_id, status, dapr_instance_id, started_at, completed_at, duration, trigger_source, rerun_of_execution_id, resume_from_node, seed_workspace_from`;
		const columns = includeFull ? `${baseColumns}, input, output` : baseColumns;
		const result = await this.client.query({
			summary: "workflow_executions.select_by_workflow",
			collection: "workflow_executions",
			sql: `
				SELECT ${columns}
				FROM workflow_executions
				WHERE workflow_id = $1
				ORDER BY started_at DESC
				LIMIT $2
			`,
			params: [input.workflowId, Number.isFinite(input.limit) ? Math.max(1, input.limit) : 20],
			paramNames: ["workflow_id", "limit"],
		});
		return result.rows.map((row) => ({
			id: stringValue(row[0]),
			workflowId: stringValue(row[1]),
			status: stringValue(row[2]) as WorkflowExecutionStatus,
			daprInstanceId: stringOrNull(row[3]),
			startedAt: dateValue(row[4]),
			completedAt: dateOrNull(row[5]),
			duration: stringOrNull(row[6]),
			triggerSource: stringOrNull(row[7]),
			rerunOfExecutionId: stringOrNull(row[8]),
			resumeFromNode: stringOrNull(row[9]),
			seedWorkspaceFrom: stringOrNull(row[10]),
			...(includeFull
				? {
						input: jsonValue<Record<string, unknown> | null>(row[11], null),
						output: jsonValue(row[12], null),
					}
				: {}),
		}));
	}

	async create(input: CreateWorkflowExecutionInput): Promise<{ id: string }> {
		const id = input.id || generateId();
		await this.client.exec({
			summary: "workflow_executions.insert",
			collection: "workflow_executions",
			sql: `
				INSERT INTO workflow_executions (
					id,
					workflow_id,
					user_id,
					project_id,
					status,
					phase,
					progress,
					input,
					output,
					execution_ir,
					execution_ir_version,
					workflow_session_id,
					trigger_source,
					rerun_of_execution_id,
					rerun_source_instance_id,
					resume_from_node,
					seed_workspace_from
				)
				VALUES (
					$1, $2, $3, $4, $5, $6, $7,
					CAST($8 AS jsonb),
					CAST($9 AS jsonb),
					CAST($10 AS jsonb),
					$11, $12, $13, $14, $15, $16, $17
				)
			`,
			params: [
				id,
				input.workflowId,
				input.userId,
				input.projectId ?? null,
				input.status,
				input.phase ?? null,
				input.progress ?? null,
				jsonParam(input.input ?? null),
				jsonParam(input.output ?? null),
				jsonParam(input.executionIr ?? null),
				input.executionIrVersion ?? null,
				input.workflowSessionId ?? input.id ?? null,
				input.triggerSource ?? null,
				input.rerunOfExecutionId ?? null,
				input.rerunSourceInstanceId ?? null,
				input.resumeFromNode ?? null,
				input.seedWorkspaceFrom ?? null,
			],
			spanParams: [
				id,
				input.workflowId,
				input.userId,
				input.projectId ?? null,
				input.status,
				input.phase ?? null,
				input.progress ?? null,
				input.input ?? null,
				input.output ?? null,
				input.executionIr ?? null,
				input.executionIrVersion ?? null,
				input.workflowSessionId ?? input.id ?? null,
				input.triggerSource ?? null,
				input.rerunOfExecutionId ?? null,
				input.rerunSourceInstanceId ?? null,
				input.resumeFromNode ?? null,
				input.seedWorkspaceFrom ?? null,
			],
			paramNames: [
				"id",
				"workflow_id",
				"user_id",
				"project_id",
				"status",
				"phase",
				"progress",
				"input",
				"output",
				"execution_ir",
				"execution_ir_version",
				"workflow_session_id",
				"trigger_source",
				"rerun_of_execution_id",
				"rerun_source_instance_id",
				"resume_from_node",
			],
		});
		return { id };
	}

	async attachSchedulerInstance(input: {
		executionId: string;
		instanceId: string;
		workflowSessionId?: string | null;
		primaryTraceId?: string | null;
	}): Promise<void> {
		await this.client.exec({
			summary: "workflow_executions.attach_scheduler_instance",
			collection: "workflow_executions",
			sql: `
				UPDATE workflow_executions
					SET
						dapr_instance_id = $2,
						phase = CASE
							WHEN status IN ('pending', 'running') AND stop_requested_at IS NULL
							THEN 'running' ELSE phase END,
						progress = CASE
							WHEN status IN ('pending', 'running') AND stop_requested_at IS NULL
							THEN 0 ELSE progress END,
						workflow_session_id = coalesce(workflow_session_id, $3),
						primary_trace_id = coalesce(primary_trace_id, $4),
						stop_requested_at = CASE
							WHEN status IN ('success', 'error', 'cancelled')
								AND stop_reason IS NOT NULL AND stop_requested_at IS NULL
								AND dapr_instance_id IS DISTINCT FROM $2
							THEN now() ELSE stop_requested_at END,
						stop_requested_mode = CASE
							WHEN status IN ('success', 'error', 'cancelled')
								AND stop_reason IS NOT NULL AND stop_requested_at IS NULL
								AND dapr_instance_id IS DISTINCT FROM $2
							THEN coalesce(stop_requested_mode, 'terminate')
							ELSE stop_requested_mode END
						WHERE id = $1
			`,
			params: [
				input.executionId,
				input.instanceId,
				input.workflowSessionId ?? input.executionId,
				input.primaryTraceId ?? null,
			],
			paramNames: [
				"id",
				"dapr_instance_id",
				"workflow_session_id",
				"primary_trace_id",
			],
		});
	}

	async markStartFailed(input: { executionId: string; error: string }): Promise<void> {
		await this.client.exec({
			summary: "workflow_executions.mark_start_failed",
			collection: "workflow_executions",
			sql: `
				UPDATE workflow_executions
				SET status = 'error',
					phase = 'failed',
					progress = 100,
					error = $2,
					completed_at = now()
					WHERE id = $1
						AND status IN ('pending', 'running')
						AND stop_requested_at IS NULL
			`,
			params: [input.executionId, input.error],
			paramNames: ["id", "error"],
		});
	}

	async listStaleRunningExecutions(input: {
		olderThanMinutes: number;
	}): Promise<Pick<WorkflowExecutionRecord, "id" | "daprInstanceId" | "input">[]> {
		const result = await this.client.query({
			summary: "workflow_executions.select_stale_running",
			collection: "workflow_executions",
			sql: `
				SELECT id, dapr_instance_id, input
				FROM workflow_executions
				WHERE status = 'running'
					AND started_at < now() - ($1 * interval '1 minute')
			`,
			params: [Math.max(0, input.olderThanMinutes)],
			paramNames: ["older_than_minutes"],
		});
		return result.rows.map((row) => ({
			id: stringValue(row[0]),
			daprInstanceId: stringOrNull(row[1]),
			input: jsonValue<Record<string, unknown> | null>(row[2], null),
		}));
	}

	async applyRuntimeProjection(
		executionId: string,
		patch: WorkflowExecutionReadModelPatch,
	): Promise<WorkflowExecutionRuntimeProjectionResult> {
		const entries = Object.entries(patch).filter(
			([key]) => key in READ_MODEL_PATCH_COLUMNS,
		) as Array<[keyof WorkflowExecutionReadModelPatch, unknown]>;
		if (entries.length === 0) return { applied: true };
		const assignments = entries.map(([key], index) =>
			assignmentFor(READ_MODEL_PATCH_COLUMNS[key], index + 2),
		);
		const result = await this.client.exec({
			summary: "workflow_executions.update_read_model",
			collection: "workflow_executions",
			sql: `
				UPDATE workflow_executions
				SET ${assignments.join(", ")}
				WHERE id = $1
					AND status IN ('pending', 'running')
					AND stop_requested_at IS NULL
			`,
			params: [
				executionId,
				...entries.map(([key, value]) =>
					valueForColumn(READ_MODEL_PATCH_COLUMNS[key], value),
				),
			],
			spanParams: [executionId, ...entries.map(([, value]) => value ?? null)],
			paramNames: ["id", ...entries.map(([key]) => READ_MODEL_PATCH_COLUMNS[key])],
		});
		if ((result.rowsAffected ?? 0) > 0) return { applied: true };

		const current = await this.getById(executionId);
		if (!current) return { applied: false, reason: "not_found" };
		return current.stopRequestedAt
			? {
					applied: false,
					reason: "stop_requested",
					currentStatus: current.status,
				}
			: {
					applied: false,
					reason: "terminal",
					currentStatus: current.status,
				};
	}

	async compareAndSetReadModel(
		input: CompareAndSetWorkflowExecutionReadModelInput,
	): Promise<WorkflowExecutionRecord | null> {
		const entries = Object.entries(input.patch).filter(
			([key]) => key in READ_MODEL_PATCH_COLUMNS,
		) as Array<[keyof WorkflowExecutionReadModelPatch, unknown]>;
		if (entries.length === 0) return this.getById(input.executionId);
		const assignments = entries.map(([key], index) =>
			assignmentFor(READ_MODEL_PATCH_COLUMNS[key], index + 3),
		);
		await this.client.exec({
			summary: "workflow_executions.compare_and_set_read_model",
			collection: "workflow_executions",
			sql: `
				UPDATE workflow_executions
				SET ${assignments.join(", ")}
				WHERE id = $1
						AND status = $2
						AND stop_requested_at IS NULL
						AND (status <> 'cancelled' OR stop_reason IS NULL)
			`,
			params: [
				input.executionId,
				input.expectedStatus,
				...entries.map(([key, value]) =>
					valueForColumn(READ_MODEL_PATCH_COLUMNS[key], value),
				),
			],
			spanParams: [
				input.executionId,
				input.expectedStatus,
				...entries.map(([, value]) => value ?? null),
			],
			paramNames: [
				"id",
				"expected_status",
				...entries.map(([key]) => READ_MODEL_PATCH_COLUMNS[key]),
			],
		});
		// The guarded write is atomic; the reload returns either our update or the row that won.
		return this.getById(input.executionId);
	}

	async appendLog(input: AppendWorkflowExecutionLogInput): Promise<WorkflowExecutionLogRecord> {
		const id = input.id || generateId();
		const params = [
			id,
			input.executionId,
			input.nodeId,
			input.nodeName,
			input.nodeType,
			input.activityName ?? null,
			input.status,
			jsonParam(input.input ?? null),
			jsonParam(input.output ?? null),
			input.error ?? null,
			input.startedAt?.toISOString() ?? null,
			input.completedAt?.toISOString() ?? null,
			input.duration ?? null,
			input.credentialFetchMs ?? null,
			input.routingMs ?? null,
			input.coldStartMs ?? null,
			input.executionMs ?? null,
			input.routedTo ?? null,
			input.wasColdStart ?? null,
		];
		await this.client.exec({
			summary: "workflow_execution_logs.insert",
			collection: "workflow_execution_logs",
			sql: `
				INSERT INTO workflow_execution_logs (
					id,
					execution_id,
					node_id,
					node_name,
					node_type,
					activity_name,
					status,
					input,
					output,
					error,
					started_at,
					completed_at,
					duration,
					credential_fetch_ms,
					routing_ms,
					cold_start_ms,
					execution_ms,
					routed_to,
					was_cold_start
				)
				VALUES (
					$1, $2, $3, $4, $5, $6, $7,
					CAST($8 AS jsonb),
					CAST($9 AS jsonb),
					$10,
					coalesce($11::timestamp, now()),
					$12,
					$13, $14, $15, $16, $17, $18, $19
				)
			`,
			params,
			spanParams: [
				...params.slice(0, 7),
				input.input ?? null,
				input.output ?? null,
				...params.slice(9),
			],
			paramNames: [
				"id",
				"execution_id",
				"node_id",
				"node_name",
				"node_type",
				"activity_name",
				"status",
				"input",
				"output",
				"error",
				"started_at",
				"completed_at",
				"duration",
				"credential_fetch_ms",
				"routing_ms",
				"cold_start_ms",
				"execution_ms",
				"routed_to",
				"was_cold_start",
			],
		});
		const row = await this.getLog(input.executionId, id);
		if (!row) throw new Error("Failed to append workflow execution log");
		return row;
	}

	async updateLog(
		executionId: string,
		id: string,
		patch: WorkflowExecutionLogPatch,
	): Promise<WorkflowExecutionLogRecord | null> {
		const entries = Object.entries(patch).filter(
			([key]) => key in LOG_PATCH_COLUMNS,
		) as Array<[keyof WorkflowExecutionLogPatch, unknown]>;
		if (entries.length === 0) return this.getLog(executionId, id);
		const assignments = entries.map(([key], index) =>
			assignmentFor(LOG_PATCH_COLUMNS[key], index + 3),
		);
		await this.client.exec({
			summary: "workflow_execution_logs.update",
			collection: "workflow_execution_logs",
			sql: `
				UPDATE workflow_execution_logs
				SET ${assignments.join(", ")}
				WHERE execution_id = $1 AND id = $2
			`,
			params: [
				executionId,
				id,
				...entries.map(([key, value]) => valueForColumn(LOG_PATCH_COLUMNS[key], value)),
			],
			spanParams: [executionId, id, ...entries.map(([, value]) => value ?? null)],
			paramNames: [
				"execution_id",
				"id",
				...entries.map(([key]) => LOG_PATCH_COLUMNS[key]),
			],
		});
		return this.getLog(executionId, id);
	}

	async listLogsByExecutionId(executionId: string): Promise<WorkflowExecutionLogRecord[]> {
		const result = await this.client.query({
			summary: "workflow_execution_logs.select_by_execution",
			collection: "workflow_execution_logs",
			sql: `
				SELECT ${EXECUTION_LOG_COLUMNS}
				FROM workflow_execution_logs
				WHERE execution_id = $1
				ORDER BY started_at ASC
			`,
			params: [executionId],
			paramNames: ["execution_id"],
		});
		return result.rows.map(rowToExecutionLog);
	}

	async listLogsByWorkflowSince(input: {
		workflowId: string;
		since: Date;
		executionLimit: number;
	}): Promise<WorkflowExecutionLogRecord[]> {
		const result = await this.client.query({
			summary: "workflow_execution_logs.select_by_workflow_since",
			collection: "workflow_execution_logs",
			sql: `
				WITH recent_executions AS (
					SELECT id
					FROM workflow_executions
					WHERE workflow_id = $1 AND started_at >= $2
					ORDER BY started_at DESC
					LIMIT $3
				)
				SELECT ${EXECUTION_LOG_COLUMNS}
				FROM workflow_execution_logs
				WHERE execution_id IN (SELECT id FROM recent_executions)
				ORDER BY started_at ASC
			`,
			params: [input.workflowId, input.since.toISOString(), input.executionLimit],
			paramNames: ["workflow_id", "since", "execution_limit"],
		});
		return result.rows.map(rowToExecutionLog);
	}

	private async getLog(
		executionId: string,
		id: string,
	): Promise<WorkflowExecutionLogRecord | null> {
		const result = await this.client.query({
			summary: "workflow_execution_logs.select_by_pk",
			collection: "workflow_execution_logs",
			sql: `
				SELECT ${EXECUTION_LOG_COLUMNS}
				FROM workflow_execution_logs
				WHERE execution_id = $1 AND id = $2
				LIMIT 1
			`,
			params: [executionId, id],
			paramNames: ["execution_id", "id"],
		});
		return result.rows[0] ? rowToExecutionLog(result.rows[0]) : null;
	}
}
