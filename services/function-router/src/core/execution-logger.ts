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

const SENSITIVE_KEY_PATTERN =
  /(api[_-]?key|access[_-]?token|auth|authorization|bearer|client[_-]?secret|credential|password|secret|token)/i;
const REDACTED = "[REDACTED]";

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

export function sanitizeExecutionLogValue(value: unknown): unknown {
  return sanitizeValue(value, new WeakSet<object>());
}

function sanitizeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      out[key] = REDACTED;
    } else {
      out[key] = sanitizeValue(child, seen);
    }
  }
  return out;
}

function redactSensitiveText(value: string): string {
  let text = value;
  text = text.replace(
    /\b([A-Z0-9_]*(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH|AUTHORIZATION|BEARER|CLIENT[_-]?SECRET|CREDENTIAL|PASSWORD|SECRET|TOKEN)[A-Z0-9_]*)\s*=\s*(['"]?)([^\s'";&|]+)/gi,
    (_match, name: string, quote: string) => `${name}=${quote}${REDACTED}`,
  );
  text = text.replace(
    /\b(authorization|x-api-key|api-key)\s*:\s*([^\r\n]+)/gi,
    (_match, name: string) => `${name}: ${REDACTED}`,
  );
  text = text.replace(
    /\b(bearer)\s+[A-Za-z0-9._~+/=-]+/gi,
    (_match, name: string) => `${name} ${REDACTED}`,
  );
  text = text.replace(
    /https?:\/\/[^\s'"<>]+/gi,
    (rawUrl) => redactSensitiveUrl(rawUrl),
  );
  return text;
}

function redactSensitiveUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username || parsed.password) {
      parsed.username = REDACTED;
      parsed.password = "";
    }
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        parsed.searchParams.set(key, REDACTED);
      }
    }
    return parsed.toString();
  } catch {
    return rawUrl.replace(
      /([?&][^=\s&]*(?:key|token|password|secret|auth)[^=\s&]*=)([^&\s]+)/gi,
      `$1${REDACTED}`,
    );
  }
}

function stringifyForLog(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(sanitizeExecutionLogValue(value));
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
        ${stringifyForLog(entry.input)},
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
        output = ${stringifyForLog(result.output)},
        error = ${typeof result.error === "string" ? redactSensitiveText(result.error) : null},
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
        ${stringifyForLog(entry.input)},
        ${stringifyForLog(entry.output)},
        ${typeof entry.error === "string" ? redactSensitiveText(entry.error) : null},
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
