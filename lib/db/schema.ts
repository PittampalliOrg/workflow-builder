import { relations } from "drizzle-orm";
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { IntegrationType } from "../types/integration";
import { generateId } from "../utils/id";

// Better Auth tables
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
  // Anonymous user tracking
  isAnonymous: boolean("is_anonymous").default(false),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
});

export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const verifications = pgTable("verifications", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
});

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

// Integrations table for storing user credentials
export const integrations = pgTable("integrations", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => generateId()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  type: text("type").notNull().$type<IntegrationType>(),
  // biome-ignore lint/suspicious/noExplicitAny: JSONB type - encrypted credentials stored as JSON
  config: jsonb("config").notNull().$type<any>(),
  // Whether this integration was created via OAuth (managed by app) vs manual entry
  isManaged: boolean("is_managed").default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

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
  activityName: text("activity_name"), // Dapr activity function name
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
});

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
  })
);

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Workflow = typeof workflows.$inferSelect;
export type NewWorkflow = typeof workflows.$inferInsert;
export type Integration = typeof integrations.$inferSelect;
export type NewIntegration = typeof integrations.$inferInsert;
export type WorkflowExecution = typeof workflowExecutions.$inferSelect;
export type NewWorkflowExecution = typeof workflowExecutions.$inferInsert;
export type WorkflowExecutionLog = typeof workflowExecutionLogs.$inferSelect;
export type NewWorkflowExecutionLog = typeof workflowExecutionLogs.$inferInsert;
export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;

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
export interface RetryPolicy {
  maxAttempts?: number;
  initialDelaySeconds?: number;
  maxDelaySeconds?: number;
  backoffMultiplier?: number;
}

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
    () => workflowExecutions.id
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
  })
);

// Export types for functions
export type Function = typeof functions.$inferSelect;
export type NewFunction = typeof functions.$inferInsert;
export type FunctionExecution = typeof functionExecutions.$inferSelect;
export type NewFunctionExecution = typeof functionExecutions.$inferInsert;
