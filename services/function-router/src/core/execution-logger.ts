/**
 * Execution Logger
 *
 * Writes execution logs to the workflow_execution_logs table.
 * This allows the UI to display step-by-step execution details.
 */
import { getSql } from "./db.js";

export type ExecutionLogEntry = {
  executionId: string;
  nodeId: string;
  nodeName: string;
  nodeType: string;
  actionType?: string; // Function slug like "openai/generate-text"
  status: "pending" | "running" | "success" | "error";
  input?: unknown;
  output?: unknown;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
  durationMs?: number;
};

/**
 * Timing breakdown for detailed performance analysis
 */
export type TimingBreakdown = {
  credentialFetchMs?: number;
  routingMs?: number;
  coldStartMs?: number;
  executionMs?: number;
  routedTo?: string;
  wasColdStart?: boolean;
};

/**
 * Generate a random ID (similar to the app's generateId)
 */
function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 24; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Log the start of an execution (status = running)
 */
export async function logExecutionStart(
  entry: Omit<ExecutionLogEntry, "status">
): Promise<string> {
  const sql = getSql();
  const id = generateId();
  const startedAt = (entry.startedAt || new Date()).toISOString();

  try {
    await sql`
      INSERT INTO workflow_execution_logs (
        id, execution_id, node_id, node_name, node_type, activity_name,
        status, input, started_at, timestamp
      ) VALUES (
        ${id},
        ${entry.executionId},
        ${entry.nodeId},
        ${entry.nodeName},
        ${entry.nodeType},
        ${entry.actionType || null},
        'running',
        ${JSON.stringify(entry.input) || null},
        ${startedAt},
        ${startedAt}
      )
    `;
    console.log(
      `[Execution Logger] Started log ${id} for node ${entry.nodeName}`
    );
    return id;
  } catch (error) {
    console.error("[Execution Logger] Failed to log start:", error);
    // Don't throw - logging failure shouldn't break execution
    return id;
  }
}

/**
 * Update an existing log entry with completion details
 */
export async function logExecutionComplete(
  logId: string,
  result: {
    success: boolean;
    output?: unknown;
    error?: string;
    durationMs: number;
    timing?: TimingBreakdown;
  }
): Promise<void> {
  const sql = getSql();
  const completedAt = new Date().toISOString();
  const status = result.success ? "success" : "error";
  const timing = result.timing || {};

  try {
    await sql`
      UPDATE workflow_execution_logs
      SET
        status = ${status},
        output = ${result.output ? JSON.stringify(result.output) : null},
        error = ${result.error || null},
        completed_at = ${completedAt},
        duration = ${String(result.durationMs)},
        credential_fetch_ms = ${timing.credentialFetchMs ?? null},
        routing_ms = ${timing.routingMs ?? null},
        cold_start_ms = ${timing.coldStartMs ?? null},
        execution_ms = ${timing.executionMs ?? null},
        routed_to = ${timing.routedTo ?? null},
        was_cold_start = ${timing.wasColdStart ?? null}
      WHERE id = ${logId}
    `;
    console.log(
      `[Execution Logger] Completed log ${logId}: ${status}${timing.wasColdStart ? " (cold start)" : ""}`
    );
  } catch (error) {
    console.error("[Execution Logger] Failed to log completion:", error);
    // Don't throw - logging failure shouldn't break execution
  }
}

/**
 * Log a complete execution in one call (for simple cases)
 */
export async function logExecution(entry: ExecutionLogEntry): Promise<string> {
  const sql = getSql();
  const id = generateId();
  const now = new Date();

  try {
    await sql`
      INSERT INTO workflow_execution_logs (
        id, execution_id, node_id, node_name, node_type, activity_name,
        status, input, output, error, started_at, completed_at, duration, timestamp
      ) VALUES (
        ${id},
        ${entry.executionId},
        ${entry.nodeId},
        ${entry.nodeName},
        ${entry.nodeType},
        ${entry.actionType || null},
        ${entry.status},
        ${entry.input ? JSON.stringify(entry.input) : null},
        ${entry.output ? JSON.stringify(entry.output) : null},
        ${entry.error || null},
        ${entry.startedAt || now},
        ${entry.completedAt || (entry.status !== "pending" && entry.status !== "running" ? now : null)},
        ${entry.durationMs ? String(entry.durationMs) : null},
        ${now}
      )
    `;
    console.log(
      `[Execution Logger] Logged execution ${id} for node ${entry.nodeName}: ${entry.status}`
    );
    return id;
  } catch (error) {
    console.error("[Execution Logger] Failed to log execution:", error);
    // Don't throw - logging failure shouldn't break execution
    return id;
  }
}
