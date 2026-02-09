/**
 * Shared Logger Utility
 *
 * Provides structured logging with Dapr trace context correlation.
 * Dapr automatically propagates trace context via the `traceparent` header
 * following W3C Trace Context specification.
 *
 * This logger extracts trace IDs from Dapr-propagated headers to enable
 * log-trace correlation in Grafana/Loki without requiring full OTEL SDK.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type TraceContext = {
  traceId?: string;
  spanId?: string;
  traceFlags?: string;
};

export type LogEntry = {
  timestamp: string;
  level: LogLevel;
  message: string;
  service?: string;
  traceId?: string;
  spanId?: string;
  [key: string]: unknown;
};

/**
 * Extract trace context from Dapr-propagated W3C traceparent header.
 *
 * W3C Trace Context format:
 * traceparent: {version}-{trace-id}-{parent-id}-{trace-flags}
 * Example: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01
 *
 * @param headers - Request headers (can be object or Headers instance)
 * @returns Extracted trace context with traceId and spanId
 */
export function getTraceContext(
  headers: Record<string, string | string[] | undefined> | Headers
): TraceContext {
  // Handle both plain object and Headers instance
  let traceparent: string | undefined;

  if (headers instanceof Headers) {
    traceparent = headers.get("traceparent") ?? undefined;
  } else {
    const value = headers.traceparent ?? headers.Traceparent;
    traceparent = Array.isArray(value) ? value[0] : value;
  }

  if (!traceparent) {
    return {};
  }

  // Parse W3C Trace Context format: version-traceId-spanId-traceFlags
  const parts = traceparent.split("-");
  if (parts.length !== 4) {
    return {};
  }

  const [_version, traceId, spanId, traceFlags] = parts;

  return {
    traceId,
    spanId,
    traceFlags,
  };
}

/**
 * Create a structured log entry with optional trace context.
 */
function createLogEntry(
  level: LogLevel,
  message: string,
  context: Record<string, unknown> = {}
): LogEntry {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...context,
  };

  return entry;
}

/**
 * Log a structured message with optional trace context.
 *
 * @param level - Log level
 * @param message - Log message
 * @param context - Additional context (traceId, spanId, service, etc.)
 */
export function log(
  level: LogLevel,
  message: string,
  context: Record<string, unknown> = {}
): void {
  const entry = createLogEntry(level, message, context);
  const output = JSON.stringify(entry);

  switch (level) {
    case "debug":
      console.debug(output);
      break;
    case "info":
      console.info(output);
      break;
    case "warn":
      console.warn(output);
      break;
    case "error":
      console.error(output);
      break;
    default:
      console.log(output);
  }
}

/**
 * Create a logger instance bound to a specific service and optional trace context.
 *
 * @param service - Service name for log attribution
 * @param traceContext - Optional trace context from request headers
 * @returns Logger instance with bound context
 */
export function createLogger(service: string, traceContext?: TraceContext) {
  const baseContext: Record<string, unknown> = { service };

  if (traceContext?.traceId) {
    baseContext.traceId = traceContext.traceId;
  }
  if (traceContext?.spanId) {
    baseContext.spanId = traceContext.spanId;
  }

  return {
    debug: (message: string, context: Record<string, unknown> = {}) =>
      log("debug", message, { ...baseContext, ...context }),
    info: (message: string, context: Record<string, unknown> = {}) =>
      log("info", message, { ...baseContext, ...context }),
    warn: (message: string, context: Record<string, unknown> = {}) =>
      log("warn", message, { ...baseContext, ...context }),
    error: (message: string, context: Record<string, unknown> = {}) =>
      log("error", message, { ...baseContext, ...context }),
  };
}

/**
 * Create a logger from Fastify request headers.
 *
 * @param service - Service name
 * @param headers - Fastify request headers
 * @returns Logger with trace context extracted from headers
 */
export function createLoggerFromRequest(
  service: string,
  headers: Record<string, string | string[] | undefined>
) {
  const traceContext = getTraceContext(headers);
  return createLogger(service, traceContext);
}

/**
 * Timing utilities for performance tracking
 */
export type TimingEntry = {
  name: string;
  startMs: number;
  endMs?: number;
  durationMs?: number;
};

export class TimingTracker {
  private readonly entries: Map<string, TimingEntry> = new Map();
  private readonly startTime: number;

  constructor() {
    this.startTime = Date.now();
  }

  /**
   * Start timing a named operation
   */
  start(name: string): void {
    this.entries.set(name, {
      name,
      startMs: Date.now(),
    });
  }

  /**
   * End timing a named operation
   */
  end(name: string): number {
    const entry = this.entries.get(name);
    if (!entry) {
      return 0;
    }

    entry.endMs = Date.now();
    entry.durationMs = entry.endMs - entry.startMs;
    return entry.durationMs;
  }

  /**
   * Get duration for a specific operation
   */
  getDuration(name: string): number | undefined {
    return this.entries.get(name)?.durationMs;
  }

  /**
   * Get all timing entries as an object
   */
  getTimings(): Record<string, number | undefined> {
    const result: Record<string, number | undefined> = {};
    for (const [name, entry] of this.entries) {
      result[`${name}Ms`] = entry.durationMs;
    }
    return result;
  }

  /**
   * Get total elapsed time since tracker creation
   */
  getTotalDuration(): number {
    return Date.now() - this.startTime;
  }
}
