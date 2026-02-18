import { nanoid } from "nanoid";
import postgres, { type Sql } from "postgres";

const DATABASE_URL =
	process.env.WORKSPACE_RECON_DATABASE_URL || process.env.DATABASE_URL || "";

type PlanArtifactRow = {
	id: string;
	workflow_execution_id: string;
	workflow_id: string;
	user_id: string | null;
	node_id: string;
	workspace_ref: string | null;
	clone_path: string | null;
	artifact_type: string;
	artifact_version: number;
	status: string;
	goal: string;
	plan_json: unknown;
	plan_markdown: string | null;
	source_prompt: string | null;
	metadata: unknown;
	created_at: string | Date;
	updated_at: string | Date;
};

export type PersistedPlanArtifact = {
	artifactRef: string;
	workflowExecutionId: string;
	workflowId: string;
	userId?: string;
	nodeId: string;
	workspaceRef?: string;
	clonePath?: string;
	artifactType: string;
	artifactVersion: number;
	status: string;
	goal: string;
	plan: Record<string, unknown>;
	planMarkdown?: string;
	sourcePrompt?: string;
	metadata?: Record<string, unknown> | null;
	createdAt: string;
	updatedAt: string;
};

type SavePlanArtifactInput = {
	workflowExecutionId: string;
	workflowId: string;
	nodeId: string;
	workspaceRef?: string;
	clonePath?: string;
	goal: string;
	plan: Record<string, unknown>;
	planMarkdown?: string;
	sourcePrompt?: string;
	metadata?: Record<string, unknown> | null;
	artifactType?: string;
	artifactVersion?: number;
	status?: string;
};

function toIso(input: string | Date): string {
	if (input instanceof Date) {
		return input.toISOString();
	}
	const parsed = Date.parse(input);
	if (Number.isFinite(parsed)) {
		return new Date(parsed).toISOString();
	}
	return new Date().toISOString();
}

function toPersisted(row: PlanArtifactRow): PersistedPlanArtifact {
	const plan =
		row.plan_json && typeof row.plan_json === "object"
			? (row.plan_json as Record<string, unknown>)
			: {};
	const metadata =
		row.metadata && typeof row.metadata === "object"
			? (row.metadata as Record<string, unknown>)
			: null;
	return {
		artifactRef: row.id,
		workflowExecutionId: row.workflow_execution_id,
		workflowId: row.workflow_id,
		userId: row.user_id ?? undefined,
		nodeId: row.node_id,
		workspaceRef: row.workspace_ref ?? undefined,
		clonePath: row.clone_path ?? undefined,
		artifactType: row.artifact_type,
		artifactVersion: row.artifact_version,
		status: row.status,
		goal: row.goal,
		plan,
		planMarkdown: row.plan_markdown ?? undefined,
		sourcePrompt: row.source_prompt ?? undefined,
		metadata,
		createdAt: toIso(row.created_at),
		updatedAt: toIso(row.updated_at),
	};
}

class PlanArtifactStore {
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
				"DATABASE_URL (or WORKSPACE_RECON_DATABASE_URL) is required for plan artifacts",
			);
		}
		return this.sql;
	}

	async save(input: SavePlanArtifactInput): Promise<PersistedPlanArtifact> {
		const sql = this.ensureSql();
		const artifactRef = `plan_${nanoid(16)}`;
		const workflowExecutionId = input.workflowExecutionId.trim();
		const workflowId = input.workflowId.trim();
		const nodeId = input.nodeId.trim();
		const goal = input.goal.trim();
		if (!workflowExecutionId || !workflowId || !nodeId || !goal) {
			throw new Error(
				"workflowExecutionId, workflowId, nodeId, and goal are required for plan artifacts",
			);
		}

		const [execution] = await sql<
			Array<{ workflow_id: string | null; user_id: string | null }>
		>`
			select workflow_id, user_id
			from workflow_executions
			where id = ${workflowExecutionId}
			limit 1
		`;

		const resolvedWorkflowId =
			(execution?.workflow_id || "").trim() || workflowId;
		const userId = execution?.user_id || null;

		const [existingDraft] = await sql<PlanArtifactRow[]>`
			select
				id,
				workflow_execution_id,
				workflow_id,
				user_id,
				node_id,
				workspace_ref,
				clone_path,
				artifact_type,
				artifact_version,
				status,
				goal,
				plan_json,
				plan_markdown,
				source_prompt,
				metadata,
				created_at,
				updated_at
			from workflow_plan_artifacts
			where workflow_execution_id = ${workflowExecutionId}
				and workflow_id = ${resolvedWorkflowId}
				and node_id = ${nodeId}
				and status = 'draft'
			order by updated_at desc
			limit 1
		`;
		if (existingDraft) {
			const [updated] = await sql<PlanArtifactRow[]>`
				update workflow_plan_artifacts
				set
					user_id = ${userId},
					workspace_ref = ${input.workspaceRef ?? null},
					clone_path = ${input.clonePath ?? null},
					artifact_type = ${input.artifactType ?? "task_graph_v1"},
					artifact_version = ${input.artifactVersion ?? 1},
					status = ${input.status ?? "draft"},
					goal = ${goal},
					plan_json = ${sql.json(input.plan as any)},
					plan_markdown = ${input.planMarkdown ?? null},
					source_prompt = ${input.sourcePrompt ?? null},
					metadata = ${sql.json((input.metadata ?? null) as any)},
					updated_at = now()
				where id = ${existingDraft.id}
				returning
					id,
					workflow_execution_id,
					workflow_id,
					user_id,
					node_id,
					workspace_ref,
					clone_path,
					artifact_type,
					artifact_version,
					status,
					goal,
					plan_json,
					plan_markdown,
					source_prompt,
					metadata,
					created_at,
					updated_at
			`;
			return toPersisted(updated);
		}

		const [row] = await sql<PlanArtifactRow[]>`
			insert into workflow_plan_artifacts (
				id,
				workflow_execution_id,
				workflow_id,
				user_id,
				node_id,
				workspace_ref,
				clone_path,
				artifact_type,
				artifact_version,
				status,
				goal,
				plan_json,
				plan_markdown,
				source_prompt,
				metadata,
				created_at,
				updated_at
			)
			values (
				${artifactRef},
				${workflowExecutionId},
				${resolvedWorkflowId},
				${userId},
				${nodeId},
				${input.workspaceRef ?? null},
				${input.clonePath ?? null},
				${input.artifactType ?? "task_graph_v1"},
				${input.artifactVersion ?? 1},
				${input.status ?? "draft"},
				${goal},
				${sql.json(input.plan as any)},
				${input.planMarkdown ?? null},
				${input.sourcePrompt ?? null},
				${sql.json((input.metadata ?? null) as any)},
				now(),
				now()
			)
			returning
				id,
				workflow_execution_id,
				workflow_id,
				user_id,
				node_id,
				workspace_ref,
				clone_path,
				artifact_type,
				artifact_version,
				status,
				goal,
				plan_json,
				plan_markdown,
				source_prompt,
				metadata,
				created_at,
				updated_at
		`;
		return toPersisted(row);
	}

	async get(artifactRef: string): Promise<PersistedPlanArtifact | null> {
		const sql = this.ensureSql();
		const ref = artifactRef.trim();
		if (!ref) return null;
		const [row] = await sql<PlanArtifactRow[]>`
			select
				id,
				workflow_execution_id,
				workflow_id,
				user_id,
				node_id,
				workspace_ref,
				clone_path,
				artifact_type,
				artifact_version,
				status,
				goal,
				plan_json,
				plan_markdown,
				source_prompt,
				metadata,
				created_at,
				updated_at
			from workflow_plan_artifacts
			where id = ${ref}
			limit 1
		`;
		return row ? toPersisted(row) : null;
	}

	async markStatus(
		artifactRef: string,
		status: "executed" | "failed" | "approved" | "superseded",
	): Promise<void> {
		const sql = this.ensureSql();
		const ref = artifactRef.trim();
		if (!ref) return;
		await sql`
			update workflow_plan_artifacts
			set status = ${status}, updated_at = now()
			where id = ${ref}
		`;
	}
}

export const planArtifacts = new PlanArtifactStore();
