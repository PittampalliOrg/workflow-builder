import postgres, { type Sql } from "postgres";

const DATABASE_URL =
	process.env.WORKSPACE_RECON_DATABASE_URL || process.env.DATABASE_URL || "";

type WorkflowAgentRunRow = {
	id: string;
	workflow_execution_id: string;
	workflow_id: string;
	node_id: string;
	mode: "run" | "plan" | "execute_plan";
	agent_workflow_id: string;
	dapr_instance_id: string;
	parent_execution_id: string;
	workspace_ref: string | null;
	artifact_ref: string | null;
	status: "scheduled" | "completed" | "failed" | "event_published";
	result: Record<string, unknown> | null;
	error: string | null;
	completed_at: string | Date | null;
	event_published_at: string | Date | null;
	last_reconciled_at: string | Date | null;
	created_at: string | Date;
	updated_at: string | Date;
};

export type TrackedWorkflowAgentRun = {
	id: string;
	workflowExecutionId: string;
	workflowId: string;
	nodeId: string;
	mode: "run" | "plan" | "execute_plan";
	agentWorkflowId: string;
	daprInstanceId: string;
	parentExecutionId: string;
	workspaceRef?: string;
	artifactRef?: string;
	status: "scheduled" | "completed" | "failed" | "event_published";
	result?: Record<string, unknown>;
	error?: string;
	completedAt?: string;
	eventPublishedAt?: string;
	lastReconciledAt?: string;
	createdAt: string;
	updatedAt: string;
};

type TrackInput = {
	id: string;
	workflowExecutionId: string;
	workflowId: string;
	nodeId: string;
	mode: "run" | "plan" | "execute_plan";
	agentWorkflowId: string;
	daprInstanceId: string;
	parentExecutionId: string;
	workspaceRef?: string;
	artifactRef?: string;
};

function toIso(input: string | Date | null | undefined): string | undefined {
	if (!input) return undefined;
	if (input instanceof Date) return input.toISOString();
	const parsed = Date.parse(input);
	return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function toTracked(row: WorkflowAgentRunRow): TrackedWorkflowAgentRun {
	return {
		id: row.id,
		workflowExecutionId: row.workflow_execution_id,
		workflowId: row.workflow_id,
		nodeId: row.node_id,
		mode: row.mode,
		agentWorkflowId: row.agent_workflow_id,
		daprInstanceId: row.dapr_instance_id,
		parentExecutionId: row.parent_execution_id,
		workspaceRef: row.workspace_ref ?? undefined,
		artifactRef: row.artifact_ref ?? undefined,
		status: row.status,
		result: row.result ?? undefined,
		error: row.error ?? undefined,
		completedAt: toIso(row.completed_at),
		eventPublishedAt: toIso(row.event_published_at),
		lastReconciledAt: toIso(row.last_reconciled_at),
		createdAt: toIso(row.created_at) || new Date().toISOString(),
		updatedAt: toIso(row.updated_at) || new Date().toISOString(),
	};
}

class WorkflowRunTracker {
	private readonly sql: Sql | null;

	constructor() {
		this.sql = DATABASE_URL
			? postgres(DATABASE_URL, {
					max: parseInt(
						process.env.WORKSPACE_RECON_DB_MAX_CONNECTIONS || "4",
						10,
					),
					idle_timeout: parseInt(
						process.env.WORKSPACE_RECON_DB_IDLE_TIMEOUT_SECONDS || "30",
						10,
					),
				})
			: null;
	}

	private ensureSql(): Sql {
		if (!this.sql) {
			throw new Error(
				"DATABASE_URL (or WORKSPACE_RECON_DATABASE_URL) is required for workflow run tracking",
			);
		}
		return this.sql;
	}

	async trackScheduled(input: TrackInput): Promise<void> {
		const sql = this.ensureSql();
		await sql`
			insert into workflow_agent_runs (
				id,
				workflow_execution_id,
				workflow_id,
				node_id,
				mode,
				agent_workflow_id,
				dapr_instance_id,
				parent_execution_id,
				workspace_ref,
				artifact_ref,
				status,
				created_at,
				updated_at
			)
			values (
				${input.id},
				${input.workflowExecutionId},
				${input.workflowId},
				${input.nodeId},
				${input.mode},
				${input.agentWorkflowId},
				${input.daprInstanceId},
				${input.parentExecutionId},
				${input.workspaceRef ?? null},
				${input.artifactRef ?? null},
				'scheduled',
				now(),
				now()
			)
			on conflict (id) do update
			set
				workflow_execution_id = excluded.workflow_execution_id,
				workflow_id = excluded.workflow_id,
				node_id = excluded.node_id,
				mode = excluded.mode,
				agent_workflow_id = excluded.agent_workflow_id,
				dapr_instance_id = excluded.dapr_instance_id,
				parent_execution_id = excluded.parent_execution_id,
				workspace_ref = excluded.workspace_ref,
				artifact_ref = excluded.artifact_ref,
				status = 'scheduled',
				updated_at = now()
		`;
	}

	async markCompleted(input: {
		id: string;
		success: boolean;
		result?: Record<string, unknown>;
		error?: string;
	}): Promise<void> {
		const sql = this.ensureSql();
		await sql`
			update workflow_agent_runs
			set
				status = ${input.success ? "completed" : "failed"},
				result = ${sql.json((input.result ?? null) as any)},
				error = ${input.error ?? null},
				completed_at = now(),
				updated_at = now()
			where id = ${input.id}
		`;
	}

	async markEventPublished(id: string): Promise<void> {
		const sql = this.ensureSql();
		await sql`
			update workflow_agent_runs
			set
				status = 'event_published',
				event_published_at = now(),
				updated_at = now()
			where id = ${id}
		`;
	}

	async markReconciled(id: string): Promise<void> {
		const sql = this.ensureSql();
		await sql`
			update workflow_agent_runs
			set
				last_reconciled_at = now(),
				updated_at = now()
			where id = ${id}
		`;
	}

	async listPending(limit = 50): Promise<TrackedWorkflowAgentRun[]> {
		const sql = this.ensureSql();
		const safeLimit = Math.max(1, Math.min(limit, 500));
		const rows = await sql<WorkflowAgentRunRow[]>`
			select
				id,
				workflow_execution_id,
				workflow_id,
				node_id,
				mode,
				agent_workflow_id,
				dapr_instance_id,
				parent_execution_id,
				workspace_ref,
				artifact_ref,
				status,
				result,
				error,
				completed_at,
				event_published_at,
				last_reconciled_at,
				created_at,
				updated_at
			from workflow_agent_runs
			where event_published_at is null
			order by created_at asc
			limit ${safeLimit}
		`;
		return rows.map(toTracked);
	}

	async getById(id: string): Promise<TrackedWorkflowAgentRun | undefined> {
		if (!this.sql) return undefined;
		const rows = await this.sql<WorkflowAgentRunRow[]>`
			select
				id,
				workflow_execution_id,
				workflow_id,
				node_id,
				mode,
				agent_workflow_id,
				dapr_instance_id,
				parent_execution_id,
				workspace_ref,
				artifact_ref,
				status,
				result,
				error,
				completed_at,
				event_published_at,
				last_reconciled_at,
				created_at,
				updated_at
			from workflow_agent_runs
			where id = ${id}
			limit 1
		`;
		const row = rows[0];
		if (!row) return undefined;
		return toTracked(row);
	}

	async listScheduledByParentExecutionId(
		parentExecutionId: string,
		limit = 50,
	): Promise<TrackedWorkflowAgentRun[]> {
		if (!this.sql) return [];
		const safeLimit = Math.max(1, Math.min(limit, 500));
		const rows = await this.sql<WorkflowAgentRunRow[]>`
			select
				id,
				workflow_execution_id,
				workflow_id,
				node_id,
				mode,
				agent_workflow_id,
				dapr_instance_id,
				parent_execution_id,
				workspace_ref,
				artifact_ref,
				status,
				result,
				error,
				completed_at,
				event_published_at,
				last_reconciled_at,
				created_at,
				updated_at
			from workflow_agent_runs
			where parent_execution_id = ${parentExecutionId}
				and status = 'scheduled'
			order by created_at asc
			limit ${safeLimit}
		`;
		return rows.map(toTracked);
	}
}

export const workflowRunTracker = new WorkflowRunTracker();
