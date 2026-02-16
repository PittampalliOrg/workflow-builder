/**
 * State persistence configuration.
 * Mirrors Python AgentStateConfig.
 */
export interface AgentStateConfig {
  /** Dapr state store component name. */
  storeName: string;
  /** Key used to persist workflow state. Defaults to `{agentName}:workflow_state`. */
  stateKey?: string;
}
