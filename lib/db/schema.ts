import { relations } from "drizzle-orm";
import {
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	unique,
} from "drizzle-orm/pg-core";
import type { EncryptedObject } from "../security/encryption";
import {
	AppConnectionScope,
	AppConnectionStatus,
	type AppConnectionType,
} from "../types/app-connection";
import { generateId } from "../utils/id";

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
	// Nullable for backward-compat; new workflows should always set this.
	projectId: text("project_id").references(() => projects.id, {
		onDelete: "cascade",
	}),
	// biome-ignore lint/suspicious/noExplicitAny: JSONB type - structure validated at application level
	nodes: jsonb("nodes").notNull().$type<any[]>(),
	// biome-ignore lint/suspicious/noExplicitAny: JSONB type - structure validated at application level
	edges: jsonb("edges").notNull().$type<any[]>(),
	visibility: text("visibility")
		.notNull()
		.default("private")
		.$type<WorkflowVisibility>(),
	// Dapr workflow fields
	engineType: text("engine_type").default("dapr").$type<"vercel" | "dapr">(),
	daprWorkflowName: text("dapr_workflow_name"), // Registered Dapr workflow name
	daprOrchestratorUrl: text("dapr_orchestrator_url"), // URL of the Dapr orchestrator service
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
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		nameVersionPlatformIdx: index(
			"idx_piece_metadata_name_platform_id_version",
		).on(table.name, table.version, table.platformId),
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

// Workflow executions table to track workflow runs
export const workflowExecutions = pgTable("workflow_executions", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => generateId()),
	workflowId: text("workflow_id")
		.notNull()
		.references(() => workflows.id),
	userId: text("user_id")
		.notNull()
		.references(() => users.id),
	status: text("status")
		.notNull()
		.$type<"pending" | "running" | "success" | "error" | "cancelled">(),
	// biome-ignore lint/suspicious/noExplicitAny: JSONB type - structure validated at application level
	input: jsonb("input").$type<Record<string, any>>(),
	// biome-ignore lint/suspicious/noExplicitAny: JSONB type - structure validated at application level
	output: jsonb("output").$type<any>(),
	error: text("error"),
	// Dapr execution fields
	daprInstanceId: text("dapr_instance_id"), // Dapr workflow instance ID for correlation
	phase: text("phase"), // Current phase from Dapr custom status
	progress: integer("progress"), // 0-100 progress percentage
	startedAt: timestamp("started_at").notNull().defaultNow(),
	completedAt: timestamp("completed_at"),
	duration: text("duration"), // Duration in milliseconds
});

export type WorkflowPlanArtifactStatus =
	| "draft"
	| "approved"
	| "superseded"
	| "executed"
	| "failed";

export type WorkflowPlanArtifactType = "task_graph_v1";

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
			.default("task_graph_v1")
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

export type WorkflowWorkspaceSessionStatus = "active" | "cleaned" | "error";

/**
 * Durable workspace session metadata used by durable-agent to recover mappings
 * after pod restarts while Dapr workflows are still running.
 */
export const workflowWorkspaceSessions = pgTable(
	"workflow_workspace_sessions",
	{
		workspaceRef: text("workspace_ref").primaryKey(),
		workflowExecutionId: text("workflow_execution_id")
			.notNull()
			.references(() => workflowExecutions.id, { onDelete: "cascade" }),
		durableInstanceId: text("durable_instance_id"),
		name: text("name").notNull(),
		rootPath: text("root_path").notNull(),
		clonePath: text("clone_path"),
		backend: text("backend").notNull().$type<"k8s" | "local">(),
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
export const workflowExecutionLogs = pgTable("workflow_execution_logs", {
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
});

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

export type PromptMode = "system" | "system+user";

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
export type ResourcePrompt = typeof resourcePrompts.$inferSelect;
export type NewResourcePrompt = typeof resourcePrompts.$inferInsert;
export type ResourceSchema = typeof resourceSchemas.$inferSelect;
export type NewResourceSchema = typeof resourceSchemas.$inferInsert;
export type ResourceModelProfile = typeof resourceModelProfiles.$inferSelect;
export type NewResourceModelProfile = typeof resourceModelProfiles.$inferInsert;
export type WorkflowResourceRef = typeof workflowResourceRefs.$inferSelect;
export type NewWorkflowResourceRef = typeof workflowResourceRefs.$inferInsert;

// ============================================================================
// Agents (Persistent Agent Configurations)
// ============================================================================

export type AgentType =
	| "general"
	| "code-assistant"
	| "research"
	| "planning"
	| "custom";

/**
 * Model specification stored as JSONB.
 * Supports both simple string format ("openai/gpt-4o") and structured format.
 */
export type AgentModelSpec = {
	provider: string;
	name: string;
};

/**
 * Tool reference stored in the tools JSONB array.
 */
export type AgentToolRef = {
	type: "workspace" | "mcp" | "action";
	ref: string;
};

/**
 * Agents table — persistent agent configurations modeled on Mastra's StorageAgentType.
 * Users create agent configs in the UI; these are resolved at execution time and
 * passed to durable-agent via HTTP request body.
 */
export const agents = pgTable(
	"agents",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		name: text("name").notNull(),
		description: text("description"),
		agentType: text("agent_type")
			.notNull()
			.default("general")
			.$type<AgentType>(),
		instructions: text("instructions").notNull(),
		model: jsonb("model").notNull().$type<AgentModelSpec>(),
		tools: jsonb("tools").notNull().$type<AgentToolRef[]>().default([]),
		maxTurns: integer("max_turns").notNull().default(50),
		timeoutMinutes: integer("timeout_minutes").notNull().default(30),
		defaultOptions: jsonb("default_options").$type<Record<string, unknown>>(),
		memoryConfig: jsonb("memory_config").$type<Record<string, unknown>>(),
		metadata: jsonb("metadata").$type<Record<string, unknown>>(),
		isDefault: boolean("is_default").notNull().default(false),
		isEnabled: boolean("is_enabled").notNull().default(true),
		userId: text("user_id")
			.notNull()
			.references(() => users.id),
		projectId: text("project_id").references(() => projects.id, {
			onDelete: "cascade",
		}),
		instructionsPresetId: text("instructions_preset_id"),
		instructionsPresetVersion: integer("instructions_preset_version"),
		schemaPresetId: text("schema_preset_id"),
		schemaPresetVersion: integer("schema_preset_version"),
		modelProfileId: text("model_profile_id"),
		modelProfileVersion: integer("model_profile_version"),
		agentProfileTemplateId: text("agent_profile_template_id").references(
			() => agentProfileTemplates.id,
		),
		agentProfileTemplateVersion: integer("agent_profile_template_version"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		userIdx: index("idx_agents_user_id").on(table.userId),
		projectIdx: index("idx_agents_project_id").on(table.projectId),
		typeIdx: index("idx_agents_agent_type").on(table.agentType),
	}),
);

export const agentProfileAppliedHistory = pgTable(
	"agent_profile_applied_history",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId()),
		agentId: text("agent_id")
			.notNull()
			.references(() => agents.id, { onDelete: "cascade" }),
		templateId: text("template_id")
			.notNull()
			.references(() => agentProfileTemplates.id),
		templateVersion: integer("template_version").notNull(),
		appliedByUserId: text("applied_by_user_id")
			.notNull()
			.references(() => users.id),
		source: text("source").notNull().default("ui"),
		snapshot: jsonb("snapshot").$type<Record<string, unknown>>(),
		createdAt: timestamp("created_at").notNull().defaultNow(),
	},
	(table) => ({
		agentIdx: index("idx_agent_profile_applied_history_agent").on(
			table.agentId,
		),
		templateIdx: index("idx_agent_profile_applied_history_template").on(
			table.templateId,
		),
		createdIdx: index("idx_agent_profile_applied_history_created").on(
			table.createdAt,
		),
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
export type AgentProfileAppliedHistory =
	typeof agentProfileAppliedHistory.$inferSelect;
export type NewAgentProfileAppliedHistory =
	typeof agentProfileAppliedHistory.$inferInsert;
