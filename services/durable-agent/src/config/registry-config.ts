/**
 * Agent registry configuration.
 * Mirrors Python AgentRegistryConfig.
 */
export interface AgentRegistryConfig {
  /** Dapr state store component name for the registry. */
  storeName: string;
  /** Team name for grouping agents. Defaults to "default". */
  teamName?: string;
}
