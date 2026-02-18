import postgres, { type Sql } from "postgres";

const DATABASE_URL =
	process.env.WORKSPACE_RECON_DATABASE_URL || process.env.DATABASE_URL || "";

type WorkspaceSessionRow = {
	workspace_ref: string;
	workflow_execution_id: string;
	durable_instance_id: string | null;
	name: string;
	root_path: string;
	clone_path: string | null;
	backend: "k8s" | "local";
	enabled_tools: string[] | string;
	require_read_before_write: boolean;
	command_timeout_ms: number;
	status: "active" | "cleaned" | "error";
	last_error: string | null;
};

export type PersistedWorkspaceSession = {
	workspaceRef: string;
	workflowExecutionId: string;
	durableInstanceId?: string;
	name: string;
	rootPath: string;
	clonePath?: string;
	backend: "k8s" | "local";
	enabledTools: string[];
	requireReadBeforeWrite: boolean;
	commandTimeoutMs: number;
	status: "active" | "cleaned" | "error";
	lastError?: string;
};

function parseEnabledTools(input: string[] | string): string[] {
	if (Array.isArray(input)) return input.map((t) => String(t));
	if (typeof input === "string" && input.trim()) {
		try {
			const parsed = JSON.parse(input) as unknown[];
			return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
		} catch {
			return [];
		}
	}
	return [];
}

function toPersisted(row: WorkspaceSessionRow): PersistedWorkspaceSession {
	return {
		workspaceRef: row.workspace_ref,
		workflowExecutionId: row.workflow_execution_id,
		durableInstanceId: row.durable_instance_id || undefined,
		name: row.name,
		rootPath: row.root_path,
		clonePath: row.clone_path || undefined,
		backend: row.backend,
		enabledTools: parseEnabledTools(row.enabled_tools),
		requireReadBeforeWrite: row.require_read_before_write,
		commandTimeoutMs: row.command_timeout_ms,
		status: row.status,
		lastError: row.last_error || undefined,
	};
}

class WorkspaceSessionStore {
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
				"DATABASE_URL (or WORKSPACE_RECON_DATABASE_URL) is required for durable workspace sessions",
			);
		}
		return this.sql;
	}

	async upsert(input: {
		workspaceRef: string;
		workflowExecutionId: string;
		name: string;
		rootPath: string;
		backend: "k8s" | "local";
		enabledTools: string[];
		requireReadBeforeWrite: boolean;
		commandTimeoutMs: number;
		status?: "active" | "cleaned" | "error";
	}): Promise<void> {
		const sql = this.ensureSql();
		await sql`
			insert into workflow_workspace_sessions (
				workspace_ref,
				workflow_execution_id,
				name,
				root_path,
				backend,
				enabled_tools,
				require_read_before_write,
				command_timeout_ms,
				status,
				created_at,
				updated_at,
				last_accessed_at
			)
			values (
				${input.workspaceRef},
				${input.workflowExecutionId},
				${input.name},
				${input.rootPath},
				${input.backend},
				${sql.json(input.enabledTools)},
				${input.requireReadBeforeWrite},
				${input.commandTimeoutMs},
				${input.status ?? "active"},
				now(),
				now(),
				now()
			)
			on conflict (workspace_ref) do update
			set
				workflow_execution_id = excluded.workflow_execution_id,
				name = excluded.name,
				root_path = excluded.root_path,
				backend = excluded.backend,
				enabled_tools = excluded.enabled_tools,
				require_read_before_write = excluded.require_read_before_write,
				command_timeout_ms = excluded.command_timeout_ms,
				status = excluded.status,
				updated_at = now(),
				last_accessed_at = now()
		`;
	}

	async markDurableInstance(
		workspaceRef: string,
		durableInstanceId: string,
	): Promise<void> {
		const sql = this.ensureSql();
		await sql`
			update workflow_workspace_sessions
			set
				durable_instance_id = ${durableInstanceId},
				updated_at = now(),
				last_accessed_at = now()
			where workspace_ref = ${workspaceRef}
		`;
	}

	async markClonePath(workspaceRef: string, clonePath: string): Promise<void> {
		const sql = this.ensureSql();
		await sql`
			update workflow_workspace_sessions
			set
				clone_path = ${clonePath},
				updated_at = now(),
				last_accessed_at = now()
			where workspace_ref = ${workspaceRef}
		`;
	}

	async markTouched(workspaceRef: string): Promise<void> {
		const sql = this.ensureSql();
		await sql`
			update workflow_workspace_sessions
			set
				last_accessed_at = now(),
				updated_at = now()
			where workspace_ref = ${workspaceRef}
		`;
	}

	async markCleaned(workspaceRef: string, error?: string): Promise<void> {
		const sql = this.ensureSql();
		await sql`
			update workflow_workspace_sessions
			set
				status = ${error ? "error" : "cleaned"},
				last_error = ${error ?? null},
				cleaned_at = now(),
				updated_at = now(),
				last_accessed_at = now()
			where workspace_ref = ${workspaceRef}
		`;
	}

	async getByWorkspaceRef(
		workspaceRef: string,
	): Promise<PersistedWorkspaceSession | null> {
		const sql = this.ensureSql();
		const [row] = await sql<WorkspaceSessionRow[]>`
			select
				workspace_ref,
				workflow_execution_id,
				durable_instance_id,
				name,
				root_path,
				clone_path,
				backend,
				enabled_tools,
				require_read_before_write,
				command_timeout_ms,
				status,
				last_error
			from workflow_workspace_sessions
			where workspace_ref = ${workspaceRef} and status = 'active'
			limit 1
		`;
		return row ? toPersisted(row) : null;
	}

	async getByExecutionId(
		workflowExecutionId: string,
	): Promise<PersistedWorkspaceSession | null> {
		const sql = this.ensureSql();
		const [row] = await sql<WorkspaceSessionRow[]>`
			select
				workspace_ref,
				workflow_execution_id,
				durable_instance_id,
				name,
				root_path,
				clone_path,
				backend,
				enabled_tools,
				require_read_before_write,
				command_timeout_ms,
				status,
				last_error
			from workflow_workspace_sessions
			where workflow_execution_id = ${workflowExecutionId} and status = 'active'
			order by updated_at desc
			limit 1
		`;
		return row ? toPersisted(row) : null;
	}

	async getByDurableInstanceId(
		durableInstanceId: string,
	): Promise<PersistedWorkspaceSession | null> {
		const sql = this.ensureSql();
		const [row] = await sql<WorkspaceSessionRow[]>`
			select
				workspace_ref,
				workflow_execution_id,
				durable_instance_id,
				name,
				root_path,
				clone_path,
				backend,
				enabled_tools,
				require_read_before_write,
				command_timeout_ms,
				status,
				last_error
			from workflow_workspace_sessions
			where durable_instance_id = ${durableInstanceId} and status = 'active'
			limit 1
		`;
		return row ? toPersisted(row) : null;
	}
}

export const workspaceSessionStore = new WorkspaceSessionStore();
