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

// Relations
export const workflowExecutionsRelations = relations(
	workflowExecutions,
	({ one }) => ({
		workflow: one(workflows, {
			fields: [workflowExecutions.workflowId],
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
export type PieceMetadata = typeof pieceMetadata.$inferSelect;
export type NewPieceMetadata = typeof pieceMetadata.$inferInsert;
export type AppConnectionRecord = typeof appConnections.$inferSelect;
export type NewAppConnectionRecord = typeof appConnections.$inferInsert;
export type WorkflowConnectionRef = typeof workflowConnectionRefs.$inferSelect;
export type NewWorkflowConnectionRef =
	typeof workflowConnectionRefs.$inferInsert;
export type WorkflowAiMessage = typeof workflowAiMessages.$inferSelect;
export type NewWorkflowAiMessage = typeof workflowAiMessages.$inferInsert;
export type WorkflowExecution = typeof workflowExecutions.$inferSelect;
export type NewWorkflowExecution = typeof workflowExecutions.$inferInsert;
export type WorkflowExecutionLog = typeof workflowExecutionLogs.$inferSelect;
export type NewWorkflowExecutionLog = typeof workflowExecutionLogs.$inferInsert;
export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type PlatformOauthApp = typeof platformOauthApps.$inferSelect;
export type NewPlatformOauthApp = typeof platformOauthApps.$inferInsert;

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
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => ({
		userIdx: index("idx_agents_user_id").on(table.userId),
		projectIdx: index("idx_agents_project_id").on(table.projectId),
		typeIdx: index("idx_agents_agent_type").on(table.agentType),
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
