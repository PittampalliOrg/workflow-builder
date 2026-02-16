/**
 * Observability configuration.
 * Mirrors Python AgentObservabilityConfig.
 */
export interface AgentObservabilityConfig {
  /** Enable/disable observability. */
  enabled?: boolean;
  /** OTLP endpoint URL. */
  endpoint?: string;
  /** Service name for traces/logs. */
  serviceName?: string;
  /** Enable tracing. */
  tracingEnabled?: boolean;
  /** Enable logging export. */
  loggingEnabled?: boolean;
}
