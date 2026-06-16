import {
	relations,
	sql,
	type InferInsertModel,
	type InferSelectModel,
} from "drizzle-orm";
import {
	boolean,
	customType,
	doublePrecision,
	foreignKey,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	real,
	serial,
	text,
	timestamp,
	unique,
	uniqueIndex,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
	dataType() {
		return "bytea";
	},
});
import type { EncryptedObject } from "$lib/server/security/encryption";
import {
	AppConnectionScope,
	AppConnectionStatus,
	type AppConnectionType,
} from "$lib/server/types/app-connection";
import { generateId } from "$lib/server/utils/id";

// ============================================================================
// Platform & Auth Tables (AP-compatible)
// ============================================================================

export type PlatformRole = "ADMIN" | "MEMBER";
export type UserStatus = "ACTIVE" | "INACTIVE";
export type IdentityProvider = "EMAIL" | "GITHUB" | "GOOGLE";
export type ProjectRole = "ADMIN" | "EDITOR" | "OPERATOR" | "VIEWER";

export const platforms = pgTable("platforms", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => generateId()),
	name: text("name").notNull(),
	ownerId: text("owner_id"), // Set after first user is created
	createdAt: timestamp("created_at").notNull().defaultNow(),
	updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const signingKeys = pgTable("signing_keys", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => generateId()),
	platformId: text("platform_id")
		.notNull()
		.references(() => platforms.id),
	publicKey: text("public_key").notNull(), // PEM-encoded RSA public key
	algorithm: text("algorithm").notNull().default("RS256"),
	displayName: text("display_name"),
	createdAt: timestamp("created_at").notNull().defaultNow(),
	updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Users table (extended from Better Auth)
export const users = pgTable("users", {
	id: text("id").primaryKey(),
	name: text("name"),
	email: text("email").unique(),
	emailVerified: boolean("email_verified").notNull().default(false),
	image: text("image"),
	createdAt: timestamp("created_at").notNull(),
	updatedAt: timestamp("updated_at").notNull(),
	// Platform association
	platformId: text("platform_id").references(() => platforms.id),
	platformRole: text("platform_role").default("MEMBER").$type<PlatformRole>(),
	status: text("status").default("ACTIVE").$type<UserStatus>(),
});

export const userIdentities = pgTable("user_identities", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => generateId()),
	userId: text("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	email: text("email").notNull(),
	password: text("password"), // bcrypt hash, nullable for social-only
	provider: text("provider").notNull().$type<IdentityProvider>(),
	firstName: text("first_name"),
	lastName: text("last_name"),
	tokenVersion: integer("token_version").notNull().default(0),
	verified: boolean("verified").notNull().default(true),
	createdAt: timestamp("created_at").notNull().defaultNow(),
	updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const projects = pgTable("projects", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => generateId()),
	platformId: text("platform_id")
		.notNull()
		.references(() => platforms.id),
	ownerId: text("owner_id")
		.notNull()
		.references(() => users.id),
	displayName: text("display_name").notNull(),
	externalId: text("external_id").notNull().unique(), // AP-compatible external identifier
	createdAt: timestamp("created_at").notNull().defaultNow(),
	updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const projectMembers = pgTable(
	"project_members",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		role: text("role").notNull().default("ADMIN").$type<ProjectRole>(),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		projectUserUnique: unique("uq_project_members_project_user").on(
			table.projectId,
			table.userId,
		),
	}),
);

// Legacy tables (sessions, accounts, verifications) removed — replaced by JWT auth + userIdentities

// Workflow visibility type
export type WorkflowVisibility = "private" | "public";

// Workflows table with user association
export const workflows = pgTable("workflows", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => generateId()),
	name: text("name").notNull(),
	description: text("description"),
	userId: text("user_id")
		.notNull()
		.references(() => users.id),
	// Project scoping (MCP and multi-user parity with Activepieces).
	// Enforced NOT NULL in migration 0040 after backfill; POST /api/workflows
	// stamps this from locals.session.projectId on every insert.
	projectId: text("project_id")
		.notNull()
		.references(() => projects.id, {
			onDelete: "cascade",
		}),
	// biome-ignore lint/suspicious/noExplicitAny: JSONB type - structure validated at application level
	nodes: jsonb("nodes").notNull().$type<any[]>(),
	// biome-ignore lint/suspicious/noExplicitAny: JSONB type - structure validated at application level
	edges: jsonb("edges").notNull().$type<any[]>(),
	specVersion: text("spec_version"),
	// biome-ignore lint/suspicious/noExplicitAny: JSONB type - authoring spec
	spec: jsonb("spec").$type<any>(),
	visibility: text("visibility")
		.notNull()
		.default("private")
		.$type<WorkflowVisibility>(),
	// Dapr workflow fields
	engineType: text("engine_type").default("dapr").$type<"vercel" | "dapr">(),
	daprWorkflowName: text("dapr_workflow_name"), // Registered Dapr workflow name
	daprOrchestratorUrl: text("dapr_orchestrator_url"), // URL of the Dapr orchestrator service
	mlflowExperimentId: text("mlflow_experiment_id"),
	mlflowExperimentName: text("mlflow_experiment_name"),
	createdAt: timestamp("created_at").notNull().defaultNow(),
	updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ============================================================================
// MCP (Hosted Server) - Activepieces Parity
// ============================================================================

export type McpServerStatus = "ENABLED" | "DISABLED";

export const mcpServers = pgTable(
	"mcp_server",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		status: text("status")
			.notNull()
			.default("DISABLED")
			.$type<McpServerStatus>(),
		// Encrypted at rest using AP-compatible AES-256-CBC via AP_ENCRYPTION_KEY.
		tokenEncrypted: jsonb("token_encrypted").notNull().$type<EncryptedObject>(),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		projectUnique: unique("uq_mcp_server_project_id").on(table.projectId),
		projectIdx: index("idx_mcp_server_project_id").on(table.projectId),
	}),
);

export type McpRunStatus = "STARTED" | "RESPONDED" | "TIMED_OUT" | "FAILED";

export const mcpRuns = pgTable(
	"mcp_run",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		mcpServerId: text("mcp_server_id")
			.notNull()
			.references(() => mcpServers.id, { onDelete: "cascade" }),
		workflowId: text("workflow_id")
			.notNull()
			.references(() => workflows.id, { onDelete: "cascade" }),
		workflowExecutionId: text("workflow_execution_id").references(
			() => workflowExecutions.id,
			{ onDelete: "set null" },
		),
		daprInstanceId: text("dapr_instance_id"),
		toolName: text("tool_name").notNull(),
		// biome-ignore lint/suspicious/noExplicitAny: JSONB type - MCP tool args
		input: jsonb("input").notNull().$type<Record<string, any>>(),
		// biome-ignore lint/suspicious/noExplicitAny: JSONB type - Reply payload
		response: jsonb("response").$type<any>(),
		status: text("status").notNull().$type<McpRunStatus>(),
		respondedAt: timestamp("responded_at"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		projectIdx: index("idx_mcp_run_project_id").on(table.projectId),
		mcpServerIdx: index("idx_mcp_run_mcp_server_id").on(table.mcpServerId),
		workflowIdx: index("idx_mcp_run_workflow_id").on(table.workflowId),
		workflowExecutionIdx: index("idx_mcp_run_workflow_execution_id").on(
			table.workflowExecutionId,
		),
	}),
);

export type McpConnectionSourceType =
	| "nimble_piece"
	| "nimble_shared"
	| "custom_url"
	| "hosted_workflow";
export type McpConnectionStatus = "ENABLED" | "DISABLED" | "ERROR";

export const mcpConnections = pgTable(
	"mcp_connection",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		sourceType: text("source_type").notNull().$type<McpConnectionSourceType>(),
		pieceName: text("piece_name"),
		serverKey: text("server_key"),
		connectionExternalId: text("connection_external_id"),
		displayName: text("display_name").notNull(),
		registryRef: text("registry_ref"),
		serverUrl: text("server_url"),
		status: text("status")
			.notNull()
			.default("DISABLED")
			.$type<McpConnectionStatus>(),
		lastSyncAt: timestamp("last_sync_at"),
		lastError: text("last_error"),
		metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
		createdBy: text("created_by").references(() => users.id, {
			onDelete: "set null",
		}),
		updatedBy: text("updated_by").references(() => users.id, {
			onDelete: "set null",
		}),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		projectIdx: index("idx_mcp_connection_project_id").on(table.projectId),
		projectStatusIdx: index("idx_mcp_connection_project_status").on(
			table.projectId,
			table.status,
		),
		projectSourcePieceUnique: unique(
			"uq_mcp_connection_project_source_piece",
		).on(table.projectId, table.sourceType, table.pieceName),
		projectSourceServerKeyUnique: unique(
			"uq_mcp_connection_project_source_server_key",
		).on(table.projectId, table.sourceType, table.serverKey),
	}),
);

// Piece metadata cache imported from Activepieces
export const pieceMetadata = pgTable(
	"piece_metadata",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		name: text("name").notNull(),
		authors: text("authors").array().notNull().default([]),
		displayName: text("display_name").notNull(),
		logoUrl: text("logo_url").notNull(),
		description: text("description"),
		platformId: text("platform_id"),
		version: text("version").notNull(),
		minimumSupportedRelease: text("minimum_supported_release").notNull(),
		maximumSupportedRelease: text("maximum_supported_release").notNull(),
		auth: jsonb("auth"),
		actions: jsonb("actions").notNull(),
		triggers: jsonb("triggers").notNull(),
		pieceType: text("piece_type").notNull(),
		categories: text("categories").array().notNull().default([]),
		packageType: text("package_type").notNull(),
		i18n: jsonb("i18n"),
		catalogSchemaVersion: integer("catalog_schema_version"),
		catalogDigest: text("catalog_digest"),
		catalogSourceImage: text("catalog_source_image"),
		catalogSyncedAt: timestamp("catalog_synced_at"),
		// Phase 2 (docs/activepieces-catalog-expansion.md): a row is metadata-only
		// (the piece is in the AP catalog but NOT bundled in piece-mcp-server) — it
		// shows as an "Available — request enablement" option but is NEVER provisioned
		// (no code → would CrashLoop). Bundle-synced rows are always false; the
		// reconciler name-excludes available_only=true pieces. enabled-and-runnable ⊆ bundled.
		availableOnly: boolean("available_only").notNull().default(false),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		nameVersionPlatformIdx: uniqueIndex(
			"idx_piece_metadata_name_platform_id_version",
		).on(table.name, table.version, table.platformId),
		catalogDigestIdx: index("idx_piece_metadata_catalog_digest").on(
			table.catalogDigest,
		),
	}),
);

// Activepieces-style user app connections
export const appConnections = pgTable(
	"app_connection",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		displayName: text("display_name").notNull(),
		externalId: text("external_id").notNull(),
		type: text("type").notNull().$type<AppConnectionType>(),
		status: text("status")
			.notNull()
			.default(AppConnectionStatus.ACTIVE)
			.$type<AppConnectionStatus>(),
		platformId: text("platform_id"),
		pieceName: text("piece_name").notNull(),
		ownerId: text("owner_id").references(() => users.id, {
			onDelete: "set null",
		}),
		projectIds: jsonb("project_ids").notNull().$type<string[]>().default([]),
		scope: text("scope")
			.notNull()
			.default(AppConnectionScope.PROJECT)
			.$type<AppConnectionScope>(),
		value: jsonb("value").notNull().$type<{ iv: string; data: string }>(),
		metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
		pieceVersion: text("piece_version").notNull(),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		platformExternalIdIdx: index(
			"idx_app_connection_platform_id_and_external_id",
		).on(table.platformId, table.externalId),
		ownerIdIdx: index("idx_app_connection_owner_id").on(table.ownerId),
	}),
);

// Denormalized workflow to connection references for quick checks and status
export const workflowConnectionRefs = pgTable(
	"workflow_connection_ref",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		workflowId: text("workflow_id")
			.notNull()
			.references(() => workflows.id, { onDelete: "cascade" }),
		nodeId: text("node_id").notNull(),
		connectionExternalId: text("connection_external_id").notNull(),
		pieceName: text("piece_name").notNull(),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		workflowNodeIdx: index("idx_workflow_connection_ref_workflow_node").on(
			table.workflowId,
			table.nodeId,
		),
		workflowExternalIdIdx: index(
			"idx_workflow_connection_ref_workflow_external_id",
		).on(table.workflowId, table.connectionExternalId),
	}),
);

/**
 * Idempotency gate + audit trail + result-offload store for deterministic
 * Activepieces piece executions (piece-runtime /execute; migration 0080).
 *
 * The orchestrator mints `idempotency_key = workflowId:dbExecutionId:taskName`
 * — stable across activity retries AND workflow replay — so retried
 * side-effecting actions (send-email, create-issue) dedupe to exactly one
 * effect. The row also stores the FULL result jsonb; results over the inline
 * ceiling are returned as `{ artifactRef: { kind: "piece_execution" }, … }`
 * and read back via GET /api/internal/piece-executions/[idempotencyKey].
 * See docs/activepieces-integration-architecture.md §2.4.
 */
export const pieceExecution = pgTable(
	"piece_execution",
	{
		// Deterministic, orchestrator-supplied — no default.
		idempotencyKey: text("idempotency_key").primaryKey(),
		workflowId: text("workflow_id").notNull(),
		executionId: text("execution_id").notNull(),
		dbExecutionId: text("db_execution_id"),
		nodeId: text("node_id").notNull(),
		pieceName: text("piece_name").notNull(),
		actionName: text("action_name").notNull(),
		pieceVersion: text("piece_version"),
		connectionExternalId: text("connection_external_id"),
		// 'paused' is not a cacheable terminal state — a RESUME re-invocation
		// must re-execute, so the gate only short-circuits completed/permanent.
		status: text("status")
			.notNull()
			.$type<"running" | "paused" | "completed" | "failed">(),
		attempt: integer("attempt").notNull().default(1),
		result: jsonb("result"),
		error: text("error"),
		errorClass: text("error_class").$type<"retryable" | "permanent">(),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		workflowIdx: index("idx_piece_execution_workflow").on(table.workflowId),
		dbExecutionIdx: index("idx_piece_execution_db_execution").on(
			table.dbExecutionId,
		),
	}),
);

/**
 * Postgres-backed `ctx.store` for AP piece actions on the deterministic
 * path (piece-runtime store-adapter; migration 0080). Scope values:
 * `<workflow_id>` (StoreScope.PROJECT) or
 * `<workflow_id>:<db_execution_id>` (StoreScope.FLOW — survives a
 * DELAY/WEBHOOK pause + RESUME).
 */
export const pieceStore = pgTable(
	"piece_store",
	{
		scope: text("scope").notNull(),
		key: text("key").notNull(),
		value: jsonb("value"),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		pk: primaryKey({ columns: [table.scope, table.key] }),
	}),
);

// Workflow executions table to track workflow runs
export const workflowExecutions = pgTable(
	"workflow_executions",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		workflowId: text("workflow_id")
			.notNull()
			.references(() => workflows.id),
		userId: text("user_id")
			.notNull()
			.references(() => users.id),
		// CMA alignment: scope executions by workspace/project. Backfilled from
		// workflows.project_id in migration 0035; nullable for pre-CMA rows.
		projectId: text("project_id").references(() => projects.id, {
			onDelete: "set null",
		}),
		status: text("status")
			.notNull()
			.$type<"pending" | "running" | "success" | "error" | "cancelled">(),
		// biome-ignore lint/suspicious/noExplicitAny: JSONB type - structure validated at application level
		input: jsonb("input").$type<Record<string, any>>(),
		// biome-ignore lint/suspicious/noExplicitAny: JSONB type - structure validated at application level
		output: jsonb("output").$type<any>(),
		executionIrVersion: text("execution_ir_version"),
		// biome-ignore lint/suspicious/noExplicitAny: JSONB type - immutable execution contract snapshot
		executionIr: jsonb("execution_ir").$type<any>(),
		error: text("error"),
		// Dapr execution fields
		daprInstanceId: text("dapr_instance_id"), // Dapr workflow instance ID for correlation
		phase: text("phase"), // Current phase from Dapr custom status
		progress: integer("progress"), // 0-100 progress percentage
		currentNodeId: text("current_node_id"),
		currentNodeName: text("current_node_name"),
		primaryTraceId: text("primary_trace_id"),
		workflowSessionId: text("workflow_session_id"),
		mlflowExperimentId: text("mlflow_experiment_id"),
		mlflowRunId: text("mlflow_run_id"),
		summaryOutput: jsonb("summary_output").$type<Record<string, unknown> | null>(),
		errorStackTrace: text("error_stack_trace"),
		rerunOfExecutionId: text("rerun_of_execution_id"),
		rerunSourceInstanceId: text("rerun_source_instance_id"),
		rerunFromEventId: integer("rerun_from_event_id"),
		startedAt: timestamp("started_at").notNull().defaultNow(),
		completedAt: timestamp("completed_at"),
		duration: text("duration"), // Duration in milliseconds
		// Lifecycle stop-intent: set by stopDurableRun the moment a stop is
		// requested. Decouples "termination requested" from "confirmed terminal" —
		// the row stays non-terminal until the cascade or the terminal-status
		// reaper confirms the durable tree is closed, then finalizeDb flips status.
		stopRequestedAt: timestamp("stop_requested_at"),
		stopReason: text("stop_reason"),
	},
	(table) => ({
		workflowStartedIdx: index("idx_workflow_executions_workflow_started").on(
			table.workflowId,
			table.startedAt,
		),
		statusStartedIdx: index("idx_workflow_executions_status_started").on(
			table.status,
			table.startedAt,
		),
		daprInstanceIdx: index("idx_workflow_executions_dapr_instance").on(
			table.daprInstanceId,
		),
		sessionIdx: index("idx_workflow_executions_session").on(
			table.workflowSessionId,
		),
		mlflowRunIdx: index("idx_workflow_executions_mlflow_run").on(
			table.mlflowRunId,
		),
		projectIdx: index("idx_workflow_executions_project_id").on(
			table.projectId,
		),
		rerunOfExecutionFk: foreignKey({
			columns: [table.rerunOfExecutionId],
			foreignColumns: [table.id],
			name: "workflow_executions_rerun_of_execution_id_workflow_executions_id_fk",
		}).onDelete("set null"),
	}),
);

export type WorkflowPlanArtifactStatus =
	| "draft"
	| "approved"
	| "superseded"
	| "executed"
	| "failed";

export type WorkflowPlanArtifactType = "claude_task_graph_v1";

/**
 * Durable plan artifacts produced during workflow execution.
 * Artifacts are decoupled from execution so they can be reused by multiple agents.
 */
export const workflowPlanArtifacts = pgTable(
	"workflow_plan_artifacts",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		workflowExecutionId: text("workflow_execution_id")
			.notNull()
			.references(() => workflowExecutions.id, { onDelete: "cascade" }),
		workflowId: text("workflow_id")
			.notNull()
			.references(() => workflows.id, { onDelete: "cascade" }),
		userId: text("user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		nodeId: text("node_id").notNull(),
		workspaceRef: text("workspace_ref"),
		clonePath: text("clone_path"),
		artifactType: text("artifact_type")
			.notNull()
			.default("claude_task_graph_v1")
			.$type<WorkflowPlanArtifactType>(),
		artifactVersion: integer("artifact_version").notNull().default(1),
		status: text("status")
			.notNull()
			.default("draft")
			.$type<WorkflowPlanArtifactStatus>(),
		goal: text("goal").notNull(),
		// biome-ignore lint/suspicious/noExplicitAny: Structured plan JSON schema versioned at runtime
		planJson: jsonb("plan_json").notNull().$type<any>(),
		planMarkdown: text("plan_markdown"),
		sourcePrompt: text("source_prompt"),
		metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		executionCreatedIdx: index(
			"idx_workflow_plan_artifacts_execution_created",
		).on(table.workflowExecutionId, table.createdAt),
		workflowNodeCreatedIdx: index(
			"idx_workflow_plan_artifacts_workflow_node_created",
		).on(table.workflowId, table.nodeId, table.createdAt),
		statusIdx: index("idx_workflow_plan_artifacts_status").on(table.status),
		userCreatedIdx: index("idx_workflow_plan_artifacts_user_created").on(
			table.userId,
			table.createdAt,
		),
	}),
);

export type WorkflowBrowserArtifactStatus =
	| "pending"
	| "completed"
	| "partial"
	| "failed";
export type WorkflowBrowserArtifactType = "capture_flow_v1";

export const workflowBrowserArtifacts = pgTable(
	"workflow_browser_artifacts",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		workflowExecutionId: text("workflow_execution_id")
			.notNull()
			.references(() => workflowExecutions.id, { onDelete: "cascade" }),
		workflowId: text("workflow_id")
			.notNull()
			.references(() => workflows.id, { onDelete: "cascade" }),
		nodeId: text("node_id").notNull(),
		workspaceRef: text("workspace_ref"),
		artifactType: text("artifact_type")
			.notNull()
			.default("capture_flow_v1")
			.$type<WorkflowBrowserArtifactType>(),
		artifactVersion: integer("artifact_version").notNull().default(1),
		status: text("status")
			.notNull()
			.default("pending")
			.$type<WorkflowBrowserArtifactStatus>(),
		manifestJson: jsonb("manifest_json")
			.notNull()
			.$type<Record<string, unknown>>(),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		executionCreatedIdx: index(
			"idx_workflow_browser_artifacts_execution_created",
		).on(table.workflowExecutionId, table.createdAt),
		workflowNodeCreatedIdx: index(
			"idx_workflow_browser_artifacts_workflow_node_created",
		).on(table.workflowId, table.nodeId, table.createdAt),
		statusIdx: index("idx_workflow_browser_artifacts_status").on(table.status),
	}),
);

export const workflowBrowserArtifactBlobPayloads = pgTable(
	"workflow_browser_artifact_blob_payloads",
	{
		storageRef: text("storage_ref").primaryKey(),
		payloadText: text("payload_text").notNull(),
		contentType: text("content_type").notNull(),
		createdAt: timestamp("created_at").notNull().defaultNow(),
	},
);

/**
 * CMA Files API: metadata for uploaded files and agent-written outputs.
 * Bytes live in `filePayloads` so `SELECT *` on the metadata table stays
 * light — TOASTed bytea columns otherwise force the query planner to drag
 * the full blob into memory on every list.
 */
export type FilePurpose = "agent" | "output";

export const files = pgTable(
	"files",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		projectId: text("project_id").references(() => projects.id, {
			onDelete: "cascade",
		}),
		name: text("name").notNull(),
		purpose: text("purpose").notNull().$type<FilePurpose>(),
		scopeId: text("scope_id"),
		contentType: text("content_type"),
		sizeBytes: integer("size_bytes").notNull().default(0),
		storageRef: text("storage_ref").notNull(),
		sha1: text("sha1"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		archivedAt: timestamp("archived_at"),
	},
	(table) => ({
		userIdx: index("idx_files_user").on(table.userId),
		scopeIdx: index("idx_files_scope").on(table.scopeId),
		purposeIdx: index("idx_files_purpose").on(table.purpose),
		createdIdx: index("idx_files_created").on(table.createdAt),
		scopeNameSha1Idx: index("idx_files_scope_name_sha1").on(
			table.scopeId,
			table.name,
			table.sha1,
		),
	}),
);

export const filePayloads = pgTable("file_payloads", {
	storageRef: text("storage_ref").primaryKey(),
	payloadBytes: bytea("payload_bytes").notNull(),
	createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type FileRow = InferSelectModel<typeof files>;

/**
 * Generic per-execution artifacts surface for the run-detail UI.
 *
 * Goal: any workflow node can persist a typed, named output that renders
 * coherently in the UI — without inventing a new table + tab per shape.
 *
 * - **`kind`** is an open-ended discriminator. UI ships renderers for
 *   `markdown` / `json` / `text` / `table` / `image` / `link` / `card`
 *   and falls back to JSON dump for unknown kinds.
 * - **`slot`** controls UI placement. `primary` artifacts surface
 *   front-and-centre on the run-detail Overview tab; everything else
 *   lands in a collapsed Outputs tab.
 * - **`inline_payload`** is the cheap path: structured data ≤256 KB
 *   stored as JSONB, queryable directly. **`fileId`** is the blob path:
 *   for image/video/large markdown, reuse the existing files +
 *   filePayloads infra (25 MB cap, SHA-1 dedup, soft-delete).
 *   Either side may be set; usually exactly one.
 * - **`metadata`** holds free-form provenance: source URL, model id,
 *   token counts, schema reference, etc. Not rendered by default;
 *   surfaced in a "details" disclosure.
 *
 * Producer paths:
 *   - SW 1.0 spec `artifacts:` block on any task — orchestrator's
 *     post-task hook persists each entry via the persist_workflow_artifact
 *     activity (Dapr-durable, idempotent under retry via deterministic id).
 *   - `POST /api/internal/workflows/executions/[id]/artifacts` for any
 *     internal-token-authenticated writer (adapter, sidecar, etc.).
 *
 * Existing browser/plan artifact tables stay as-is — they have working
 * type-specific renderers. This is the long tail.
 */
export const workflowArtifacts = pgTable(
	"workflow_artifacts",
	{
		id: text("id").primaryKey(),
		workflowExecutionId: text("workflow_execution_id")
			.notNull()
			.references(() => workflowExecutions.id, { onDelete: "cascade" }),
		nodeId: text("node_id"),
		slot: text("slot").$type<"primary" | "secondary" | "aux">(),
		kind: text("kind").notNull(),
		title: text("title").notNull(),
		description: text("description"),
		inlinePayload: jsonb("inline_payload"),
		fileId: text("file_id").references(() => files.id, { onDelete: "set null" }),
		contentType: text("content_type"),
		sizeBytes: integer("size_bytes"),
		metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
		createdAt: timestamp("created_at").notNull().defaultNow(),
	},
	(table) => ({
		executionCreatedIdx: index("idx_workflow_artifacts_execution_created").on(
			table.workflowExecutionId,
			table.createdAt,
		),
		executionKindIdx: index("idx_workflow_artifacts_execution_kind").on(
			table.workflowExecutionId,
			table.kind,
		),
		executionSlotIdx: index("idx_workflow_artifacts_execution_slot").on(
			table.workflowExecutionId,
			table.slot,
		),
	}),
);

export type WorkflowArtifactRow = InferSelectModel<typeof workflowArtifacts>;

export type WorkflowWorkspaceSessionStatus = "active" | "cleaned" | "error";

/**
 * Durable workspace session metadata used by durable-agent to recover mappings
 * after pod restarts while Dapr workflows are still running.
 */
export const workflowWorkspaceSessions = pgTable(
	"workflow_workspace_sessions",
	{
		workspaceRef: text("workspace_ref").primaryKey(),
		// UI sessions have no workflow execution — column is nullable.
		workflowExecutionId: text("workflow_execution_id").references(
			() => workflowExecutions.id,
			{ onDelete: "cascade" },
		),
		durableInstanceId: text("durable_instance_id"),
		name: text("name").notNull(),
		rootPath: text("root_path").notNull(),
		clonePath: text("clone_path"),
		backend: text("backend").notNull().$type<"openshell">(),
		enabledTools: jsonb("enabled_tools").notNull().$type<string[]>(),
		requireReadBeforeWrite: boolean("require_read_before_write")
			.notNull()
			.default(false),
		commandTimeoutMs: integer("command_timeout_ms").notNull().default(30000),
		status: text("status")
			.notNull()
			.default("active")
			.$type<WorkflowWorkspaceSessionStatus>(),
		lastError: text("last_error"),
		sandboxState: jsonb("sandbox_state").$type<Record<
			string,
			unknown
		> | null>(),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
		lastAccessedAt: timestamp("last_accessed_at").notNull().defaultNow(),
		cleanedAt: timestamp("cleaned_at"),
	},
	(table) => ({
		executionIdx: index("idx_workflow_workspace_sessions_execution").on(
			table.workflowExecutionId,
		),
		instanceIdx: index("idx_workflow_workspace_sessions_instance").on(
			table.durableInstanceId,
		),
		statusIdx: index("idx_workflow_workspace_sessions_status").on(table.status),
	}),
);

export type WorkflowAgentRunMode = "run" | "plan" | "execute_plan";
export type WorkflowAgentRunStatus =
	| "scheduled"
	| "running"
	| "completed"
	| "failed"
	| "event_published";

/**
 * Durable tracking for child durable-agent runs invoked by workflow orchestrator.
 * Used for completion event replay and restart recovery.
 */
export const workflowAgentRuns = pgTable(
	"workflow_agent_runs",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		workflowExecutionId: text("workflow_execution_id")
			.notNull()
			.references(() => workflowExecutions.id, { onDelete: "cascade" }),
		workflowId: text("workflow_id")
			.notNull()
			.references(() => workflows.id, { onDelete: "cascade" }),
		nodeId: text("node_id").notNull(),
		mode: text("mode").notNull().$type<WorkflowAgentRunMode>(),
		agentWorkflowId: text("agent_workflow_id").notNull(),
		daprInstanceId: text("dapr_instance_id").notNull(),
		parentExecutionId: text("parent_execution_id").notNull(),
		workspaceRef: text("workspace_ref"),
		artifactRef: text("artifact_ref"),
		status: text("status")
			.notNull()
			.default("scheduled")
			.$type<WorkflowAgentRunStatus>(),
		result: jsonb("result").$type<Record<string, unknown> | null>(),
		error: text("error"),
		completedAt: timestamp("completed_at"),
		eventPublishedAt: timestamp("event_published_at"),
		lastReconciledAt: timestamp("last_reconciled_at"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		instanceUnique: unique("uq_workflow_agent_runs_instance").on(
			table.daprInstanceId,
		),
		agentWorkflowUnique: unique("uq_workflow_agent_runs_agent_workflow").on(
			table.agentWorkflowId,
		),
		executionIdx: index("idx_workflow_agent_runs_execution").on(
			table.workflowExecutionId,
			table.createdAt,
		),
		statusIdx: index("idx_workflow_agent_runs_status").on(
			table.status,
			table.eventPublishedAt,
		),
	}),
);

export type WorkflowCodeCheckpointStatus =
	| "created"
	| "no_changes"
	| "skipped"
	| "error";
export type WorkflowCodeCheckpointKind = "tool_mutation";

export const workflowCodeCheckpoints = pgTable(
	"workflow_code_checkpoints",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		workflowExecutionId: text("workflow_execution_id")
			.notNull()
			.references(() => workflowExecutions.id, { onDelete: "cascade" }),
		workflowAgentRunId: text("workflow_agent_run_id").references(
			() => workflowAgentRuns.id,
			{ onDelete: "set null" },
		),
		parentExecutionId: text("parent_execution_id"),
		daprInstanceId: text("dapr_instance_id").notNull(),
		workspaceRef: text("workspace_ref"),
		sandboxName: text("sandbox_name"),
		repoPath: text("repo_path").notNull(),
		nodeId: text("node_id"),
		sourceEventId: text("source_event_id").notNull(),
		seq: integer("seq"),
		toolName: text("tool_name").notNull(),
		checkpointKind: text("checkpoint_kind")
			.notNull()
			.default("tool_mutation")
			.$type<WorkflowCodeCheckpointKind>(),
		beforeSha: text("before_sha"),
		afterSha: text("after_sha"),
		remoteUrl: text("remote_url"),
		remoteRef: text("remote_ref"),
		remoteStatus: text("remote_status"),
		remoteError: text("remote_error"),
		remotePushedAt: timestamp("remote_pushed_at"),
		changedFiles: jsonb("changed_files")
			.notNull()
			.$type<Array<Record<string, unknown>>>(),
		fileCount: integer("file_count").notNull().default(0),
		status: text("status").notNull().$type<WorkflowCodeCheckpointStatus>(),
		error: text("error"),
		metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
		createdAt: timestamp("created_at").notNull().defaultNow(),
	},
	(table) => ({
		eventUnique: unique("uq_workflow_code_checkpoints_event").on(
			table.workflowExecutionId,
			table.daprInstanceId,
			table.sourceEventId,
			table.checkpointKind,
		),
		executionSeqIdx: index("idx_workflow_code_checkpoints_execution_seq").on(
			table.workflowExecutionId,
			table.seq,
		),
		agentRunSeqIdx: index("idx_workflow_code_checkpoints_agent_run_seq").on(
			table.workflowAgentRunId,
			table.seq,
		),
		workspaceCreatedIdx: index(
			"idx_workflow_code_checkpoints_workspace_created",
		).on(table.workspaceRef, table.createdAt),
		afterShaIdx: index("idx_workflow_code_checkpoints_after_sha").on(
			table.afterSha,
		),
		remoteRefIdx: index("idx_workflow_code_checkpoints_remote_ref").on(
			table.remoteRef,
		),
	}),
);

export type WorkflowCodeCheckpoint = InferSelectModel<
	typeof workflowCodeCheckpoints
>;
export type NewWorkflowCodeCheckpoint = InferInsertModel<
	typeof workflowCodeCheckpoints
>;

export type WorkflowAiMessageRole = "user" | "assistant" | "system";

/**
 * Workflow AI chat message history.
 * Persists conversational context used for iterative AI workflow editing.
 */
export const workflowAiMessages = pgTable(
	"workflow_ai_messages",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		workflowId: text("workflow_id")
			.notNull()
			.references(() => workflows.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		role: text("role").notNull().$type<WorkflowAiMessageRole>(),
		content: text("content").notNull(),
		operations: jsonb("operations").$type<Array<
			Record<string, unknown>
		> | null>(),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		workflowCreatedIdx: index("idx_workflow_ai_messages_workflow_created").on(
			table.workflowId,
			table.createdAt,
		),
		userCreatedIdx: index("idx_workflow_ai_messages_user_created").on(
			table.userId,
			table.createdAt,
		),
	}),
);

/**
 * Workflow AI tools chat history.
 * Persists UI message parts for the side-panel tools-based chat.
 */
export const workflowAiToolMessages = pgTable(
	"workflow_ai_tool_messages",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		workflowId: text("workflow_id")
			.notNull()
			.references(() => workflows.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		messageId: text("message_id").notNull(),
		role: text("role").notNull().$type<WorkflowAiMessageRole>(),
		parts: jsonb("parts").notNull().$type<Array<Record<string, unknown>>>(),
		textContent: text("text_content").notNull().default(""),
		mentions: jsonb("mentions").$type<Array<Record<string, unknown>> | null>(),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		workflowUserCreatedIdx: index(
			"idx_workflow_ai_tool_messages_workflow_user_created",
		).on(table.workflowId, table.userId, table.createdAt),
		workflowUserMessageUnique: unique(
			"uq_workflow_ai_tool_messages_workflow_user_message",
		).on(table.workflowId, table.userId, table.messageId),
	}),
);

// Workflow execution logs to track individual node executions
export const workflowExecutionLogs = pgTable(
	"workflow_execution_logs",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		executionId: text("execution_id")
			.notNull()
			.references(() => workflowExecutions.id),
		nodeId: text("node_id").notNull(),
		nodeName: text("node_name").notNull(),
		nodeType: text("node_type").notNull(),
		activityName: text("activity_name"), // Function slug (actionType) like "openai/generate-text"
		status: text("status")
			.notNull()
			.$type<"pending" | "running" | "success" | "error">(),
		// biome-ignore lint/suspicious/noExplicitAny: JSONB type - structure validated at application level
		input: jsonb("input").$type<any>(),
		// biome-ignore lint/suspicious/noExplicitAny: JSONB type - structure validated at application level
		output: jsonb("output").$type<any>(),
		error: text("error"),
		startedAt: timestamp("started_at").notNull().defaultNow(),
		completedAt: timestamp("completed_at"),
		duration: text("duration"), // Duration in milliseconds
		timestamp: timestamp("timestamp").notNull().defaultNow(),
		// Timing breakdown columns (Phase 5 enhancement)
		credentialFetchMs: integer("credential_fetch_ms"),
		routingMs: integer("routing_ms"),
		coldStartMs: integer("cold_start_ms"),
		executionMs: integer("execution_ms"),
		routedTo: text("routed_to"), // Service that handled execution (e.g., "fn-openai")
		wasColdStart: boolean("was_cold_start"),
	},
	(table) => ({
		executionStartedIdx: index("idx_workflow_execution_logs_execution_started").on(
			table.executionId,
			table.startedAt,
		),
		executionNodeIdx: index("idx_workflow_execution_logs_execution_node").on(
			table.executionId,
			table.nodeId,
		),
	}),
);

// ============================================================================
// Credential Access Logs (Compliance/Debugging)
// ============================================================================

/**
 * Credential source types
 */
export type CredentialSource =
	| "dapr_secret"
	| "database"
	| "request_body"
	| "not_found";

/**
 * Credential access audit logs
 * Tracks which credential source was used for each function execution
 */
export const credentialAccessLogs = pgTable("credential_access_logs", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => generateId()),
	executionId: text("execution_id")
		.notNull()
		.references(() => workflowExecutions.id),
	nodeId: text("node_id").notNull(),
	integrationType: text("integration_type").notNull(), // e.g., "openai", "slack"
	credentialKeys: jsonb("credential_keys").notNull().$type<string[]>(), // Keys that were resolved
	source: text("source").notNull().$type<CredentialSource>(),
	fallbackAttempted: boolean("fallback_attempted").default(false),
	fallbackReason: text("fallback_reason"),
	accessedAt: timestamp("accessed_at").notNull().defaultNow(),
});

// ============================================================================
// Runtime Configuration Audit Logs
// ============================================================================

export type RuntimeConfigAuditStatus = "success" | "error";

/**
 * Runtime configuration write audit history
 * Tracks who changed dynamic config values used by durable agents.
 */
export const runtimeConfigAuditLogs = pgTable(
	"runtime_config_audit_logs",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		storeName: text("store_name").notNull(),
		configKey: text("config_key").notNull(),
		value: text("value").notNull(),
		metadata: jsonb("metadata").$type<Record<string, string>>(),
		status: text("status").notNull().$type<RuntimeConfigAuditStatus>(),
		provider: text("provider"),
		// biome-ignore lint/suspicious/noExplicitAny: JSONB payload from writer service
		providerResponse: jsonb("provider_response").$type<any>(),
		error: text("error"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
	},
	(table) => ({
		projectCreatedIdx: index("idx_runtime_cfg_audit_project_created").on(
			table.projectId,
			table.createdAt,
		),
		projectKeyIdx: index("idx_runtime_cfg_audit_project_key").on(
			table.projectId,
			table.configKey,
		),
	}),
);

// ============================================================================
// Workflow External Events (Approval Audit Trail)
// ============================================================================

/**
 * External event types
 */
export type ExternalEventType =
	| "approval_request"
	| "approval_response"
	| "timeout";

/**
 * Workflow external events history
 * Tracks approval gate events for audit trail
 */
export const workflowExternalEvents = pgTable("workflow_external_events", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => generateId()),
	executionId: text("execution_id")
		.notNull()
		.references(() => workflowExecutions.id),
	nodeId: text("node_id").notNull(),
	eventName: text("event_name").notNull(), // e.g., "plan-approval"
	eventType: text("event_type").notNull().$type<ExternalEventType>(),
	requestedAt: timestamp("requested_at"),
	timeoutSeconds: integer("timeout_seconds"),
	expiresAt: timestamp("expires_at"),
	respondedAt: timestamp("responded_at"),
	approved: boolean("approved"),
	reason: text("reason"),
	respondedBy: text("responded_by"), // User ID or identifier who responded
	// biome-ignore lint/suspicious/noExplicitAny: JSONB type - event payload
	payload: jsonb("payload").$type<any>(),
	createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Platform OAuth Apps (admin-managed OAuth credentials per piece)
export const platformOauthApps = pgTable(
	"platform_oauth_apps",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		platformId: text("platform_id")
			.notNull()
			.references(() => platforms.id, { onDelete: "cascade" }),
		pieceName: text("piece_name").notNull(), // e.g. "@activepieces/piece-google-sheets"
		clientId: text("client_id").notNull(),
		clientSecret: jsonb("client_secret")
			.notNull()
			.$type<{ iv: string; data: string }>(), // AES-256-CBC encrypted
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		platformPieceUnique: unique("uq_platform_oauth_apps_platform_piece").on(
			table.platformId,
			table.pieceName,
		),
	}),
);

// Platform-admin piece-enablement gate (Phase 1 of docs/activepieces-catalog-expansion.md).
// BLOCKLIST semantics: a row = a piece DISABLED at the platform level, so the
// activepieces-mcps reconciler's `catalog` branch skips provisioning its
// ap-<piece>-service. An EMPTY table means every bundled piece stays provisioned
// (deploy is a genuine no-op — no seed needed). The reconciler keeps
// pinned/workflow-referenced/mcp-enabled as safety nets, so disabling a piece used
// by a deployed workflow does NOT strand it. `pieceName` is the short catalog slug
// (matches piece_metadata.name, e.g. "microsoft-outlook").
export const platformDisabledPieces = pgTable(
	"platform_disabled_piece",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		platformId: text("platform_id").notNull().default("default-platform"),
		pieceName: text("piece_name").notNull(),
		disabledBy: text("disabled_by"),
		disabledAt: timestamp("disabled_at").notNull().defaultNow(),
	},
	(table) => ({
		platformPieceUnique: unique("uq_platform_disabled_piece_platform_piece").on(
			table.platformId,
			table.pieceName,
		),
	}),
);

// Per-piece runtime images (docs/per-piece-runtime-images.md). A row records that piece
// <piece_name>@<version> has a dedicated ghcr image (ap-piece-<name>) — the reconciler
// provisions that piece's ap-<piece>-service from `image` instead of the shared 48-piece
// bundle, bounding memory to one piece. `status` tracks the build-on-enable lifecycle;
// a `ready` row with disabled_at IS NULL means "use this per-piece image". Pieces with no
// ready row fall back to the bundle during migration.
export const pieceImages = pgTable(
	"piece_images",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		pieceName: text("piece_name").notNull(),
		version: text("version").notNull(),
		image: text("image"),
		digest: text("digest"),
		// building | ready | failed
		status: text("status").notNull().default("building"),
		errorMessage: text("error_message"),
		builtAt: timestamp("built_at"),
		enabledAt: timestamp("enabled_at"),
		disabledAt: timestamp("disabled_at"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		pieceVersionUnique: unique("uq_piece_images_piece_version").on(
			table.pieceName,
			table.version,
		),
		pieceStatusIdx: index("idx_piece_images_piece_status").on(
			table.pieceName,
			table.status,
		),
	}),
);

// API Keys table for webhook authentication
export const apiKeys = pgTable("api_keys", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => generateId()),
	userId: text("user_id")
		.notNull()
		.references(() => users.id),
	name: text("name"), // Optional label for the API key
	keyHash: text("key_hash").notNull(), // Store hashed version of the key
	keyPrefix: text("key_prefix").notNull(), // Store first few chars for display (e.g., "wf_abc...")
	createdAt: timestamp("created_at").notNull().defaultNow(),
	lastUsedAt: timestamp("last_used_at"),
});

// ============================================================================
// Reusable Resource Library
// ============================================================================

export type ModelProviderIconKey = "openai" | "anthropic" | "google" | "meta";

export const modelProviders = pgTable(
	"model_providers",
	{
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		iconKey: text("icon_key").notNull().$type<ModelProviderIconKey>(),
		description: text("description"),
		sortOrder: integer("sort_order").notNull().default(0),
		isEnabled: boolean("is_enabled").notNull().default(true),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		nameUnique: unique("uq_model_providers_name").on(table.name),
		enabledIdx: index("idx_model_providers_enabled").on(table.isEnabled),
		sortIdx: index("idx_model_providers_sort_order").on(table.sortOrder),
	}),
);

export const modelCatalog = pgTable(
	"model_catalog",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		providerId: text("provider_id")
			.notNull()
			.references(() => modelProviders.id, { onDelete: "cascade" }),
		modelKey: text("model_key").notNull(),
		displayName: text("display_name").notNull(),
		description: text("description"),
		sortOrder: integer("sort_order").notNull().default(0),
		isEnabled: boolean("is_enabled").notNull().default(true),
		metadata: jsonb("metadata").$type<Record<string, unknown>>(),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		providerModelUnique: unique("uq_model_catalog_provider_model").on(
			table.providerId,
			table.modelKey,
		),
		enabledIdx: index("idx_model_catalog_enabled").on(table.isEnabled),
		providerSortIdx: index("idx_model_catalog_provider_sort").on(
			table.providerId,
			table.sortOrder,
		),
	}),
);

export type ProfileFacetKind =
	| "instruction"
	| "model"
	| "tool_policy"
	| "memory"
	| "execution"
	| "interaction"
	| "output"
	| "capability";

export type ProfileWarningSeverity = "info" | "warning" | "error";

export type ProfileCompatibilityWarning = {
	code: string;
	severity: ProfileWarningSeverity;
	message: string;
	field?: string;
	suggestedAction?: string;
};

export const agentInstructionFacets = pgTable(
	"agent_instruction_facets",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		slug: text("slug").notNull().unique(),
		name: text("name").notNull(),
		description: text("description"),
		isEnabled: boolean("is_enabled").notNull().default(true),
		sortOrder: integer("sort_order").notNull().default(0),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		enabledIdx: index("idx_agent_instruction_facets_enabled").on(
			table.isEnabled,
		),
		sortIdx: index("idx_agent_instruction_facets_sort").on(table.sortOrder),
	}),
);

export const agentInstructionFacetVersions = pgTable(
	"agent_instruction_facet_versions",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		facetId: text("facet_id")
			.notNull()
			.references(() => agentInstructionFacets.id, { onDelete: "cascade" }),
		version: integer("version").notNull(),
		config: jsonb("config").notNull().$type<Record<string, unknown>>(),
		compatibility:
			jsonb("compatibility").$type<ProfileCompatibilityWarning[]>(),
		isDefault: boolean("is_default").notNull().default(false),
		notes: text("notes"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		facetVersionUnique: unique("uq_agent_instruction_facet_version").on(
			table.facetId,
			table.version,
		),
		facetIdx: index("idx_agent_instruction_facet_versions_facet").on(
			table.facetId,
		),
		defaultIdx: index("idx_agent_instruction_facet_versions_default").on(
			table.isDefault,
		),
	}),
);

export const agentModelFacets = pgTable(
	"agent_model_facets",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		slug: text("slug").notNull().unique(),
		name: text("name").notNull(),
		description: text("description"),
		isEnabled: boolean("is_enabled").notNull().default(true),
		sortOrder: integer("sort_order").notNull().default(0),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		enabledIdx: index("idx_agent_model_facets_enabled").on(table.isEnabled),
		sortIdx: index("idx_agent_model_facets_sort").on(table.sortOrder),
	}),
);

export const agentModelFacetVersions = pgTable(
	"agent_model_facet_versions",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		facetId: text("facet_id")
			.notNull()
			.references(() => agentModelFacets.id, { onDelete: "cascade" }),
		version: integer("version").notNull(),
		config: jsonb("config").notNull().$type<Record<string, unknown>>(),
		compatibility:
			jsonb("compatibility").$type<ProfileCompatibilityWarning[]>(),
		isDefault: boolean("is_default").notNull().default(false),
		notes: text("notes"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		facetVersionUnique: unique("uq_agent_model_facet_version").on(
			table.facetId,
			table.version,
		),
		facetIdx: index("idx_agent_model_facet_versions_facet").on(table.facetId),
		defaultIdx: index("idx_agent_model_facet_versions_default").on(
			table.isDefault,
		),
	}),
);

export const agentToolPolicyFacets = pgTable(
	"agent_tool_policy_facets",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		slug: text("slug").notNull().unique(),
		name: text("name").notNull(),
		description: text("description"),
		isEnabled: boolean("is_enabled").notNull().default(true),
		sortOrder: integer("sort_order").notNull().default(0),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		enabledIdx: index("idx_agent_tool_policy_facets_enabled").on(
			table.isEnabled,
		),
		sortIdx: index("idx_agent_tool_policy_facets_sort").on(table.sortOrder),
	}),
);

export const agentToolPolicyFacetVersions = pgTable(
	"agent_tool_policy_facet_versions",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		facetId: text("facet_id")
			.notNull()
			.references(() => agentToolPolicyFacets.id, { onDelete: "cascade" }),
		version: integer("version").notNull(),
		config: jsonb("config").notNull().$type<Record<string, unknown>>(),
		compatibility:
			jsonb("compatibility").$type<ProfileCompatibilityWarning[]>(),
		isDefault: boolean("is_default").notNull().default(false),
		notes: text("notes"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		facetVersionUnique: unique("uq_agent_tool_policy_facet_version").on(
			table.facetId,
			table.version,
		),
		facetIdx: index("idx_agent_tool_policy_facet_versions_facet").on(
			table.facetId,
		),
		defaultIdx: index("idx_agent_tool_policy_facet_versions_default").on(
			table.isDefault,
		),
	}),
);

export const agentMemoryFacets = pgTable(
	"agent_memory_facets",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		slug: text("slug").notNull().unique(),
		name: text("name").notNull(),
		description: text("description"),
		isEnabled: boolean("is_enabled").notNull().default(true),
		sortOrder: integer("sort_order").notNull().default(0),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		enabledIdx: index("idx_agent_memory_facets_enabled").on(table.isEnabled),
		sortIdx: index("idx_agent_memory_facets_sort").on(table.sortOrder),
	}),
);

export const agentMemoryFacetVersions = pgTable(
	"agent_memory_facet_versions",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		facetId: text("facet_id")
			.notNull()
			.references(() => agentMemoryFacets.id, { onDelete: "cascade" }),
		version: integer("version").notNull(),
		config: jsonb("config").notNull().$type<Record<string, unknown>>(),
		compatibility:
			jsonb("compatibility").$type<ProfileCompatibilityWarning[]>(),
		isDefault: boolean("is_default").notNull().default(false),
		notes: text("notes"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		facetVersionUnique: unique("uq_agent_memory_facet_version").on(
			table.facetId,
			table.version,
		),
		facetIdx: index("idx_agent_memory_facet_versions_facet").on(table.facetId),
		defaultIdx: index("idx_agent_memory_facet_versions_default").on(
			table.isDefault,
		),
	}),
);

export const agentExecutionFacets = pgTable(
	"agent_execution_facets",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		slug: text("slug").notNull().unique(),
		name: text("name").notNull(),
		description: text("description"),
		isEnabled: boolean("is_enabled").notNull().default(true),
		sortOrder: integer("sort_order").notNull().default(0),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		enabledIdx: index("idx_agent_execution_facets_enabled").on(table.isEnabled),
		sortIdx: index("idx_agent_execution_facets_sort").on(table.sortOrder),
	}),
);

export const agentExecutionFacetVersions = pgTable(
	"agent_execution_facet_versions",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		facetId: text("facet_id")
			.notNull()
			.references(() => agentExecutionFacets.id, { onDelete: "cascade" }),
		version: integer("version").notNull(),
		config: jsonb("config").notNull().$type<Record<string, unknown>>(),
		compatibility:
			jsonb("compatibility").$type<ProfileCompatibilityWarning[]>(),
		isDefault: boolean("is_default").notNull().default(false),
		notes: text("notes"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		facetVersionUnique: unique("uq_agent_execution_facet_version").on(
			table.facetId,
			table.version,
		),
		facetIdx: index("idx_agent_execution_facet_versions_facet").on(
			table.facetId,
		),
		defaultIdx: index("idx_agent_execution_facet_versions_default").on(
			table.isDefault,
		),
	}),
);

export const agentInteractionFacets = pgTable(
	"agent_interaction_facets",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		slug: text("slug").notNull().unique(),
		name: text("name").notNull(),
		description: text("description"),
		isEnabled: boolean("is_enabled").notNull().default(true),
		sortOrder: integer("sort_order").notNull().default(0),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		enabledIdx: index("idx_agent_interaction_facets_enabled").on(
			table.isEnabled,
		),
		sortIdx: index("idx_agent_interaction_facets_sort").on(table.sortOrder),
	}),
);

export const agentInteractionFacetVersions = pgTable(
	"agent_interaction_facet_versions",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		facetId: text("facet_id")
			.notNull()
			.references(() => agentInteractionFacets.id, { onDelete: "cascade" }),
		version: integer("version").notNull(),
		config: jsonb("config").notNull().$type<Record<string, unknown>>(),
		compatibility:
			jsonb("compatibility").$type<ProfileCompatibilityWarning[]>(),
		isDefault: boolean("is_default").notNull().default(false),
		notes: text("notes"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		facetVersionUnique: unique("uq_agent_interaction_facet_version").on(
			table.facetId,
			table.version,
		),
		facetIdx: index("idx_agent_interaction_facet_versions_facet").on(
			table.facetId,
		),
		defaultIdx: index("idx_agent_interaction_facet_versions_default").on(
			table.isDefault,
		),
	}),
);

export const agentOutputFacets = pgTable(
	"agent_output_facets",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		slug: text("slug").notNull().unique(),
		name: text("name").notNull(),
		description: text("description"),
		isEnabled: boolean("is_enabled").notNull().default(true),
		sortOrder: integer("sort_order").notNull().default(0),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		enabledIdx: index("idx_agent_output_facets_enabled").on(table.isEnabled),
		sortIdx: index("idx_agent_output_facets_sort").on(table.sortOrder),
	}),
);

export const agentOutputFacetVersions = pgTable(
	"agent_output_facet_versions",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		facetId: text("facet_id")
			.notNull()
			.references(() => agentOutputFacets.id, { onDelete: "cascade" }),
		version: integer("version").notNull(),
		config: jsonb("config").notNull().$type<Record<string, unknown>>(),
		compatibility:
			jsonb("compatibility").$type<ProfileCompatibilityWarning[]>(),
		isDefault: boolean("is_default").notNull().default(false),
		notes: text("notes"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		facetVersionUnique: unique("uq_agent_output_facet_version").on(
			table.facetId,
			table.version,
		),
		facetIdx: index("idx_agent_output_facet_versions_facet").on(table.facetId),
		defaultIdx: index("idx_agent_output_facet_versions_default").on(
			table.isDefault,
		),
	}),
);

export const agentCapabilityFacets = pgTable(
	"agent_capability_facets",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		slug: text("slug").notNull().unique(),
		name: text("name").notNull(),
		description: text("description"),
		isEnabled: boolean("is_enabled").notNull().default(true),
		sortOrder: integer("sort_order").notNull().default(0),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		enabledIdx: index("idx_agent_capability_facets_enabled").on(
			table.isEnabled,
		),
		sortIdx: index("idx_agent_capability_facets_sort").on(table.sortOrder),
	}),
);

export const agentCapabilityFacetVersions = pgTable(
	"agent_capability_facet_versions",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		facetId: text("facet_id")
			.notNull()
			.references(() => agentCapabilityFacets.id, { onDelete: "cascade" }),
		version: integer("version").notNull(),
		config: jsonb("config").notNull().$type<Record<string, unknown>>(),
		compatibility:
			jsonb("compatibility").$type<ProfileCompatibilityWarning[]>(),
		isDefault: boolean("is_default").notNull().default(false),
		notes: text("notes"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		facetVersionUnique: unique("uq_agent_capability_facet_version").on(
			table.facetId,
			table.version,
		),
		facetIdx: index("idx_agent_capability_facet_versions_facet").on(
			table.facetId,
		),
		defaultIdx: index("idx_agent_capability_facet_versions_default").on(
			table.isDefault,
		),
	}),
);

export const agentProfileTemplates = pgTable(
	"agent_profile_templates",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		slug: text("slug").notNull().unique(),
		name: text("name").notNull(),
		description: text("description"),
		category: text("category"),
		sourceRepoUrl: text("source_repo_url"),
		sourcePath: text("source_path"),
		isEnabled: boolean("is_enabled").notNull().default(true),
		sortOrder: integer("sort_order").notNull().default(0),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		enabledIdx: index("idx_agent_profile_templates_enabled").on(
			table.isEnabled,
		),
		sortIdx: index("idx_agent_profile_templates_sort").on(table.sortOrder),
	}),
);

export const agentProfileTemplateVersions = pgTable(
	"agent_profile_template_versions",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		templateId: text("template_id")
			.notNull()
			.references(() => agentProfileTemplates.id, { onDelete: "cascade" }),
		version: integer("version").notNull(),
		instructionFacetVersionId: text("instruction_facet_version_id").references(
			() => agentInstructionFacetVersions.id,
		),
		modelFacetVersionId: text("model_facet_version_id").references(
			() => agentModelFacetVersions.id,
		),
		toolPolicyFacetVersionId: text("tool_policy_facet_version_id").references(
			() => agentToolPolicyFacetVersions.id,
		),
		memoryFacetVersionId: text("memory_facet_version_id").references(
			() => agentMemoryFacetVersions.id,
		),
		executionFacetVersionId: text("execution_facet_version_id").references(
			() => agentExecutionFacetVersions.id,
		),
		interactionFacetVersionId: text("interaction_facet_version_id").references(
			() => agentInteractionFacetVersions.id,
		),
		outputFacetVersionId: text("output_facet_version_id").references(
			() => agentOutputFacetVersions.id,
		),
		capabilityFacetVersionId: text("capability_facet_version_id").references(
			() => agentCapabilityFacetVersions.id,
		),
		compatibility:
			jsonb("compatibility").$type<ProfileCompatibilityWarning[]>(),
		notes: text("notes"),
		isDefault: boolean("is_default").notNull().default(false),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		templateVersionUnique: unique("uq_agent_profile_template_version").on(
			table.templateId,
			table.version,
		),
		templateIdx: index("idx_agent_profile_template_versions_template").on(
			table.templateId,
		),
		defaultIdx: index("idx_agent_profile_template_versions_default").on(
			table.isDefault,
		),
	}),
);

export const agentProfileTemplateExamples = pgTable(
	"agent_profile_template_examples",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		templateId: text("template_id")
			.notNull()
			.references(() => agentProfileTemplates.id, { onDelete: "cascade" }),
		label: text("label").notNull(),
		sourceRepoUrl: text("source_repo_url").notNull(),
		sourcePath: text("source_path").notNull(),
		notes: text("notes"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
);

export type AgentSkillRegistryStatus = "ENABLED" | "DISABLED" | "DRAFT";
export type AgentSkillRegistrySourceType =
	| "registry"
	| "profile"
	| "custom";

export const agentSkillRegistry = pgTable(
	"agent_skill_registry",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		slug: text("slug").notNull().unique(),
		name: text("name").notNull(),
		description: text("description"),
		whenToUse: text("when_to_use"),
		prompt: text("prompt").notNull(),
		allowedTools: jsonb("allowed_tools").$type<string[]>(),
		arguments: jsonb("arguments").$type<string[]>(),
		argumentHint: text("argument_hint"),
		model: text("model"),
		userInvocable: boolean("user_invocable").notNull().default(true),
		disableModelInvocation: boolean("disable_model_invocation").notNull().default(false),
		sourceType: text("source_type")
			.notNull()
			.default("curated")
			.$type<AgentSkillRegistrySourceType>(),
		sourceRepo: text("source_repo"),
		sourceRef: text("source_ref"),
		skillPath: text("skill_path"),
		registryUrl: text("registry_url"),
		installSource: text("install_source"),
		skillName: text("skill_name"),
		installAgent: text("install_agent").notNull().default("universal"),
		version: text("version").notNull().default("1"),
		contentHash: text("content_hash").notNull(),
		license: text("license"),
		compatibility: jsonb("compatibility").$type<Record<string, unknown>>(),
		packageManifest: jsonb("package_manifest").$type<Record<string, unknown>>(),
		status: text("status")
			.notNull()
			.default("ENABLED")
			.$type<AgentSkillRegistryStatus>(),
		createdByUserId: text("created_by_user_id").references(() => users.id),
		projectId: text("project_id").references(() => projects.id, {
			onDelete: "cascade",
		}),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		statusIdx: index("idx_agent_skill_registry_status").on(table.status),
		sourceIdx: index("idx_agent_skill_registry_source").on(
			table.sourceRepo,
			table.skillPath,
		),
		projectIdx: index("idx_agent_skill_registry_project").on(table.projectId),
	}),
);

export type PromptMode = "system" | "system+user";
export type PromptTemplateFormat = "mustache";
export type ResourcePromptMessage = {
	role: "system" | "user" | "assistant";
	content: string;
};
export type ResourcePromptArgument = {
	name: string;
	description?: string;
	required?: boolean;
};

export const resourcePrompts = pgTable(
	"resource_prompts",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		name: text("name").notNull(),
		description: text("description"),
		systemPrompt: text("system_prompt").notNull(),
		userPrompt: text("user_prompt"),
		promptMode: text("prompt_mode")
			.notNull()
			.default("system")
			.$type<PromptMode>(),
		metadata: jsonb("metadata").$type<Record<string, unknown>>(),
		version: integer("version").notNull().default(1),
		isEnabled: boolean("is_enabled").notNull().default(true),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		projectId: text("project_id").references(() => projects.id, {
			onDelete: "cascade",
		}),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		userProjectIdx: index("idx_resource_prompts_user_project").on(
			table.userId,
			table.projectId,
		),
		enabledIdx: index("idx_resource_prompts_enabled").on(table.isEnabled),
		userProjectNameUnique: unique("uq_resource_prompts_user_project_name").on(
			table.userId,
			table.projectId,
			table.name,
		),
	}),
);

export const resourcePromptVersions = pgTable(
	"resource_prompt_versions",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		promptId: text("prompt_id")
			.notNull()
			.references(() => resourcePrompts.id, { onDelete: "cascade" }),
		version: integer("version").notNull(),
		messages: jsonb("messages").notNull().$type<ResourcePromptMessage[]>(),
		templateArguments: jsonb("arguments")
			.notNull()
			.default([])
			.$type<ResourcePromptArgument[]>(),
		templateFormat: text("template_format")
			.notNull()
			.default("mustache")
			.$type<PromptTemplateFormat>(),
		templateHash: text("template_hash").notNull(),
		metadata: jsonb("metadata").$type<Record<string, unknown>>(),
		mlflowUri: text("mlflow_uri"),
		createdByUserId: text("created_by_user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		createdAt: timestamp("created_at").notNull().defaultNow(),
	},
	(table) => ({
		promptVersionUnique: unique("uq_resource_prompt_versions_prompt_version").on(
			table.promptId,
			table.version,
		),
		promptIdx: index("idx_resource_prompt_versions_prompt").on(table.promptId),
		templateHashIdx: index("idx_resource_prompt_versions_template_hash").on(
			table.templateHash,
		),
		mlflowUriIdx: index("idx_resource_prompt_versions_mlflow_uri").on(table.mlflowUri),
	}),
);

export type SchemaType = "json-schema";

export const resourceSchemas = pgTable(
	"resource_schemas",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		name: text("name").notNull(),
		description: text("description"),
		schemaType: text("schema_type")
			.notNull()
			.default("json-schema")
			.$type<SchemaType>(),
		// biome-ignore lint/suspicious/noExplicitAny: JSON schema shape
		schema: jsonb("schema").notNull().$type<any>(),
		metadata: jsonb("metadata").$type<Record<string, unknown>>(),
		version: integer("version").notNull().default(1),
		isEnabled: boolean("is_enabled").notNull().default(true),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		projectId: text("project_id").references(() => projects.id, {
			onDelete: "cascade",
		}),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		userProjectIdx: index("idx_resource_schemas_user_project").on(
			table.userId,
			table.projectId,
		),
		enabledIdx: index("idx_resource_schemas_enabled").on(table.isEnabled),
		userProjectNameUnique: unique("uq_resource_schemas_user_project_name").on(
			table.userId,
			table.projectId,
			table.name,
		),
	}),
);

export const resourceModelProfiles = pgTable(
	"resource_model_profiles",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		name: text("name").notNull(),
		description: text("description"),
		model: jsonb("model").notNull().$type<{ provider: string; name: string }>(),
		defaultOptions: jsonb("default_options").$type<Record<string, unknown>>(),
		maxTurns: integer("max_turns"),
		timeoutMinutes: integer("timeout_minutes"),
		metadata: jsonb("metadata").$type<Record<string, unknown>>(),
		version: integer("version").notNull().default(1),
		isEnabled: boolean("is_enabled").notNull().default(true),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		projectId: text("project_id").references(() => projects.id, {
			onDelete: "cascade",
		}),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		userProjectIdx: index("idx_resource_model_profiles_user_project").on(
			table.userId,
			table.projectId,
		),
		enabledIdx: index("idx_resource_model_profiles_enabled").on(
			table.isEnabled,
		),
		userProjectNameUnique: unique(
			"uq_resource_model_profiles_user_project_name",
		).on(table.userId, table.projectId, table.name),
	}),
);

export type WorkflowResourceType =
	| "prompt"
	| "schema"
	| "model_profile"
	| "agent_profile";

export const workflowResourceRefs = pgTable(
	"workflow_resource_refs",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		workflowId: text("workflow_id")
			.notNull()
			.references(() => workflows.id, { onDelete: "cascade" }),
		nodeId: text("node_id").notNull(),
		resourceType: text("resource_type").notNull().$type<WorkflowResourceType>(),
		resourceId: text("resource_id").notNull(),
		resourceVersion: integer("resource_version"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		workflowNodeIdx: index("idx_workflow_resource_refs_workflow_node").on(
			table.workflowId,
			table.nodeId,
		),
		resourceLookupIdx: index("idx_workflow_resource_refs_resource_lookup").on(
			table.resourceType,
			table.resourceId,
		),
	}),
);

// Relations
export const workflowExecutionsRelations = relations(
	workflowExecutions,
	({ one, many }) => ({
		workflow: one(workflows, {
			fields: [workflowExecutions.workflowId],
			references: [workflows.id],
		}),
		planArtifacts: many(workflowPlanArtifacts),
		browserArtifacts: many(workflowBrowserArtifacts),
		codeCheckpoints: many(workflowCodeCheckpoints),
	}),
);

export const workflowCodeCheckpointsRelations = relations(
	workflowCodeCheckpoints,
	({ one }) => ({
		workflowExecution: one(workflowExecutions, {
			fields: [workflowCodeCheckpoints.workflowExecutionId],
			references: [workflowExecutions.id],
		}),
		agentRun: one(workflowAgentRuns, {
			fields: [workflowCodeCheckpoints.workflowAgentRunId],
			references: [workflowAgentRuns.id],
		}),
	}),
);

export const workflowPlanArtifactsRelations = relations(
	workflowPlanArtifacts,
	({ one }) => ({
		workflowExecution: one(workflowExecutions, {
			fields: [workflowPlanArtifacts.workflowExecutionId],
			references: [workflowExecutions.id],
		}),
		workflow: one(workflows, {
			fields: [workflowPlanArtifacts.workflowId],
			references: [workflows.id],
		}),
		user: one(users, {
			fields: [workflowPlanArtifacts.userId],
			references: [users.id],
		}),
	}),
);

export const workflowBrowserArtifactsRelations = relations(
	workflowBrowserArtifacts,
	({ one }) => ({
		workflowExecution: one(workflowExecutions, {
			fields: [workflowBrowserArtifacts.workflowExecutionId],
			references: [workflowExecutions.id],
		}),
		workflow: one(workflows, {
			fields: [workflowBrowserArtifacts.workflowId],
			references: [workflows.id],
		}),
	}),
);

export type User = typeof users.$inferSelect;
export type Platform = typeof platforms.$inferSelect;
export type NewPlatform = typeof platforms.$inferInsert;
export type SigningKey = typeof signingKeys.$inferSelect;
export type NewSigningKey = typeof signingKeys.$inferInsert;
export type UserIdentity = typeof userIdentities.$inferSelect;
export type NewUserIdentity = typeof userIdentities.$inferInsert;
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type ProjectMember = typeof projectMembers.$inferSelect;
export type NewProjectMember = typeof projectMembers.$inferInsert;
export type Workflow = typeof workflows.$inferSelect;
export type NewWorkflow = typeof workflows.$inferInsert;
export type McpServer = typeof mcpServers.$inferSelect;
export type NewMcpServer = typeof mcpServers.$inferInsert;
export type McpRun = typeof mcpRuns.$inferSelect;
export type NewMcpRun = typeof mcpRuns.$inferInsert;
export type McpConnection = typeof mcpConnections.$inferSelect;
export type NewMcpConnection = typeof mcpConnections.$inferInsert;
export type PieceMetadata = typeof pieceMetadata.$inferSelect;
export type NewPieceMetadata = typeof pieceMetadata.$inferInsert;
export type PieceExecution = typeof pieceExecution.$inferSelect;
export type NewPieceExecution = typeof pieceExecution.$inferInsert;
export type PieceStoreEntry = typeof pieceStore.$inferSelect;
export type AppConnectionRecord = typeof appConnections.$inferSelect;
export type NewAppConnectionRecord = typeof appConnections.$inferInsert;
export type WorkflowConnectionRef = typeof workflowConnectionRefs.$inferSelect;
export type NewWorkflowConnectionRef =
	typeof workflowConnectionRefs.$inferInsert;
export type WorkflowAiMessage = typeof workflowAiMessages.$inferSelect;
export type NewWorkflowAiMessage = typeof workflowAiMessages.$inferInsert;
export type WorkflowAiToolMessage = typeof workflowAiToolMessages.$inferSelect;
export type NewWorkflowAiToolMessage =
	typeof workflowAiToolMessages.$inferInsert;
export type WorkflowExecution = typeof workflowExecutions.$inferSelect;
export type NewWorkflowExecution = typeof workflowExecutions.$inferInsert;
export type WorkflowExecutionLog = typeof workflowExecutionLogs.$inferSelect;
export type NewWorkflowExecutionLog = typeof workflowExecutionLogs.$inferInsert;
export type WorkflowPlanArtifact = typeof workflowPlanArtifacts.$inferSelect;
export type NewWorkflowPlanArtifact = typeof workflowPlanArtifacts.$inferInsert;
export type WorkflowBrowserArtifact =
	typeof workflowBrowserArtifacts.$inferSelect;
export type NewWorkflowBrowserArtifact =
	typeof workflowBrowserArtifacts.$inferInsert;
export type WorkflowBrowserArtifactBlobPayload =
	typeof workflowBrowserArtifactBlobPayloads.$inferSelect;
export type NewWorkflowBrowserArtifactBlobPayload =
	typeof workflowBrowserArtifactBlobPayloads.$inferInsert;
export type WorkflowWorkspaceSession =
	typeof workflowWorkspaceSessions.$inferSelect;
export type NewWorkflowWorkspaceSession =
	typeof workflowWorkspaceSessions.$inferInsert;
export type WorkflowAgentRun = typeof workflowAgentRuns.$inferSelect;
export type NewWorkflowAgentRun = typeof workflowAgentRuns.$inferInsert;
export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type PlatformOauthApp = typeof platformOauthApps.$inferSelect;
export type NewPlatformOauthApp = typeof platformOauthApps.$inferInsert;
export type ModelProvider = typeof modelProviders.$inferSelect;
export type NewModelProvider = typeof modelProviders.$inferInsert;
export type ModelCatalogEntry = typeof modelCatalog.$inferSelect;
export type NewModelCatalogEntry = typeof modelCatalog.$inferInsert;
export type AgentInstructionFacet = typeof agentInstructionFacets.$inferSelect;
export type NewAgentInstructionFacet =
	typeof agentInstructionFacets.$inferInsert;
export type AgentInstructionFacetVersion =
	typeof agentInstructionFacetVersions.$inferSelect;
export type NewAgentInstructionFacetVersion =
	typeof agentInstructionFacetVersions.$inferInsert;
export type AgentModelFacet = typeof agentModelFacets.$inferSelect;
export type NewAgentModelFacet = typeof agentModelFacets.$inferInsert;
export type AgentModelFacetVersion =
	typeof agentModelFacetVersions.$inferSelect;
export type NewAgentModelFacetVersion =
	typeof agentModelFacetVersions.$inferInsert;
export type AgentToolPolicyFacet = typeof agentToolPolicyFacets.$inferSelect;
export type NewAgentToolPolicyFacet = typeof agentToolPolicyFacets.$inferInsert;
export type AgentToolPolicyFacetVersion =
	typeof agentToolPolicyFacetVersions.$inferSelect;
export type NewAgentToolPolicyFacetVersion =
	typeof agentToolPolicyFacetVersions.$inferInsert;
export type AgentMemoryFacet = typeof agentMemoryFacets.$inferSelect;
export type NewAgentMemoryFacet = typeof agentMemoryFacets.$inferInsert;
export type AgentMemoryFacetVersion =
	typeof agentMemoryFacetVersions.$inferSelect;
export type NewAgentMemoryFacetVersion =
	typeof agentMemoryFacetVersions.$inferInsert;
export type AgentExecutionFacet = typeof agentExecutionFacets.$inferSelect;
export type NewAgentExecutionFacet = typeof agentExecutionFacets.$inferInsert;
export type AgentExecutionFacetVersion =
	typeof agentExecutionFacetVersions.$inferSelect;
export type NewAgentExecutionFacetVersion =
	typeof agentExecutionFacetVersions.$inferInsert;
export type AgentInteractionFacet = typeof agentInteractionFacets.$inferSelect;
export type NewAgentInteractionFacet =
	typeof agentInteractionFacets.$inferInsert;
export type AgentInteractionFacetVersion =
	typeof agentInteractionFacetVersions.$inferSelect;
export type NewAgentInteractionFacetVersion =
	typeof agentInteractionFacetVersions.$inferInsert;
export type AgentOutputFacet = typeof agentOutputFacets.$inferSelect;
export type NewAgentOutputFacet = typeof agentOutputFacets.$inferInsert;
export type AgentOutputFacetVersion =
	typeof agentOutputFacetVersions.$inferSelect;
export type NewAgentOutputFacetVersion =
	typeof agentOutputFacetVersions.$inferInsert;
export type AgentCapabilityFacet = typeof agentCapabilityFacets.$inferSelect;
export type NewAgentCapabilityFacet = typeof agentCapabilityFacets.$inferInsert;
export type AgentCapabilityFacetVersion =
	typeof agentCapabilityFacetVersions.$inferSelect;
export type NewAgentCapabilityFacetVersion =
	typeof agentCapabilityFacetVersions.$inferInsert;
export type AgentProfileTemplate = typeof agentProfileTemplates.$inferSelect;
export type NewAgentProfileTemplate = typeof agentProfileTemplates.$inferInsert;
export type AgentProfileTemplateVersion =
	typeof agentProfileTemplateVersions.$inferSelect;
export type NewAgentProfileTemplateVersion =
	typeof agentProfileTemplateVersions.$inferInsert;
export type AgentProfileTemplateExample =
	typeof agentProfileTemplateExamples.$inferSelect;
export type NewAgentProfileTemplateExample =
	typeof agentProfileTemplateExamples.$inferInsert;
export type AgentSkillRegistry = typeof agentSkillRegistry.$inferSelect;
export type NewAgentSkillRegistry = typeof agentSkillRegistry.$inferInsert;
export type ResourcePrompt = typeof resourcePrompts.$inferSelect;
export type NewResourcePrompt = typeof resourcePrompts.$inferInsert;
export type ResourcePromptVersion = typeof resourcePromptVersions.$inferSelect;
export type NewResourcePromptVersion = typeof resourcePromptVersions.$inferInsert;
export type ResourceSchema = typeof resourceSchemas.$inferSelect;
export type NewResourceSchema = typeof resourceSchemas.$inferInsert;
export type ResourceModelProfile = typeof resourceModelProfiles.$inferSelect;
export type NewResourceModelProfile = typeof resourceModelProfiles.$inferInsert;
export type WorkflowResourceRef = typeof workflowResourceRefs.$inferSelect;
export type NewWorkflowResourceRef = typeof workflowResourceRefs.$inferInsert;

// ============================================================================
// Environments (Sandbox + networking templates)
// ============================================================================

/**
 * Environments are reusable sandbox/networking templates that agents reference
 * by id. Modeled on Claude Managed Agents' environment primitive. Promoted from
 * the previous inline SandboxPolicy shape (now deleted) into a first-class,
 * versioned resource.
 */
export const environments = pgTable(
	"environments",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		slug: text("slug").notNull(),
		name: text("name").notNull(),
		description: text("description"),
		avatar: text("avatar"),
		tags: jsonb("tags").$type<string[]>().notNull().default([]),
		runtime: text("runtime").notNull().default("cloud"),
		currentVersionId: text("current_version_id"),
		createdBy: text("created_by").references(() => users.id, {
			onDelete: "set null",
		}),
		projectId: text("project_id").references(() => projects.id, {
			onDelete: "cascade",
		}),
		isArchived: boolean("is_archived").notNull().default(false),
		// Catalog metadata absorbed from sandbox_profiles in migration 0038.
		// `isBuiltin: true` guards the seeded envs (dapr-agent, dapr-agent-xlsx,
		// dapr-agent-animation, dapr-agent-datasci, dapr-agent-webdev) from
		// archive+delete. `baseEnvSlug` replaces the old base_profile_slug —
		// null means the Dockerfile FROMs the root openshell-sandbox image;
		// otherwise it points at another env's slug (1-level inheritance).
		isBuiltin: boolean("is_builtin").notNull().default(false),
		baseEnvSlug: text("base_env_slug"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		slugUnique: unique("uq_environments_slug").on(table.slug),
		archivedIdx: index("idx_environments_archived").on(table.isArchived),
		projectIdx: index("idx_environments_project").on(table.projectId),
		builtinIdx: index("idx_environments_builtin").on(table.isBuiltin),
		baseIdx: index("idx_environments_base").on(table.baseEnvSlug),
	}),
);

export const environmentVersions = pgTable(
	"environment_versions",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		environmentId: text("environment_id")
			.notNull()
			.references(() => environments.id, { onDelete: "cascade" }),
		version: integer("version").notNull(),
		config: jsonb("config").notNull().$type<Record<string, unknown>>(),
		configHash: text("config_hash").notNull(),
		changelog: text("changelog"),
		publishedAt: timestamp("published_at"),
		publishedBy: text("published_by").references(() => users.id, {
			onDelete: "set null",
		}),
		// Build artifacts absorbed from sandbox_profiles in migration 0038.
		// Filled in by the Tekton pipeline + admin-console polling. `imageTag`
		// is the specific tag the sandbox should pull (includes git SHA for
		// cacheability). A new version bumps iff config changed — build state
		// stays on the current version until the next package edit.
		imageTag: text("image_tag"),
		dockerfilePath: text("dockerfile_path"),
		lastBuildSha: text("last_build_sha"),
		lastBuildAt: timestamp("last_build_at"),
		lastBuildStatus: text("last_build_status"),
		lastBuildError: text("last_build_error"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
	},
	(table) => ({
		versionUnique: unique("uq_environment_version").on(
			table.environmentId,
			table.version,
		),
		hashIdx: index("idx_environment_versions_hash").on(table.configHash),
		environmentIdx: index("idx_environment_versions_environment").on(
			table.environmentId,
		),
	}),
);

// ============================================================================
// Sandbox Profiles (pre-built image catalog)
// ============================================================================

/**
 * Curated catalog of pre-built sandbox images. Mirrors CMA's blank-slate
 * `packages` manifest but bakes everything into the Docker image at build
 * time, because OpenShell's runtime client.exec path doesn't reliably
 * support apt/pip installs (apt needs root; pip under client.exec hits
 * 403 even with `access: full` policy). Per NVIDIA's documented pattern,
 * system libs belong in the image, pip-at-runtime is advisory only.
 *
 * A profile is a single logical image: slug → Dockerfile → image tag.
 * Admin console edits update the packages manifest, regenerate the
 * Dockerfile server-side, commit it to stacks/workflow-builder, and
 * auto-trigger a Tekton rebuild. Environments reference profiles by
 * slug via `environment.sandboxTemplate`.
 */
export const sandboxProfiles = pgTable(
	"sandbox_profiles",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		slug: text("slug").notNull().unique(),
		name: text("name").notNull(),
		description: text("description"),
		// null = inherits from the root `openshell-sandbox:latest` image.
		// Otherwise this must be another profile's slug; the resolved
		// `FROM` in the generated Dockerfile is the parent profile's
		// current imageTag. 1-level inheritance — no chains.
		baseProfileSlug: text("base_profile_slug"),
		packages: jsonb("packages")
			.$type<{
				apt?: string[];
				pip?: string[];
				npm?: string[];
				cargo?: string[];
				gem?: string[];
				go?: string[];
			}>()
			.notNull()
			.default({}),
		// Capability flags surfaced to _workspace_capabilities() in the
		// runtime. Derived from packages during seed but can be hand-edited.
		capabilities: jsonb("capabilities")
			.$type<string[]>()
			.notNull()
			.default([]),
		// Build tracking — filled in by the Tekton pipeline + admin-
		// console polling. `imageTag` is the specific tag the sandbox
		// should pull (includes git SHA for cacheability).
		dockerfilePath: text("dockerfile_path"),
		imageTag: text("image_tag"),
		lastBuildSha: text("last_build_sha"),
		lastBuildAt: timestamp("last_build_at"),
		lastBuildStatus: text("last_build_status"),
		lastBuildError: text("last_build_error"),
		// `isBuiltin: true` guards the seeded profiles
		// (dapr-agent, dapr-agent-xlsx, dapr-agent-animation,
		// dapr-agent-datasci, dapr-agent-webdev) from archive+delete.
		isArchived: boolean("is_archived").notNull().default(false),
		isBuiltin: boolean("is_builtin").notNull().default(false),
		createdBy: text("created_by").references(() => users.id, {
			onDelete: "set null",
		}),
		projectId: text("project_id").references(() => projects.id, {
			onDelete: "cascade",
		}),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		archivedIdx: index("idx_sandbox_profiles_archived").on(table.isArchived),
		projectIdx: index("idx_sandbox_profiles_project")
			.on(table.projectId)
			.where(sql`${table.projectId} IS NOT NULL`),
		baseIdx: index("idx_sandbox_profiles_base").on(table.baseProfileSlug),
	}),
);

// ============================================================================
// Agents (Named Agent Definitions)
// ============================================================================

/**
 * Named agents library. Workflow nodes reference these by id; the spec-builder
 * resolves the reference at execute time and inlines the canonical config into
 * the durable/run task payload. Replaces the prior inline-per-node agentConfig
 * and the unfinished Mastra-style agents/agent_profile_applied_history tables.
 *
 * `environmentId` is the required pointer to the sandbox template; `defaultVaultIds`
 * is reserved for the Phase 2 Vaults work.
 */
export const agents = pgTable(
	"agents",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		slug: text("slug").notNull(),
		name: text("name").notNull(),
		description: text("description"),
		avatar: text("avatar"),
		tags: jsonb("tags").$type<string[]>().notNull().default([]),
		runtime: text("runtime").notNull().default("dapr-agent-py"),
		// Physical Dapr app-id stamped on the per-agent runtime pod (browser/
		// Playwright agents) or on the per-session Sandbox (everything else).
		// Usually `agent-runtime-<slug>`; with shared pools enabled this can be
		// `agent-runtime-pool-<class>`. Stays null for archived / unpublished rows.
		runtimeAppId: text("runtime_app_id"),
		// Mirror of the SandboxWarmPool / per-session Sandbox status so the
		// agent detail page can render Sleeping / Starting / Active / Failed
		// without a live Kubernetes API hit. Updated by a lightweight reconcile
		// poll.
		runtimeStatus: text("runtime_status").notNull().default("pending"),
		runtimeStatusSyncedAt: timestamp("runtime_status_synced_at", {
			withTimezone: true,
		}),
		currentVersionId: text("current_version_id"),
		environmentId: text("environment_id").references(() => environments.id, {
			onDelete: "restrict",
		}),
		environmentVersion: integer("environment_version"),
		defaultVaultIds: jsonb("default_vault_ids")
			.$type<string[]>()
			.notNull()
			.default([]),
		sourceTemplateSlug: text("source_template_slug"),
		sourceTemplateVersion: integer("source_template_version"),
		createdBy: text("created_by").references(() => users.id, {
			onDelete: "set null",
		}),
		projectId: text("project_id").references(() => projects.id, {
			onDelete: "cascade",
		}),
		isArchived: boolean("is_archived").notNull().default(false),
		registryStatus: text("registry_status").notNull().default("unregistered"),
		registrySyncedAt: timestamp("registry_synced_at", { withTimezone: true }),
		registryError: text("registry_error"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		slugUnique: unique("uq_agents_slug").on(table.slug),
		archivedIdx: index("idx_agents_archived").on(table.isArchived),
		environmentIdx: index("idx_agents_environment").on(table.environmentId),
		projectIdx: index("idx_agents_project").on(table.projectId),
		registryStatusIdx: index("idx_agents_registry_status").on(table.registryStatus),
	}),
);

export const agentVersions = pgTable(
	"agent_versions",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		agentId: text("agent_id")
			.notNull()
			.references(() => agents.id, { onDelete: "cascade" }),
		version: integer("version").notNull(),
		config: jsonb("config").notNull().$type<Record<string, unknown>>(),
		configHash: text("config_hash").notNull(),
		applicationStateDigest: text("application_state_digest"),
		mlflowUri: text("mlflow_uri"),
		mlflowModelName: text("mlflow_model_name"),
		mlflowModelVersion: text("mlflow_model_version"),
		changelog: text("changelog"),
		publishedAt: timestamp("published_at"),
		publishedBy: text("published_by").references(() => users.id, {
			onDelete: "set null",
		}),
		createdAt: timestamp("created_at").notNull().defaultNow(),
	},
	(table) => ({
		versionUnique: unique("uq_agent_version").on(table.agentId, table.version),
		hashIdx: index("idx_agent_versions_hash").on(table.configHash),
		stateDigestIdx: index("idx_agent_versions_state_digest").on(
			table.applicationStateDigest,
		),
		agentIdx: index("idx_agent_versions_agent").on(table.agentId),
		mlflowUriIdx: index("idx_agent_versions_mlflow_uri").on(table.mlflowUri),
	}),
);

// Reusable capability bundles (Pillar 2): a named, versioned, workspace-scoped
// SUBSET of AgentConfig (mcpServers / skills / tools / hooks / plugins / prompt
// presets) that agents, sessions, and workflow nodes reference via
// `AgentConfig.bundleRefs`. `flattenBundles()` merges a referenced bundle's
// version config into the effective config before MCP resolution. Mirrors the
// agents/agent_versions shape (sans runtime/environment/mlflow).
export const capabilityBundles = pgTable(
	"capability_bundles",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		slug: text("slug").notNull(),
		name: text("name").notNull(),
		description: text("description"),
		tags: jsonb("tags").$type<string[]>().notNull().default([]),
		currentVersionId: text("current_version_id"),
		createdBy: text("created_by").references(() => users.id, {
			onDelete: "set null",
		}),
		projectId: text("project_id").references(() => projects.id, {
			onDelete: "cascade",
		}),
		isArchived: boolean("is_archived").notNull().default(false),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		slugUnique: unique("uq_capability_bundles_slug").on(table.slug),
		projectIdx: index("idx_capability_bundles_project").on(table.projectId),
		archivedIdx: index("idx_capability_bundles_archived").on(table.isArchived),
	}),
);

export const capabilityBundleVersions = pgTable(
	"capability_bundle_versions",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		bundleId: text("bundle_id")
			.notNull()
			.references(() => capabilityBundles.id, { onDelete: "cascade" }),
		version: integer("version").notNull(),
		config: jsonb("config").notNull().$type<Record<string, unknown>>(),
		configHash: text("config_hash").notNull(),
		changelog: text("changelog"),
		publishedAt: timestamp("published_at"),
		publishedBy: text("published_by").references(() => users.id, {
			onDelete: "set null",
		}),
		createdAt: timestamp("created_at").notNull().defaultNow(),
	},
	(table) => ({
		versionUnique: unique("uq_capability_bundle_version").on(
			table.bundleId,
			table.version,
		),
		bundleIdx: index("idx_capability_bundle_versions_bundle").on(table.bundleId),
		hashIdx: index("idx_capability_bundle_versions_hash").on(table.configHash),
	}),
);

export type MlflowLineageEntityType =
	| "agent_version"
	| "workflow"
	| "workflow_version"
	| "workflow_execution"
	| "workflow_node_run"
	| "session"
	| "agent_run"
	| "benchmark_run"
	| "benchmark_run_instance"
	| "evaluation_run"
	| "dataset"
	| "trace_proxy";

export type MlflowLineageMlflowEntityType =
	| "experiment"
	| "run"
	| "session"
	| "trace"
	| "dataset"
	| "dataset_record"
	| "logged_model"
	| "prompt";

export const mlflowLineageLinks = pgTable(
	"mlflow_lineage_links",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		sourceKey: text("source_key").notNull(),
		entityType: text("entity_type").notNull().$type<MlflowLineageEntityType>(),
		entityId: text("entity_id").notNull(),
		entityVersion: text("entity_version"),
		projectId: text("project_id").references(() => projects.id, {
			onDelete: "set null",
		}),
		mlflowEntityType: text("mlflow_entity_type")
			.notNull()
			.$type<MlflowLineageMlflowEntityType>(),
		mlflowExperimentId: text("mlflow_experiment_id"),
		mlflowRunId: text("mlflow_run_id"),
		mlflowSessionId: text("mlflow_session_id"),
		mlflowTraceId: text("mlflow_trace_id"),
		mlflowDatasetId: text("mlflow_dataset_id"),
		mlflowDatasetRecordId: text("mlflow_dataset_record_id"),
		mlflowLoggedModelId: text("mlflow_logged_model_id"),
		mlflowLoggedModelName: text("mlflow_logged_model_name"),
		mlflowLoggedModelUri: text("mlflow_logged_model_uri"),
		mlflowModelVersion: text("mlflow_model_version"),
		mlflowPromptUri: text("mlflow_prompt_uri"),
		mlflowPromptName: text("mlflow_prompt_name"),
		mlflowPromptVersion: text("mlflow_prompt_version"),
		mlflowPublicUrl: text("mlflow_public_url"),
		tags: jsonb("tags").$type<Record<string, unknown>>().notNull().default({}),
		metadata: jsonb("metadata")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		sourceKeyUnique: unique("uq_mlflow_lineage_links_source_key").on(
			table.sourceKey,
		),
		localEntityIdx: index("idx_mlflow_lineage_links_local_entity").on(
			table.entityType,
			table.entityId,
			table.entityVersion,
		),
		projectIdx: index("idx_mlflow_lineage_links_project").on(table.projectId),
		mlflowRunIdx: index("idx_mlflow_lineage_links_mlflow_run").on(
			table.mlflowRunId,
		),
		mlflowSessionIdx: index("idx_mlflow_lineage_links_mlflow_session").on(
			table.mlflowSessionId,
		),
		mlflowTraceIdx: index("idx_mlflow_lineage_links_mlflow_trace").on(
			table.mlflowTraceId,
		),
		mlflowDatasetIdx: index("idx_mlflow_lineage_links_mlflow_dataset").on(
			table.mlflowDatasetId,
		),
		mlflowLoggedModelIdx: index(
			"idx_mlflow_lineage_links_mlflow_logged_model",
		).on(table.mlflowLoggedModelUri),
		mlflowPromptIdx: index("idx_mlflow_lineage_links_mlflow_prompt").on(
			table.mlflowPromptUri,
		),
	}),
);

// ============================================================================
// Vaults (MCP credentials with auto-refresh; never enter the sandbox)
// ============================================================================

/**
 * Vaults group credentials that agents/sessions attach by id. Anthropic's
 * Managed Agents vault model — credentials never leave the host and are
 * injected at tool-call time by function-router (the proxy). This complements
 * project-level `mcp_connection` rows, which are still used by the workflow
 * orchestrator when resolving project-scoped MCP servers.
 */
export const vaults = pgTable(
	"vaults",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		name: text("name").notNull(),
		description: text("description"),
		projectId: text("project_id").references(() => projects.id, {
			onDelete: "cascade",
		}),
		createdBy: text("created_by").references(() => users.id, {
			onDelete: "set null",
		}),
		isArchived: boolean("is_archived").notNull().default(false),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		nameProjectUnique: unique("uq_vaults_project_name").on(
			table.projectId,
			table.name,
		),
		projectIdx: index("idx_vaults_project").on(table.projectId),
		archivedIdx: index("idx_vaults_archived").on(table.isArchived),
	}),
);

/**
 * Individual credentials inside a vault. `value` is AES-256-CBC encrypted
 * (reuses the `EncryptedObject` shape from security/encryption.ts) and
 * never returned from the API. `mcpServerUrl` is used by function-router
 * to match credentials to MCP server declarations on the agent.
 *
 * `refreshMetadata.refreshTokenEncrypted` is also an `EncryptedObject` — we
 * keep it separate from `value` so a rotation of the access token doesn't
 * touch the refresh token and vice versa.
 */
export const vaultCredentials = pgTable(
	"vault_credentials",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		vaultId: text("vault_id")
			.notNull()
			.references(() => vaults.id, { onDelete: "cascade" }),
		displayName: text("display_name").notNull(),
		authType: text("auth_type").notNull(),
		value: jsonb("value")
			.notNull()
			.$type<{ iv: string; data: string }>(),
		mcpServerUrl: text("mcp_server_url"),
		refreshMetadata: jsonb("refresh_metadata").$type<Record<string, unknown>>(),
		expiresAt: timestamp("expires_at"),
		lastRefreshedAt: timestamp("last_refreshed_at"),
		lastUsedAt: timestamp("last_used_at"),
		isArchived: boolean("is_archived").notNull().default(false),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		vaultIdx: index("idx_vault_credentials_vault").on(table.vaultId),
		mcpUrlIdx: index("idx_vault_credentials_mcp_url").on(table.mcpServerUrl),
		expiresIdx: index("idx_vault_credentials_expires").on(table.expiresAt),
	}),
);

/**
 * Audit log for vault credential refresh attempts. One row per refresh
 * attempt (success or failure). Useful for diagnosing OAuth refresh failures.
 */
export const vaultCredentialRefreshLog = pgTable(
	"vault_credential_refresh_log",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		credentialId: text("credential_id")
			.notNull()
			.references(() => vaultCredentials.id, { onDelete: "cascade" }),
		status: text("status").notNull(), // "success" | "failure"
		errorMessage: text("error_message"),
		responseStatus: integer("response_status"),
		attemptedAt: timestamp("attempted_at").notNull().defaultNow(),
	},
	(table) => ({
		credentialIdx: index("idx_vault_refresh_log_credential").on(table.credentialId),
		attemptedIdx: index("idx_vault_refresh_log_attempted").on(table.attemptedAt),
	}),
);

/**
 * Per-user CLI subscription tokens for `interactive-cli` runtimes (e.g. the
 * Claude Code OAuth token from `claude setup-token`). One row per
 * (user, provider); `value` is AES-256-CBC encrypted (`EncryptedObject`) and
 * never returned from the API — only presence/expiry metadata is. Consumed at
 * spawn time by the interactive-terminal gate in sessions/spawn.ts and
 * delivered to the per-session pod via sandbox-execution-api's
 * `sessionSecretEnv` (per-session Secret, env-injected into the main
 * container).
 */
export const userCliCredentials = pgTable(
	"user_cli_credentials",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		provider: text("provider").notNull(),
		value: jsonb("value")
			.notNull()
			.$type<{ iv: string; data: string }>(),
		expiresAt: timestamp("expires_at"),
		lastValidatedAt: timestamp("last_validated_at"),
		status: text("status").notNull().default("active"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		userProviderUnique: unique("uq_user_cli_credentials_user_provider").on(
			table.userId,
			table.provider,
		),
		userIdx: index("idx_user_cli_credentials_user").on(table.userId),
	}),
);

// ============================================================================
// Sessions (one agent run, multi-turn, streamed events)
// ============================================================================

/**
 * Sessions are the runtime atom in the CMA-mirror model. A session pins to
 * an agent version and an environment version at creation and accumulates
 * events until it terminates. Long-lived — the Dapr workflow instance
 * backing the session stays alive across many user events (via
 * `ctx.wait_for_external_event`).
 */
export const sessions = pgTable(
	"sessions",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		title: text("title"),
		status: text("status").notNull().default("rescheduling"),
		stopReason: jsonb("stop_reason").$type<Record<string, unknown>>(),
		// Lifecycle stop-intent (mirrors workflow_executions.stop_requested_at):
		// set when a stop is requested; cleared implicitly when status→terminated.
		stopRequestedAt: timestamp("stop_requested_at"),
		// Lifecycle pause-intent: set when the user pauses the run (Dapr
		// suspend_workflow); cleared on resume. The terminal reaper skips rows
		// with this set, so a paused session is never purged even if its pod
		// dies while the workflow is suspended.
		pauseRequestedAt: timestamp("pause_requested_at"),
		agentId: text("agent_id")
			.notNull()
			.references(() => agents.id, { onDelete: "restrict" }),
		agentVersion: integer("agent_version"),
		environmentId: text("environment_id").references(() => environments.id, {
			onDelete: "restrict",
		}),
		environmentVersion: integer("environment_version"),
		vaultIds: jsonb("vault_ids").$type<string[]>().notNull().default([]),
		daprInstanceId: text("dapr_instance_id"),
		natsSubject: text("nats_subject"),
		sandboxName: text("sandbox_name"),
		workspaceSandboxName: text("workspace_sandbox_name"),
		runtimeAppId: text("runtime_app_id"),
		runtimeSandboxName: text("runtime_sandbox_name"),
		workflowExecutionId: text("workflow_execution_id"),
		parentExecutionId: text("parent_execution_id"),
		// Interactive-cli conversation resume: a resumed session is a NEW row
		// that re-mounts the original session's durable transcript subtree (the
		// CSI subPath keys on this id) and launches `claude --continue`. Lineage
		// only — not on the resume critical path (the value is threaded to the
		// sandbox host request, not read back to drive the mount).
		resumedFromSessionId: text("resumed_from_session_id"),
		mlflowExperimentId: text("mlflow_experiment_id"),
		mlflowRunId: text("mlflow_run_id"),
		mlflowParentRunId: text("mlflow_parent_run_id"),
		mlflowSessionId: text("mlflow_session_id"),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		projectId: text("project_id").references(() => projects.id, {
			onDelete: "cascade",
		}),
		// Per-session ACTUAL sandbox-pod resource consumption is accumulated by
		// the session-resource-sample CronJob under usage.resource (no dedicated
		// columns — see SessionResourceUsage in metrics/session-usage.ts):
		// { peakCpuMillicores, peakMemoryMiB, cpuMillicoreSum, memoryMiBSum,
		//   sampleCount, sampledAt }. peak = max observed; *Sum/sampleCount → avg.
		// Feeds request right-sizing. docs/session-resource-metrics-and-kueue-admission.md.
		usage: jsonb("usage").$type<Record<string, unknown>>().notNull().default({}),
		errorMessage: text("error_message"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
		completedAt: timestamp("completed_at"),
		archivedAt: timestamp("archived_at"),
	},
	(table) => ({
		agentIdx: index("idx_sessions_agent").on(table.agentId),
		userIdx: index("idx_sessions_user").on(table.userId),
		statusIdx: index("idx_sessions_status").on(table.status),
		createdIdx: index("idx_sessions_created").on(table.createdAt),
		workflowIdx: index("idx_sessions_workflow_execution").on(
			table.workflowExecutionId,
		),
		sandboxIdx: index("idx_sessions_sandbox_name").on(table.sandboxName),
		workspaceSandboxIdx: index("idx_sessions_workspace_sandbox").on(
			table.workspaceSandboxName,
		),
		runtimeAppIdx: index("idx_sessions_runtime_app_id").on(
			table.runtimeAppId,
		),
		runtimeSandboxIdx: index("idx_sessions_runtime_sandbox_name").on(
			table.runtimeSandboxName,
		),
		mlflowRunIdx: index("idx_sessions_mlflow_run").on(table.mlflowRunId),
		mlflowParentRunIdx: index("idx_sessions_mlflow_parent_run").on(
			table.mlflowParentRunId,
		),
		mlflowSessionIdx: index("idx_sessions_mlflow_session").on(
			table.mlflowSessionId,
		),
		// Composite partial index that serves the workspace sessions list
		// query (WHERE project_id = X AND archived_at IS NULL ORDER BY
		// created_at DESC LIMIT N). Added in migration 0041.
		projectCreatedIdx: index("idx_sessions_project_created")
			.on(table.projectId, table.createdAt.desc())
			.where(sql`${table.archivedAt} IS NULL`),
	}),
);

/**
 * Append-only event log for a session. `sequence` is monotonic within a
 * session — the ID prefix `sevt_` matches CMA's wire convention. The SSE
 * endpoint reads this alongside NATS for replay on reconnect.
 */
export const sessionEvents = pgTable(
	"session_events",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		sessionId: text("session_id")
			.notNull()
			.references(() => sessions.id, { onDelete: "cascade" }),
		sequence: integer("sequence").notNull(),
		type: text("type").notNull(),
		data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
		processedAt: timestamp("processed_at"),
		sourceEventId: text("source_event_id"),
		// Producer-Id triple for durable-streams-shaped idempotency. producerId
		// is the agent slug (joins with agents.slug); producerEpoch is the
		// emitting pod's process start-time in ns. See event_publisher.py and
		// migration 0043. Both columns are nullable so pre-upgrade rows stay
		// valid; the partial unique index uq_session_events_source enforces
		// dedup only when source_event_id IS NOT NULL.
		producerId: text("producer_id"),
		producerEpoch: text("producer_epoch"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
	},
	(table) => ({
		sessionSequence: unique("uq_session_event_sequence").on(
			table.sessionId,
			table.sequence,
		),
		sessionIdx: index("idx_session_events_session").on(table.sessionId),
		typeIdx: index("idx_session_events_type").on(table.type),
		createdIdx: index("idx_session_events_created").on(table.createdAt),
		producerIdx: index("idx_session_events_producer").on(
			table.producerId,
			table.producerEpoch,
		),
	}),
);

/**
 * Per-session goal (Codex `/goal` parity). `session_id` == codex `thread_id`.
 * One ACTIVE goal per session (partial unique index); setting a new objective
 * replaces the active goal and rotates `goal_id` + resets usage accounting,
 * mirroring codex `thread/goal/set`. The autonomous continuation loop (the BFF
 * goal-loop driver) re-injects the objective on each idle turn until the agent
 * calls `update_goal(status=complete)` after a completion audit, the token
 * budget is exhausted (→ budget_limited, one wrap-up turn), the iteration cap is
 * hit (→ budget_limited, stop_reason=iteration_cap), or the user pauses/stops.
 * `iterations`/`max_iterations`/`budget_steered_at`/`last_continuation_at` are
 * our loop-bookkeeping additions (not in codex).
 */
export const threadGoals = pgTable(
	"thread_goals",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		sessionId: text("session_id")
			.notNull()
			.references(() => sessions.id, { onDelete: "cascade" }),
		goalId: text("goal_id")
			.notNull()
			.$defaultFn(() => generateId()),
		objective: text("objective").notNull(),
		// active | paused | budget_limited | complete
		status: text("status").notNull().default("active"),
		tokenBudget: integer("token_budget"),
		tokensUsed: integer("tokens_used").notNull().default(0),
		timeUsedSeconds: integer("time_used_seconds").notNull().default(0),
		iterations: integer("iterations").notNull().default(0),
		maxIterations: integer("max_iterations").notNull().default(50),
		budgetSteeredAt: timestamp("budget_steered_at"),
		lastContinuationAt: timestamp("last_continuation_at"),
		// complete | budget | iteration_cap | interrupt
		stopReason: text("stop_reason"),
		workflowExecutionId: text("workflow_execution_id"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
		completedAt: timestamp("completed_at"),
	},
	(table) => ({
		// At most one active goal per session (codex single-goal-per-thread
		// semantics); historical paused/complete/budget_limited rows are kept.
		activeUq: uniqueIndex("uq_thread_goals_session_active")
			.on(table.sessionId)
			.where(sql`${table.status} = 'active'`),
		sessionIdx: index("idx_thread_goals_session").on(table.sessionId),
		statusIdx: index("idx_thread_goals_status").on(table.status),
	}),
);

export type ThreadGoalRow = InferSelectModel<typeof threadGoals>;
export type NewThreadGoalRow = InferInsertModel<typeof threadGoals>;

// ============================================================================
// Benchmarks (SWE-bench Verified/Lite)
// ============================================================================

export type BenchmarkRunStatus =
	| "queued"
	| "inferencing"
	| "evaluating"
	| "completed"
	| "failed"
	| "cancelled";
export type BenchmarkRunInstanceStatus =
	| "queued"
	| "inferencing"
	| "inferred"
	| "evaluating"
	| "resolved"
	| "failed"
	| "error"
	| "timeout"
	| "cancelled";
export type BenchmarkInferenceStatus =
	| "queued"
	| "inferencing"
	| "inferred"
	| "error"
	| "timeout"
	| "cancelled";
export type BenchmarkEvaluationStatus =
	| "pending"
	| "evaluating"
	| "resolved"
	| "unresolved"
	| "empty_patch"
	| "error"
	| "timeout"
	| "cancelled";
export type EnvironmentImageBuildStatus =
	| "queued"
	| "building"
	| "validated"
	| "failed"
	| "cancelled";
export type EnvironmentBuildActivityEventType =
	| "build_queued"
	| "pipelinerun_created"
	| "task_started"
	| "task_succeeded"
	| "task_failed"
	| "validation_started"
	| "validation_succeeded"
	| "validation_failed"
	| "image_pushed"
	| "digest_captured"
	| "build_succeeded"
	| "build_failed";
export type GitOpsActivitySource = "tekton" | "promoter" | "argocd" | "inventory" | "kubernetes";
export type GitOpsActivityType =
	| "tekton.pipelinerun"
	| "tekton.taskrun"
	| "promoter.promotionstrategy"
	| "promoter.changetransferpolicy"
	| "promoter.pullrequest"
	| "promoter.commitstatus"
	| "argocd.application"
	| "gitops.inventory"
	| "kubernetes.resource";
export type EnvironmentImageBuildStrategy =
	| "swebench-harness"
	| "buildpacks"
	| "dockerfile"
	| "scripted";
export type BenchmarkArtifactKind =
	| "dataset_jsonl"
	| "predictions_jsonl"
	| "model_patch"
	| "harness_result"
	| "logs"
	| "test_output";
export type BenchmarkResourceLeaseType =
	| "inference_slot"
	| "openshell_sandbox"
	| "agent_runtime_slot"
	| "dapr_workflow_slot"
	| "evaluator_slot"
	| "model_slot";
export type BenchmarkResourceLeaseStatus =
	| "active"
	| "released"
	| "expired";

export const benchmarkSuites = pgTable(
	"benchmark_suites",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		slug: text("slug").notNull(),
		name: text("name").notNull(),
		description: text("description"),
		datasetName: text("dataset_name").notNull(),
		datasetSplit: text("dataset_split").notNull().default("test"),
		sourceUrl: text("source_url"),
		defaultInstanceLimit: integer("default_instance_limit"),
		metadata: jsonb("metadata")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		slugUnique: unique("uq_benchmark_suites_slug").on(table.slug),
		datasetIdx: index("idx_benchmark_suites_dataset").on(
			table.datasetName,
			table.datasetSplit,
		),
	}),
);

export const benchmarkInstances = pgTable(
	"benchmark_instances",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		suiteId: text("suite_id")
			.notNull()
			.references(() => benchmarkSuites.id, { onDelete: "cascade" }),
		instanceId: text("instance_id").notNull(),
		repo: text("repo"),
		baseCommit: text("base_commit"),
		problemStatement: text("problem_statement"),
		hintsText: text("hints_text"),
		testMetadata: jsonb("test_metadata")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		goldPatch: text("gold_patch"),
		mlflowDatasetId: text("mlflow_dataset_id"),
		mlflowDatasetRecordId: text("mlflow_dataset_record_id"),
		metadata: jsonb("metadata")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		suiteInstanceUnique: unique("uq_benchmark_instances_suite_instance").on(
			table.suiteId,
			table.instanceId,
		),
		suiteIdx: index("idx_benchmark_instances_suite").on(table.suiteId),
		instanceIdx: index("idx_benchmark_instances_instance").on(
			table.instanceId,
		),
		repoIdx: index("idx_benchmark_instances_repo").on(table.repo),
		mlflowDatasetIdx: index("idx_benchmark_instances_mlflow_dataset").on(
			table.mlflowDatasetId,
		),
		mlflowRecordIdx: index("idx_benchmark_instances_mlflow_record").on(
			table.mlflowDatasetRecordId,
		),
	}),
);

export const benchmarkRuns = pgTable(
	"benchmark_runs",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		suiteId: text("suite_id")
			.notNull()
			.references(() => benchmarkSuites.id, { onDelete: "restrict" }),
		agentId: text("agent_id")
			.notNull()
			.references(() => agents.id, { onDelete: "restrict" }),
		agentVersion: integer("agent_version").notNull(),
		agentRuntime: text("agent_runtime").notNull(),
		agentRuntimeAppId: text("agent_runtime_app_id").notNull(),
		status: text("status")
			.notNull()
			.default("queued")
			.$type<BenchmarkRunStatus>(),
		modelNameOrPath: text("model_name_or_path").notNull(),
		modelConfigLabel: text("model_config_label"),
		selectedInstanceIds: jsonb("selected_instance_ids")
			.$type<string[]>()
			.notNull()
			.default([]),
		concurrency: integer("concurrency").notNull().default(1),
		evaluationConcurrency: integer("evaluation_concurrency")
			.notNull()
			.default(24),
		timeoutSeconds: integer("timeout_seconds").notNull().default(7200),
		maxTurns: integer("max_turns"),
		evaluatorResourceClass: text("evaluator_resource_class")
			.notNull()
			.default("standard"),
		coordinatorExecutionId: text("coordinator_execution_id"),
		evaluatorJobName: text("evaluator_job_name"),
		predictionsPath: text("predictions_path"),
		mlflowExperimentId: text("mlflow_experiment_id"),
		mlflowRunId: text("mlflow_run_id"),
		mlflowDatasetId: text("mlflow_dataset_id"),
		mlflowEvalRunId: text("mlflow_eval_run_id"),
		summary: jsonb("summary")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		tags: jsonb("tags").$type<string[]>().notNull().default([]),
		error: text("error"),
		cancelRequestedAt: timestamp("cancel_requested_at"),
		startedAt: timestamp("started_at"),
		completedAt: timestamp("completed_at"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		projectCreatedIdx: index("idx_benchmark_runs_project_created").on(
			table.projectId,
			table.createdAt,
		),
		statusIdx: index("idx_benchmark_runs_status").on(table.status),
		suiteIdx: index("idx_benchmark_runs_suite").on(table.suiteId),
		agentIdx: index("idx_benchmark_runs_agent").on(table.agentId),
		mlflowRunIdx: index("idx_benchmark_runs_mlflow_run").on(
			table.mlflowRunId,
		),
		mlflowDatasetIdx: index("idx_benchmark_runs_mlflow_dataset").on(
			table.mlflowDatasetId,
		),
		mlflowEvalRunIdx: index("idx_benchmark_runs_mlflow_eval_run").on(
			table.mlflowEvalRunId,
		),
	}),
);

export const benchmarkRunInstances = pgTable(
	"benchmark_run_instances",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		runId: text("run_id")
			.notNull()
			.references(() => benchmarkRuns.id, { onDelete: "cascade" }),
		benchmarkInstanceId: text("benchmark_instance_id").references(
			() => benchmarkInstances.id,
			{ onDelete: "set null" },
		),
		instanceId: text("instance_id").notNull(),
		status: text("status")
			.notNull()
			.default("queued")
			.$type<BenchmarkRunInstanceStatus>(),
		inferenceStatus: text("inference_status")
			.notNull()
			.default("queued")
			.$type<BenchmarkInferenceStatus>(),
		evaluationStatus: text("evaluation_status")
			.notNull()
			.default("pending")
			.$type<BenchmarkEvaluationStatus>(),
		sessionId: text("session_id").references(() => sessions.id, {
			onDelete: "set null",
		}),
		workflowExecutionId: text("workflow_execution_id").references(
			() => workflowExecutions.id,
			{ onDelete: "set null" },
		),
		daprInstanceId: text("dapr_instance_id"),
		mlflowRunId: text("mlflow_run_id"),
		mlflowTraceId: text("mlflow_trace_id"),
		mlflowDatasetId: text("mlflow_dataset_id"),
		mlflowDatasetRecordId: text("mlflow_dataset_record_id"),
		sandboxName: text("sandbox_name"),
		workspaceRef: text("workspace_ref"),
		modelPatch: text("model_patch"),
		patchSha256: text("patch_sha256"),
		patchBytes: integer("patch_bytes"),
		usage: jsonb("usage")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		timings: jsonb("timings")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		traceIds: jsonb("trace_ids").$type<string[]>().notNull().default([]),
		error: text("error"),
		inferenceError: text("inference_error"),
		evaluationError: text("evaluation_error"),
		logsPath: text("logs_path"),
		testOutputSummary: text("test_output_summary"),
		harnessResult: jsonb("harness_result").$type<Record<string, unknown>>(),
		patchAddedLines: integer("patch_added_lines"),
		patchRemovedLines: integer("patch_removed_lines"),
		patchFilesTouched: integer("patch_files_touched"),
		patchFilesOverlapGold: integer("patch_files_overlap_gold"),
		patchWellFormed: boolean("patch_well_formed"),
		turnCount: integer("turn_count"),
		toolCallCount: integer("tool_call_count"),
		terminationReason: text("termination_reason"),
		ttftFirstMs: integer("ttft_first_ms"),
		ttftFirstToolMs: integer("ttft_first_tool_ms"),
		toolHistogram: jsonb("tool_histogram")
			.$type<Record<string, number>>()
			.notNull()
			.default({}),
		inferenceEnvironment: jsonb("inference_environment")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		startedAt: timestamp("started_at"),
		inferenceCompletedAt: timestamp("inference_completed_at"),
		evaluatedAt: timestamp("evaluated_at"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		runInstanceUnique: unique("uq_benchmark_run_instances_run_instance").on(
			table.runId,
			table.instanceId,
		),
		runIdx: index("idx_benchmark_run_instances_run").on(table.runId),
		statusIdx: index("idx_benchmark_run_instances_status").on(table.status),
		sessionIdx: index("idx_benchmark_run_instances_session").on(
			table.sessionId,
		),
		workflowExecutionIdx: index(
			"idx_benchmark_run_instances_workflow_execution",
		).on(table.workflowExecutionId),
		mlflowRunIdx: index("idx_benchmark_run_instances_mlflow_run").on(
			table.mlflowRunId,
		),
		mlflowTraceIdx: index("idx_benchmark_run_instances_mlflow_trace").on(
			table.mlflowTraceId,
		),
		mlflowDatasetIdx: index("idx_benchmark_run_instances_mlflow_dataset").on(
			table.mlflowDatasetId,
		),
		mlflowRecordIdx: index("idx_benchmark_run_instances_mlflow_record").on(
			table.mlflowDatasetRecordId,
		),
	}),
	);

export const benchmarkResourceLeases = pgTable(
	"benchmark_resource_leases",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		runId: text("run_id")
			.notNull()
			.references(() => benchmarkRuns.id, { onDelete: "cascade" }),
		instanceId: text("instance_id"),
		phase: text("phase").notNull().default("inference"),
		resourceType: text("resource_type")
			.notNull()
			.$type<BenchmarkResourceLeaseType>(),
		capacityKey: text("capacity_key").notNull().default("default"),
		holderId: text("holder_id").notNull(),
		leaseCount: integer("lease_count").notNull().default(1),
		status: text("status")
			.notNull()
			.default("active")
			.$type<BenchmarkResourceLeaseStatus>(),
		metadata: jsonb("metadata")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		acquiredAt: timestamp("acquired_at").notNull().defaultNow(),
		heartbeatAt: timestamp("heartbeat_at").notNull().defaultNow(),
		expiresAt: timestamp("expires_at").notNull(),
		releasedAt: timestamp("released_at"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		runIdx: index("idx_benchmark_resource_leases_run").on(table.runId),
		instanceIdx: index("idx_benchmark_resource_leases_instance").on(
			table.runId,
			table.instanceId,
		),
		resourceIdx: index("idx_benchmark_resource_leases_resource").on(
			table.resourceType,
			table.capacityKey,
			table.status,
		),
		holderIdx: index("idx_benchmark_resource_leases_holder").on(
			table.holderId,
			table.resourceType,
		),
		expiresIdx: index("idx_benchmark_resource_leases_expires").on(
			table.expiresAt,
		),
	}),
);

export const environmentImageBuilds = pgTable(
	"environment_image_builds",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		dataset: text("dataset").notNull(),
		suite: text("suite"),
		repo: text("repo").notNull(),
		version: text("version"),
		environmentSetupCommit: text("environment_setup_commit"),
		baseCommit: text("base_commit"),
		environmentKey: text("environment_key").notNull(),
		envSpecHash: text("env_spec_hash").notNull(),
		buildStrategy: text("build_strategy")
			.notNull()
			.default("swebench-harness")
			.$type<EnvironmentImageBuildStrategy>(),
		status: text("status")
			.notNull()
			.default("queued")
			.$type<EnvironmentImageBuildStatus>(),
		sandboxTemplate: text("sandbox_template").notNull().default("dapr-agent"),
		sandboxImage: text("sandbox_image"),
		digest: text("digest"),
		imageName: text("image_name"),
		imageTag: text("image_tag"),
		dockerfilePath: text("dockerfile_path"),
		validationCommand: text("validation_command"),
		validationStatus: text("validation_status"),
		validationLogRef: text("validation_log_ref"),
		buildLogRef: text("build_log_ref"),
		pipelineRunName: text("pipeline_run_name"),
		pipelineRunNamespace: text("pipeline_run_namespace").default(
			"tekton-pipelines",
		),
		spec: jsonb("spec")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		metadata: jsonb("metadata")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		error: text("error"),
		requestedAt: timestamp("requested_at").notNull().defaultNow(),
		startedAt: timestamp("started_at"),
		completedAt: timestamp("completed_at"),
		builtAt: timestamp("built_at"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		envSpecHashUnique: unique("uq_environment_image_builds_spec_hash").on(
			table.envSpecHash,
		),
		statusIdx: index("idx_environment_image_builds_status").on(table.status),
		environmentKeyIdx: index("idx_environment_image_builds_key").on(
			table.environmentKey,
		),
		repoIdx: index("idx_environment_image_builds_repo").on(table.repo),
		pipelineRunIdx: index("idx_environment_image_builds_pipeline_run").on(
			table.pipelineRunNamespace,
			table.pipelineRunName,
		),
	}),
);

// Phase G — scorer layer. One row per (benchmark_run_instance, scorer_name,
// scorer_version). Idempotent: score-runner skips if a row already exists.
export const benchmarkRunInstanceScores = pgTable(
	"benchmark_run_instance_scores",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		runInstanceId: text("run_instance_id")
			.notNull()
			.references(() => benchmarkRunInstances.id, { onDelete: "cascade" }),
		scorerName: text("scorer_name").notNull(),
		scorerVersion: integer("scorer_version").notNull().default(1),
		score: doublePrecision("score").notNull(),
		reasoning: text("reasoning"),
		metadata: jsonb("metadata")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		uniqueScorer: unique("uq_benchmark_run_instance_scores_unique").on(
			table.runInstanceId,
			table.scorerName,
			table.scorerVersion,
		),
		scorerIdx: index("idx_benchmark_run_instance_scores_scorer").on(
			table.scorerName,
			table.scorerVersion,
		),
		runInstanceIdx: index("idx_benchmark_run_instance_scores_run_instance").on(
			table.runInstanceId,
		),
	}),
);

// Phase K — human annotation layer. One row per (run_instance, user). Single
// user can revise their own verdict via UPSERT on the unique constraint.
export type BenchmarkInstanceAnnotationVerdict =
	| "correct"
	| "incorrect"
	| "partial"
	| "unsure";

export const benchmarkRunInstanceAnnotations = pgTable(
	"benchmark_run_instance_annotations",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		runInstanceId: text("run_instance_id")
			.notNull()
			.references(() => benchmarkRunInstances.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		verdict: text("verdict").notNull().$type<BenchmarkInstanceAnnotationVerdict>(),
		reasoning: text("reasoning"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		userUnique: unique("uq_benchmark_run_instance_annotations_user").on(
			table.runInstanceId,
			table.userId,
		),
		runInstanceIdx: index(
			"idx_benchmark_run_instance_annotations_run_instance",
		).on(table.runInstanceId),
	}),
);

export const environmentBuildActivityEvents = pgTable(
	"environment_build_activity_events",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		buildId: text("build_id")
			.notNull()
			.references(() => environmentImageBuilds.id, { onDelete: "cascade" }),
		environmentKey: text("environment_key").notNull(),
		eventKey: text("event_key").notNull(),
		eventType: text("event_type")
			.notNull()
			.$type<EnvironmentBuildActivityEventType>(),
		pipelineRunName: text("pipeline_run_name"),
		pipelineRunNamespace: text("pipeline_run_namespace"),
		taskRunName: text("task_run_name"),
		phase: text("phase"),
		reason: text("reason"),
		message: text("message"),
		eventTimestamp: timestamp("event_timestamp").notNull(),
		rawMetadata: jsonb("raw_metadata")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		buildEventUnique: unique("uq_environment_build_activity_build_event").on(
			table.buildId,
			table.eventKey,
		),
		buildTimelineIdx: index("idx_environment_build_activity_timeline").on(
			table.buildId,
			table.eventTimestamp,
		),
		buildTypeIdx: index("idx_environment_build_activity_type").on(
			table.buildId,
			table.eventType,
		),
		pipelineRunIdx: index("idx_environment_build_activity_pipeline_run").on(
			table.pipelineRunNamespace,
			table.pipelineRunName,
		),
	}),
);

export const gitopsActivityEvents = pgTable(
	"gitops_activity_events",
	{
		eventId: text("event_id").primaryKey(),
		sequence: serial("sequence").notNull(),
		source: text("source").notNull().$type<GitOpsActivitySource | string>(),
		activityKey: text("activity_key").notNull(),
		activityType: text("activity_type").notNull().$type<GitOpsActivityType | string>(),
		phase: text("phase"),
		reason: text("reason"),
		message: text("message"),
		resourceGroup: text("resource_group"),
		resourceVersion: text("resource_version"),
		resourceResource: text("resource_resource"),
		resourceKind: text("resource_kind"),
		resourceNamespace: text("resource_namespace"),
		resourceName: text("resource_name"),
		resourceUid: text("resource_uid"),
		observedAt: timestamp("observed_at").notNull(),
		correlation: jsonb("correlation")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		raw: jsonb("raw").$type<Record<string, unknown>>().notNull().default({}),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		sequenceUnique: unique("uq_gitops_activity_events_sequence").on(table.sequence),
		activityKeyIdx: index("idx_gitops_activity_events_activity_key").on(
			table.activityKey,
			table.observedAt,
		),
		resourceIdx: index("idx_gitops_activity_events_resource").on(
			table.resourceKind,
			table.resourceNamespace,
			table.resourceName,
		),
		observedAtIdx: index("idx_gitops_activity_events_observed_at").on(table.observedAt),
		sourceIdx: index("idx_gitops_activity_events_source").on(table.source),
	}),
);

export const benchmarkArtifacts = pgTable(
	"benchmark_artifacts",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		runId: text("run_id")
			.notNull()
			.references(() => benchmarkRuns.id, { onDelete: "cascade" }),
		runInstanceId: text("run_instance_id").references(
			() => benchmarkRunInstances.id,
			{ onDelete: "cascade" },
		),
		kind: text("kind").notNull().$type<BenchmarkArtifactKind>(),
		path: text("path").notNull(),
		contentType: text("content_type"),
		sizeBytes: integer("size_bytes"),
		sha256: text("sha256"),
		metadata: jsonb("metadata")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		createdAt: timestamp("created_at").notNull().defaultNow(),
	},
	(table) => ({
		runIdx: index("idx_benchmark_artifacts_run").on(table.runId),
		instanceIdx: index("idx_benchmark_artifacts_instance").on(
			table.runInstanceId,
		),
		kindIdx: index("idx_benchmark_artifacts_kind").on(table.kind),
	}),
);

// ============================================================================
// Evaluations (generic datasets, eval contracts, runs, graders, artifacts)
// ============================================================================

export type EvaluationGraderType =
	| "string_check"
	| "text_similarity"
	| "score_model"
	| "python"
	| "multi"
	| "external_harness"
	| "mlflow_judge";

export type EvaluationRunStatus =
	| "queued"
	| "running"
	| "grading"
	| "completed"
	| "failed"
	| "cancelled";

export type EvaluationRunItemStatus =
	| "queued"
	| "running"
	| "grading"
	| "passed"
	| "failed"
	| "error"
	| "cancelled"
	| "skipped";

export type EvaluationSubjectType =
	| "agent"
	| "workflow"
	| "imported_outputs"
	| "model";

export type EvaluationArtifactKind =
	| "dataset_import"
	| "generated_output"
	| "grader_result"
	| "external_harness"
	| "logs"
	| "report"
	| "predictions_jsonl";

export const evaluationDatasets = pgTable(
	"evaluation_datasets",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		createdBy: text("created_by")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		description: text("description"),
		sourceType: text("source_type").notNull().default("manual"),
		sourceUrl: text("source_url"),
		schema: jsonb("schema")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		metadata: jsonb("metadata")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		projectCreatedIdx: index("idx_evaluation_datasets_project_created").on(
			table.projectId,
			table.createdAt,
		),
		projectNameIdx: index("idx_evaluation_datasets_project_name").on(
			table.projectId,
			table.name,
		),
	}),
);

export const evaluationDatasetRows = pgTable(
	"evaluation_dataset_rows",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		datasetId: text("dataset_id")
			.notNull()
			.references(() => evaluationDatasets.id, { onDelete: "cascade" }),
		externalId: text("external_id"),
		input: jsonb("input")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		expectedOutput: jsonb("expected_output").$type<unknown>(),
		generatedOutput: jsonb("generated_output").$type<unknown>(),
		annotations: jsonb("annotations")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		rating: integer("rating"),
		feedback: text("feedback"),
		metadata: jsonb("metadata")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		// Phase H — bidirectional link to the benchmark run instance / session
		// this row was captured from. NULL when the row was authored manually
		// (CSV import, hand-crafted, etc.).
		originRunInstanceId: text("origin_run_instance_id"),
		originSessionId: text("origin_session_id"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		datasetIdx: index("idx_evaluation_dataset_rows_dataset").on(
			table.datasetId,
		),
		externalIdx: index("idx_evaluation_dataset_rows_external").on(
			table.externalId,
		),
		datasetExternalUnique: unique(
			"uq_evaluation_dataset_rows_dataset_external",
		).on(table.datasetId, table.externalId),
		originRunInstanceIdx: index("idx_evaluation_dataset_rows_origin_run_instance").on(
			table.originRunInstanceId,
		),
		originSessionIdx: index("idx_evaluation_dataset_rows_origin_session").on(
			table.originSessionId,
		),
	}),
);

export const evaluations = pgTable(
	"evaluations",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		createdBy: text("created_by")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		datasetId: text("dataset_id").references(() => evaluationDatasets.id, {
			onDelete: "set null",
		}),
		name: text("name").notNull(),
		description: text("description"),
		taskConfig: jsonb("task_config")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		dataSourceConfig: jsonb("data_source_config")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		testingCriteria: jsonb("testing_criteria")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		metadata: jsonb("metadata")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		projectCreatedIdx: index("idx_evaluations_project_created").on(
			table.projectId,
			table.createdAt,
		),
		datasetIdx: index("idx_evaluations_dataset").on(table.datasetId),
	}),
);

export const evaluationGraders = pgTable(
	"evaluation_graders",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		evaluationId: text("evaluation_id")
			.notNull()
			.references(() => evaluations.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		type: text("type").notNull().$type<EvaluationGraderType>(),
		config: jsonb("config")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		weight: integer("weight").notNull().default(1),
		passThreshold: real("pass_threshold").notNull().default(1),
		orderIndex: integer("order_index").notNull().default(0),
		enabled: boolean("enabled").notNull().default(true),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		evaluationIdx: index("idx_evaluation_graders_evaluation").on(
			table.evaluationId,
		),
		typeIdx: index("idx_evaluation_graders_type").on(table.type),
	}),
);

export const evaluationRuns = pgTable(
	"evaluation_runs",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		evaluationId: text("evaluation_id")
			.notNull()
			.references(() => evaluations.id, { onDelete: "cascade" }),
		datasetId: text("dataset_id").references(() => evaluationDatasets.id, {
			onDelete: "set null",
		}),
		status: text("status")
			.notNull()
			.default("queued")
			.$type<EvaluationRunStatus>(),
		subjectType: text("subject_type")
			.notNull()
			.default("imported_outputs")
			.$type<EvaluationSubjectType>(),
		subjectId: text("subject_id"),
		subjectVersion: text("subject_version"),
		executionConfig: jsonb("execution_config")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		coordinatorExecutionId: text("coordinator_execution_id"),
		summary: jsonb("summary")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		usage: jsonb("usage")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		error: text("error"),
		cancelRequestedAt: timestamp("cancel_requested_at"),
		startedAt: timestamp("started_at"),
		completedAt: timestamp("completed_at"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		projectCreatedIdx: index("idx_evaluation_runs_project_created").on(
			table.projectId,
			table.createdAt,
		),
		statusIdx: index("idx_evaluation_runs_status").on(table.status),
		evaluationIdx: index("idx_evaluation_runs_evaluation").on(
			table.evaluationId,
		),
		datasetIdx: index("idx_evaluation_runs_dataset").on(table.datasetId),
	}),
);

export const evaluationRunItems = pgTable(
	"evaluation_run_items",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		runId: text("run_id")
			.notNull()
			.references(() => evaluationRuns.id, { onDelete: "cascade" }),
		datasetRowId: text("dataset_row_id").references(
			() => evaluationDatasetRows.id,
			{ onDelete: "set null" },
		),
		rowIndex: integer("row_index").notNull().default(0),
		status: text("status")
			.notNull()
			.default("queued")
			.$type<EvaluationRunItemStatus>(),
		input: jsonb("input")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		expectedOutput: jsonb("expected_output").$type<unknown>(),
		generatedOutput: jsonb("generated_output").$type<unknown>(),
		graderResults: jsonb("grader_results")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		scores: jsonb("scores")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		usage: jsonb("usage")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		traceIds: jsonb("trace_ids").$type<string[]>().notNull().default([]),
		sessionId: text("session_id").references(() => sessions.id, {
			onDelete: "set null",
		}),
		workflowExecutionId: text("workflow_execution_id").references(
			() => workflowExecutions.id,
			{ onDelete: "set null" },
		),
		daprInstanceId: text("dapr_instance_id"),
		error: text("error"),
		startedAt: timestamp("started_at"),
		completedAt: timestamp("completed_at"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		runIdx: index("idx_evaluation_run_items_run").on(table.runId),
		statusIdx: index("idx_evaluation_run_items_status").on(table.status),
		datasetRowIdx: index("idx_evaluation_run_items_dataset_row").on(
			table.datasetRowId,
		),
		workflowExecutionIdx: index(
			"idx_evaluation_run_items_workflow_execution",
		).on(table.workflowExecutionId),
	}),
);

export const evaluationArtifacts = pgTable(
	"evaluation_artifacts",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		runId: text("run_id")
			.notNull()
			.references(() => evaluationRuns.id, { onDelete: "cascade" }),
		runItemId: text("run_item_id").references(() => evaluationRunItems.id, {
			onDelete: "cascade",
		}),
		kind: text("kind").notNull().$type<EvaluationArtifactKind>(),
		path: text("path"),
		content: jsonb("content").$type<unknown>(),
		contentType: text("content_type"),
		sizeBytes: integer("size_bytes"),
		sha256: text("sha256"),
		metadata: jsonb("metadata")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		createdAt: timestamp("created_at").notNull().defaultNow(),
	},
	(table) => ({
		runIdx: index("idx_evaluation_artifacts_run").on(table.runId),
		itemIdx: index("idx_evaluation_artifacts_item").on(table.runItemId),
		kindIdx: index("idx_evaluation_artifacts_kind").on(table.kind),
	}),
);

/**
 * Resources mounted into a session's sandbox at startup — files, GitHub
 * repos. GitHub repos carry a reference to a vault credential (the clone
 * token) rather than the token itself.
 */
export const sessionResources = pgTable(
	"session_resources",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		sessionId: text("session_id")
			.notNull()
			.references(() => sessions.id, { onDelete: "cascade" }),
		type: text("type").notNull(),
		fileId: text("file_id"),
		mountPath: text("mount_path"),
		repoUrl: text("repo_url"),
		checkoutRef: text("checkout_ref"),
		authTokenCredentialId: text("auth_token_credential_id").references(
			() => vaultCredentials.id,
			{ onDelete: "set null" },
		),
		// Alternative clone-auth source: a GitHub OAuth app_connection (by
		// externalId). EITHER this OR authTokenCredentialId provides the clone
		// token. Plain text (no FK) to match how connections are referenced
		// elsewhere (connectionExternalId); the broker resolves + auto-refreshes
		// the token at clone time via getDecryptedAppConnection().
		appConnectionExternalId: text("app_connection_external_id"),
		mountedAt: timestamp("mounted_at"),
		removedAt: timestamp("removed_at"),
	},
	(table) => ({
		sessionIdx: index("idx_session_resources_session").on(table.sessionId),
	}),
);

// ============================================================================
// Functions & Function Executions (Dynamic Function Registry)
// ============================================================================

/**
 * Execution types for functions:
 * - builtin: Statically compiled TypeScript handlers (default)
 * - oci: Container image executed as K8s Job
 * - http: External HTTP webhook
 */
export type FunctionExecutionType = "builtin" | "oci" | "http";
export type CodeFunctionLanguage = "typescript" | "python";
export type CodeFunctionRole = "function" | "workflow";
export interface CodeFunctionCompositionGraph {
	activitySlugs: string[];
	hasFork: boolean;
	hasSwitch: boolean;
	hasDurableAgent: boolean;
}

/**
 * Function execution status
 */
export type FunctionExecutionStatus =
	| "pending"
	| "running"
	| "completed"
	| "failed";

/**
 * Retry policy configuration for functions
 */
export type RetryPolicy = {
	maxAttempts?: number;
	initialDelaySeconds?: number;
	maxDelaySeconds?: number;
	backoffMultiplier?: number;
};

/**
 * Functions table - stores function definitions
 * Supports built-in (TypeScript), OCI (container), and HTTP (webhook) execution types
 */
export const functions = pgTable("functions", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => generateId()),
	name: text("name").notNull(),
	// Unique identifier: e.g., "openai/generate-text", "slack/send-message"
	slug: text("slug").notNull().unique(),
	description: text("description"),
	// Plugin this function belongs to: e.g., "openai", "slack", "github"
	pluginId: text("plugin_id").notNull(),
	// Semantic version
	version: text("version").notNull().default("1.0.0"),

	// Execution type determines how the function is invoked
	executionType: text("execution_type")
		.notNull()
		.default("builtin")
		.$type<FunctionExecutionType>(),

	// For OCI functions: container image reference
	// e.g., "gitea.cnoe.localtest.me:8443/functions/my-func:v1"
	imageRef: text("image_ref"),
	// Override container entrypoint command
	command: text("command"),
	// Working directory inside container
	workingDir: text("working_dir"),
	// Environment variables for container (JSON)
	containerEnv: jsonb("container_env").$type<Record<string, string>>(),

	// For HTTP functions: webhook configuration
	webhookUrl: text("webhook_url"),
	webhookMethod: text("webhook_method").default("POST"),
	webhookHeaders: jsonb("webhook_headers").$type<Record<string, string>>(),
	// Timeout for waiting on webhook response
	webhookTimeoutSeconds: integer("webhook_timeout_seconds").default(30),

	// Input/Output JSON Schema definitions
	// biome-ignore lint/suspicious/noExplicitAny: JSON Schema type
	inputSchema: jsonb("input_schema").$type<any>(),
	// biome-ignore lint/suspicious/noExplicitAny: JSON Schema type
	outputSchema: jsonb("output_schema").$type<any>(),

	// Execution configuration
	timeoutSeconds: integer("timeout_seconds").default(300),
	retryPolicy: jsonb("retry_policy").$type<RetryPolicy>(),
	// Maximum concurrent executions (0 = unlimited)
	maxConcurrency: integer("max_concurrency").default(0),

	// Integration type this function requires (for credential lookup)
	// e.g., "openai", "slack", "github"
	integrationType: text("integration_type"),

	// Feature flags
	isBuiltin: boolean("is_builtin").default(false),
	isEnabled: boolean("is_enabled").default(true),
	isDeprecated: boolean("is_deprecated").default(false),

	// Metadata
	createdAt: timestamp("created_at").notNull().defaultNow(),
	updatedAt: timestamp("updated_at").notNull().defaultNow(),
	createdBy: text("created_by").references(() => users.id),
});

/**
 * Code functions table - stores parser-backed authored TS/Python functions.
 */
export const codeFunctions = pgTable("code_functions", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => generateId()),
	name: text("name").notNull(),
	slug: text("slug").notNull().unique(),
	description: text("description"),
	version: text("version").notNull().default("0.1.0"),
	language: text("language").notNull().$type<CodeFunctionLanguage>(),
	entrypoint: text("entrypoint").notNull().default("main"),
	path: text("path"),
	source: text("source").notNull(),
	// biome-ignore lint/suspicious/noExplicitAny: map of relative file path -> source text
	supportingFiles: jsonb("supporting_files").$type<Record<string, string>>(),
	sourceHash: text("source_hash").notNull(),
	// biome-ignore lint/suspicious/noExplicitAny: semantic parser payload is JSONB
	semanticModel: jsonb("semantic_model").$type<any>(),
	// biome-ignore lint/suspicious/noExplicitAny: parser-generated JSON Schema
	inputSchema: jsonb("input_schema").$type<any>(),
	// biome-ignore lint/suspicious/noExplicitAny: parser-generated semantic type payload
	returnType: jsonb("return_type").$type<any>(),
	// biome-ignore lint/suspicious/noExplicitAny: parser-generated import list
	imports: jsonb("imports").$type<any[]>(),
	// biome-ignore lint/suspicious/noExplicitAny: parser-generated diagnostics list
	diagnostics: jsonb("diagnostics").$type<any[]>(),
	// biome-ignore lint/suspicious/noExplicitAny: parser-generated capability flags
	capabilities: jsonb("capabilities").$type<any>(),
	role: text("role").notNull().default("function").$type<CodeFunctionRole>(),
	compositionGraph: jsonb("composition_graph").$type<CodeFunctionCompositionGraph>(),
	latestPublishedVersion: text("latest_published_version"),
	lastPublishedAt: timestamp("last_published_at"),
	isEnabled: boolean("is_enabled").notNull().default(true),
	createdAt: timestamp("created_at").notNull().defaultNow(),
	updatedAt: timestamp("updated_at").notNull().defaultNow(),
	createdBy: text("created_by").references(() => users.id),
});

/**
 * Immutable published revisions for parser-backed code functions.
 */
export const codeFunctionRevisions = pgTable("code_function_revisions", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => generateId()),
	codeFunctionId: text("code_function_id")
		.notNull()
		.references(() => codeFunctions.id, { onDelete: "cascade" }),
	version: text("version").notNull(),
	name: text("name").notNull(),
	slug: text("slug").notNull(),
	description: text("description"),
	language: text("language").notNull().$type<CodeFunctionLanguage>(),
	entrypoint: text("entrypoint").notNull().default("main"),
	path: text("path"),
	source: text("source").notNull(),
	// biome-ignore lint/suspicious/noExplicitAny: map of relative file path -> source text
	supportingFiles: jsonb("supporting_files").$type<Record<string, string>>(),
	sourceHash: text("source_hash").notNull(),
	// biome-ignore lint/suspicious/noExplicitAny: semantic parser payload is JSONB
	semanticModel: jsonb("semantic_model").$type<any>(),
	// biome-ignore lint/suspicious/noExplicitAny: parser-generated JSON Schema
	inputSchema: jsonb("input_schema").$type<any>(),
	// biome-ignore lint/suspicious/noExplicitAny: parser-generated semantic type payload
	returnType: jsonb("return_type").$type<any>(),
	// biome-ignore lint/suspicious/noExplicitAny: parser-generated import list
	imports: jsonb("imports").$type<any[]>(),
	// biome-ignore lint/suspicious/noExplicitAny: parser-generated diagnostics list
	diagnostics: jsonb("diagnostics").$type<any[]>(),
	// biome-ignore lint/suspicious/noExplicitAny: parser-generated capability flags
	capabilities: jsonb("capabilities").$type<any>(),
	role: text("role").notNull().default("function").$type<CodeFunctionRole>(),
	compositionGraph: jsonb("composition_graph").$type<CodeFunctionCompositionGraph>(),
	publishedAt: timestamp("published_at").notNull().defaultNow(),
	createdBy: text("created_by").references(() => users.id),
}, (table) => ({
	codeFunctionVersionIdx: unique("uq_code_function_revision_version").on(
		table.codeFunctionId,
		table.version
	),
}));

/**
 * Function executions table - tracks individual function invocations
 */
export const functionExecutions = pgTable("function_executions", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => generateId()),
	functionId: text("function_id").references(() => functions.id),
	// Link to the workflow execution that triggered this function
	workflowExecutionId: text("workflow_execution_id").references(
		() => workflowExecutions.id,
	),
	// Node ID within the workflow
	nodeId: text("node_id"),

	// Execution status
	status: text("status")
		.notNull()
		.default("pending")
		.$type<FunctionExecutionStatus>(),

	// Input provided to the function
	// biome-ignore lint/suspicious/noExplicitAny: JSONB type
	input: jsonb("input").$type<any>(),
	// Output returned by the function
	// biome-ignore lint/suspicious/noExplicitAny: JSONB type
	output: jsonb("output").$type<any>(),
	// Error message if execution failed
	error: text("error"),

	// For OCI functions: K8s Job name for tracking
	jobName: text("job_name"),
	// For OCI functions: Pod name for log retrieval
	podName: text("pod_name"),

	// Timing
	startedAt: timestamp("started_at"),
	completedAt: timestamp("completed_at"),
	durationMs: integer("duration_ms"),

	// Retry tracking
	attemptNumber: integer("attempt_number").default(1),
	lastError: text("last_error"),
});

// Relations for functions
export const functionsRelations = relations(functions, ({ one, many }) => ({
	createdByUser: one(users, {
		fields: [functions.createdBy],
		references: [users.id],
	}),
	executions: many(functionExecutions),
}));

export const codeFunctionsRelations = relations(codeFunctions, ({ one }) => ({
	createdByUser: one(users, {
		fields: [codeFunctions.createdBy],
		references: [users.id],
	}),
}));

export const codeFunctionRevisionsRelations = relations(codeFunctionRevisions, ({ one }) => ({
	codeFunction: one(codeFunctions, {
		fields: [codeFunctionRevisions.codeFunctionId],
		references: [codeFunctions.id],
	}),
	createdByUser: one(users, {
		fields: [codeFunctionRevisions.createdBy],
		references: [users.id],
	}),
}));

export const functionExecutionsRelations = relations(
	functionExecutions,
	({ one }) => ({
		function: one(functions, {
			fields: [functionExecutions.functionId],
			references: [functions.id],
		}),
		workflowExecution: one(workflowExecutions, {
			fields: [functionExecutions.workflowExecutionId],
			references: [workflowExecutions.id],
		}),
	}),
);

// Export types for functions
export type Function = typeof functions.$inferSelect;
export type NewFunction = typeof functions.$inferInsert;
export type CodeFunction = typeof codeFunctions.$inferSelect;
export type NewCodeFunction = typeof codeFunctions.$inferInsert;
export type CodeFunctionRevision = typeof codeFunctionRevisions.$inferSelect;
export type NewCodeFunctionRevision = typeof codeFunctionRevisions.$inferInsert;
export type FunctionExecution = typeof functionExecutions.$inferSelect;
export type NewFunctionExecution = typeof functionExecutions.$inferInsert;

// Export types for observability tables
export type CredentialAccessLog = typeof credentialAccessLogs.$inferSelect;
export type NewCredentialAccessLog = typeof credentialAccessLogs.$inferInsert;
export type WorkflowExternalEvent = typeof workflowExternalEvents.$inferSelect;
export type NewWorkflowExternalEvent =
	typeof workflowExternalEvents.$inferInsert;
export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
export type AgentVersion = typeof agentVersions.$inferSelect;
export type NewAgentVersion = typeof agentVersions.$inferInsert;
export type MlflowLineageLink = typeof mlflowLineageLinks.$inferSelect;
export type NewMlflowLineageLink = typeof mlflowLineageLinks.$inferInsert;
export type Environment = typeof environments.$inferSelect;
export type NewEnvironment = typeof environments.$inferInsert;
export type EnvironmentVersion = typeof environmentVersions.$inferSelect;
export type NewEnvironmentVersion = typeof environmentVersions.$inferInsert;
export type SandboxProfile = typeof sandboxProfiles.$inferSelect;
export type NewSandboxProfile = typeof sandboxProfiles.$inferInsert;
export type Vault = typeof vaults.$inferSelect;
export type NewVault = typeof vaults.$inferInsert;
export type VaultCredential = typeof vaultCredentials.$inferSelect;
export type NewVaultCredential = typeof vaultCredentials.$inferInsert;
export type VaultCredentialRefreshLog =
	typeof vaultCredentialRefreshLog.$inferSelect;
export type NewVaultCredentialRefreshLog =
	typeof vaultCredentialRefreshLog.$inferInsert;
export type UserCliCredential = typeof userCliCredentials.$inferSelect;
export type NewUserCliCredential = typeof userCliCredentials.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type SessionEvent = typeof sessionEvents.$inferSelect;
export type NewSessionEvent = typeof sessionEvents.$inferInsert;
export type SessionResource = typeof sessionResources.$inferSelect;
export type NewSessionResource = typeof sessionResources.$inferInsert;
export type BenchmarkSuite = typeof benchmarkSuites.$inferSelect;
export type NewBenchmarkSuite = typeof benchmarkSuites.$inferInsert;
export type BenchmarkInstance = typeof benchmarkInstances.$inferSelect;
export type NewBenchmarkInstance = typeof benchmarkInstances.$inferInsert;
export type BenchmarkRun = typeof benchmarkRuns.$inferSelect;
export type NewBenchmarkRun = typeof benchmarkRuns.$inferInsert;
export type BenchmarkRunInstance = typeof benchmarkRunInstances.$inferSelect;
export type NewBenchmarkRunInstance =
	typeof benchmarkRunInstances.$inferInsert;
export type EnvironmentImageBuild =
	typeof environmentImageBuilds.$inferSelect;
export type NewEnvironmentImageBuild =
	typeof environmentImageBuilds.$inferInsert;
export type EnvironmentBuildActivityEvent =
	typeof environmentBuildActivityEvents.$inferSelect;
export type NewEnvironmentBuildActivityEvent =
	typeof environmentBuildActivityEvents.$inferInsert;
export type BenchmarkArtifact = typeof benchmarkArtifacts.$inferSelect;
export type NewBenchmarkArtifact = typeof benchmarkArtifacts.$inferInsert;
export type EvaluationDataset = typeof evaluationDatasets.$inferSelect;
export type NewEvaluationDataset = typeof evaluationDatasets.$inferInsert;
export type EvaluationDatasetRow = typeof evaluationDatasetRows.$inferSelect;
export type NewEvaluationDatasetRow =
	typeof evaluationDatasetRows.$inferInsert;
export type Evaluation = typeof evaluations.$inferSelect;
export type NewEvaluation = typeof evaluations.$inferInsert;
export type EvaluationGrader = typeof evaluationGraders.$inferSelect;
export type NewEvaluationGrader = typeof evaluationGraders.$inferInsert;
export type EvaluationRun = typeof evaluationRuns.$inferSelect;
export type NewEvaluationRun = typeof evaluationRuns.$inferInsert;
export type EvaluationRunItem = typeof evaluationRunItems.$inferSelect;
export type NewEvaluationRunItem = typeof evaluationRunItems.$inferInsert;
export type EvaluationArtifact = typeof evaluationArtifacts.$inferSelect;
export type NewEvaluationArtifact = typeof evaluationArtifacts.$inferInsert;
