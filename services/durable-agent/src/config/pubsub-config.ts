/**
 * Pub/Sub configuration for agent communication.
 * Mirrors Python AgentPubSubConfig.
 */
export interface AgentPubSubConfig {
  /** Dapr pub/sub component name. */
  pubsubName: string;
  /** Per-agent topic for direct messages. Defaults to agent name. */
  agentTopic?: string;
  /** Shared topic for team broadcasts. */
  broadcastTopic?: string;
}
