/**
 * OpenTelemetry setup for agent observability.
 * Mirrors Python dapr_agents/observability/.
 *
 * This is a lightweight setup — users can provide their own
 * TracerProvider/LoggerProvider for advanced configurations.
 */

import type { AgentObservabilityConfig } from "../config/observability-config.js";

/**
 * Initialize OpenTelemetry if the config enables it.
 * This is a no-op placeholder; users should configure OTel
 * in their application entry point using the standard
 * @opentelemetry/sdk-node package.
 */
export function initObservability(
  config: AgentObservabilityConfig | undefined,
  serviceName: string,
): void {
  if (!config?.enabled) return;

  const svcName = config.serviceName ?? serviceName;
  console.log(
    `[otel] Observability enabled for service '${svcName}'` +
      (config.endpoint ? ` endpoint=${config.endpoint}` : ""),
  );

  // Users should initialize OTel SDK themselves for full control.
  // This log serves as a reminder and verification that config is loaded.
}
